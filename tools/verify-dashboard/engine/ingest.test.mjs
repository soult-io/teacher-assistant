import { describe, expect, it } from "vitest";
import { buildJourneys, parseEvidence } from "./ingest.mjs";

const PROVENANCE = { ci_run_id: "999", commit_sha: "deadbeef", workflow: "e2e", job: "e2e" };
// A resolver that just echoes a deterministic served path, so ingest is tested
// without touching the filesystem.
const echoResolver = (_raw, kind, id, engine) => `${kind}/${id}-${engine}.bin`;

function record(over = {}) {
  return {
    file: "/repo/e2e/tests/j1-score-probe.spec.ts",
    title: "owed goal → Save",
    line: 13,
    project: "chromium",
    status: "passed",
    outcome: "expected",
    durationMs: 600,
    retries: 0,
    attachments: [
      { name: "video", contentType: "video/webm", path: "/ci/test-results/j1-chromium/video.webm" },
      {
        name: "trace",
        contentType: "application/zip",
        path: "/ci/test-results/j1-chromium/trace.zip",
      },
    ],
    steps: [
      { label: "Open the dashboard", assertions: [{ text: "owe-count is 2", status: "passed" }] },
    ],
    ...over,
  };
}

describe("parseEvidence (loud-fail discipline)", () => {
  it("throws on unparseable JSON", () => {
    expect(() => parseEvidence("{not json")).toThrow(/not valid JSON/);
  });
  it("throws on a schema mismatch", () => {
    expect(() => parseEvidence(JSON.stringify({ schema: "other/9", tests: [] }))).toThrow(
      /schema mismatch/,
    );
  });
  it("throws when tests is not an array", () => {
    expect(() => parseEvidence(JSON.stringify({ schema: "journey-evidence/1" }))).toThrow(
      /no tests array/,
    );
  });
  it("accepts a well-formed file", () => {
    const ev = parseEvidence(JSON.stringify({ schema: "journey-evidence/1", tests: [] }));
    expect(ev.tests).toEqual([]);
  });
});

describe("buildJourneys", () => {
  const manifest = [
    { id: "J1", name: "Score a probe", match: { file: "j1-score-probe.spec.ts" } },
    { id: "JX", name: "Not yet run", match: { file: "nope.spec.ts" } },
  ];

  it("maps a test across browsers into one journey with per-browser results", () => {
    const evidence = {
      schema: "journey-evidence/1",
      tests: [record(), record({ project: "firefox", durationMs: 720 })],
    };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "teacher-assistant",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(j1.id).toBe("J1");
    expect(j1.status).toBe("passed");
    expect(j1.browsers).toEqual([
      { engine: "chromium", status: "passed", duration_ms: 600, retries: 0 },
      { engine: "firefox", status: "passed", duration_ms: 720, retries: 0 },
    ]);
    expect(j1.duration_ms).toBe(720); // max across browsers
    expect(j1.run).toBe(PROVENANCE);
    // canonical = chromium; video/trace resolved to served paths
    expect(j1.video).toEqual({ src: "video/J1-chromium.bin", poster: null, duration_ms: 600 });
    expect(j1.trace_url).toBe("trace/J1-chromium.bin");
    expect(j1.steps).toHaveLength(1);
    expect(j1.steps[0]).toMatchObject({
      index: 0,
      label: "Open the dashboard",
      status: "passed",
      assertions: [{ text: "owe-count is 2", status: "passed", actual: null }],
    });
  });

  it("carries step status + time offset + assertion actual through ingest", () => {
    const evidence = {
      schema: "journey-evidence/1",
      tests: [
        record({
          steps: [
            {
              label: "Submit the score",
              status: "failed",
              startOffsetMs: 1400,
              assertions: [
                { text: "saved toast shows", status: "failed", detail: "expected visible" },
              ],
            },
          ],
        }),
      ],
    };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "p",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(j1.steps[0]).toMatchObject({
      label: "Submit the score",
      status: "failed",
      t_start_ms: 1400,
      screen: null,
      assertions: [{ text: "saved toast shows", status: "failed", actual: "expected visible" }],
    });
  });

  it("defaults t_start_ms to null when the evidence carries no step offset (pre-3b run)", () => {
    const evidence = {
      schema: "journey-evidence/1",
      tests: [record({ steps: [{ label: "Open", assertions: [] }] })],
    };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "p",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(j1.steps[0].t_start_ms).toBeNull();
    expect(j1.steps[0].status).toBe("passed");
  });

  it("carries per-browser retry count (for the flaky 'passed on retry N' badge)", () => {
    const evidence = {
      schema: "journey-evidence/1",
      tests: [record({ outcome: "flaky", retries: 2 })],
    };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "p",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(j1.status).toBe("flaky");
    expect(j1.browsers[0].retries).toBe(2);
  });

  it("renders a manifest entry with no matching test as UNVERIFIED", () => {
    const evidence = { schema: "journey-evidence/1", tests: [record()] };
    const [, jx] = buildJourneys({
      evidence,
      manifest,
      product: "teacher-assistant",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(jx.id).toBe("JX");
    expect(jx.status).toBe("unverified");
    expect(jx.run).toBeNull();
    expect(jx.browsers).toEqual([]);
  });

  it("one failing browser makes the whole journey failed", () => {
    const evidence = {
      schema: "journey-evidence/1",
      tests: [record(), record({ project: "firefox", status: "failed", outcome: "unexpected" })],
    };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "p",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(j1.status).toBe("failed");
  });

  it("shows the FAILING browser's video + steps under a failed badge (canonical-trap fix)", () => {
    // chromium passes, firefox fails → the card is failed. The canonical video/steps
    // must come from firefox (the failing run), not the passing chromium sibling —
    // otherwise a red badge would sit over a green video.
    const evidence = {
      schema: "journey-evidence/1",
      tests: [
        record({ steps: [{ label: "chromium OK", status: "passed", assertions: [] }] }),
        record({
          project: "firefox",
          status: "failed",
          outcome: "unexpected",
          steps: [{ label: "firefox broke here", status: "failed", assertions: [] }],
        }),
      ],
    };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "p",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(j1.status).toBe("failed");
    expect(j1.video.src).toBe("video/J1-firefox.bin");
    expect(j1.trace_url).toBe("trace/J1-firefox.bin");
    expect(j1.steps[0].label).toBe("firefox broke here");
    expect(j1.steps[0].status).toBe("failed");
  });

  it("prefers chromium when both browsers share the journey's status", () => {
    const evidence = {
      schema: "journey-evidence/1",
      tests: [record(), record({ project: "firefox" })],
    };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "p",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(j1.status).toBe("passed");
    expect(j1.video.src).toBe("video/J1-chromium.bin");
  });

  it("disambiguates two tests in one file by title", () => {
    const evidence = {
      schema: "journey-evidence/1",
      tests: [
        record({ file: "/r/j5-new-goal-baseline.spec.ts", title: "ADOPT: baseline mandatory" }),
        record({ file: "/r/j5-new-goal-baseline.spec.ts", title: "DRAFT: unreachable by export" }),
      ],
    };
    const j5manifest = [
      { id: "J5", name: "Adopt", match: { file: "j5-new-goal-baseline.spec.ts", title: "ADOPT" } },
      {
        id: "J5-draft",
        name: "Draft",
        match: { file: "j5-new-goal-baseline.spec.ts", title: "DRAFT" },
      },
    ];
    const journeys = buildJourneys({
      evidence,
      manifest: j5manifest,
      product: "p",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(journeys.map((j) => j.id)).toEqual(["J5", "J5-draft"]);
    expect(journeys[0].steps).toHaveLength(1);
    expect(journeys.every((j) => j.status === "passed")).toBe(true);
  });

  it("forces every journey UNVERIFIED when provenance has no run id, even with evidence", () => {
    const evidence = { schema: "journey-evidence/1", tests: [record()] };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "p",
      provenance: { ci_run_id: null }, // no real run to bind to
      resolveAsset: echoResolver,
    });
    expect(j1.status).toBe("unverified");
    expect(j1.run).toBeNull();
  });

  it("fails loud when a file-only entry matches more than one distinct test", () => {
    const evidence = {
      schema: "journey-evidence/1",
      tests: [
        record({ file: "/r/j5-new-goal-baseline.spec.ts", title: "ADOPT: baseline mandatory" }),
        record({ file: "/r/j5-new-goal-baseline.spec.ts", title: "DRAFT: unreachable by export" }),
      ],
    };
    const ambiguous = [
      { id: "J5", name: "New goal", match: { file: "j5-new-goal-baseline.spec.ts" } },
    ];
    expect(() =>
      buildJourneys({
        evidence,
        manifest: ambiguous,
        product: "p",
        provenance: PROVENANCE,
        resolveAsset: echoResolver,
      }),
    ).toThrow(/matched 2 tests/);
  });

  it("survives a journey with no attachments (null video/trace)", () => {
    const evidence = { schema: "journey-evidence/1", tests: [record({ attachments: [] })] };
    const [j1] = buildJourneys({
      evidence,
      manifest,
      product: "p",
      provenance: PROVENANCE,
      resolveAsset: echoResolver,
    });
    expect(j1.video).toBeNull();
    expect(j1.trace_url).toBeNull();
  });
});
