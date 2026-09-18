import { describe, expect, it } from "vitest";
import { renderJourneyCard, renderJourneyList } from "./journeys.mjs";

const passed = {
  id: "J1",
  name: "Score a probe",
  product: "p",
  status: "passed",
  browsers: [
    { engine: "chromium", status: "passed", duration_ms: 600, retries: 0 },
    { engine: "firefox", status: "passed", duration_ms: 700, retries: 0 },
  ],
  duration_ms: 4200,
  run: {
    ci_run_id: "999",
    ci_run_url: "https://github.com/o/r/actions/runs/999",
    commit_sha: "deadbeefcafe",
    workflow: "e2e",
    job: "e2e",
    generated_at: "2026-09-18T18:19:55Z",
    artifact_digest: "abcdef0123456789",
  },
  video: { src: "videos/J1-chromium.webm", poster: null, duration_ms: 4000 },
  trace_url: "traces/J1-chromium.zip",
  steps: [
    {
      index: 0,
      label: "Open the dashboard",
      status: "passed",
      screen: null,
      t_start_ms: 0,
      thumbnail: null,
      assertions: [
        { text: "owe-count is 2", status: "passed", actual: null },
        { text: "header shows owed-first", status: "passed", actual: null },
      ],
    },
    {
      index: 1,
      label: "Tap Save",
      status: "passed",
      screen: null,
      t_start_ms: 2000,
      thumbnail: null,
      assertions: [{ text: "toast: saved", status: "passed", actual: null }],
    },
  ],
};

describe("renderJourneyCard — verified pass", () => {
  const html = renderJourneyCard(passed);
  it("shows the name, a passed badge, and total duration", () => {
    expect(html).toContain("<h3>Score a probe</h3>");
    expect(html).toContain('<span class="jbadge pass">passed</span>');
    expect(html).toContain("j-passed");
    expect(html).toContain('class="jdur mono">4.2s<');
  });
  it("renders a provenance bar: run link, short sha (full on hover), workflow/job, ts, digest, trace", () => {
    expect(html).toContain('href="https://github.com/o/r/actions/runs/999"');
    expect(html).toContain("run #999");
    expect(html).toContain("deadbee"); // 7-char short sha
    expect(html).toContain('title="deadbeefcafe"'); // full sha on hover
    expect(html).toContain("e2e / e2e");
    expect(html).toContain("2026-09-18T18:19:55Z");
    expect(html).toContain("sha256:abcdef012345…");
  });
  it("embeds the run video and a trace link", () => {
    expect(html).toContain("data-video controls");
    expect(html).toContain('src="videos/J1-chromium.webm"');
  });
  it("renders a chip per browser", () => {
    expect(html).toContain('class="chip pass"');
    expect(html).toContain("chromium");
    expect(html).toContain("firefox");
  });
  it("renders the ordered steps with ticked assertions, seekable by offset", () => {
    expect(html).toContain("Open the dashboard");
    expect(html).toContain("Tap Save");
    expect(html).toContain("owe-count is 2");
    expect(html).toContain("✓");
    expect(html).toContain('data-seek="0"');
    expect(html).toContain('data-seek="2000"');
    expect(html).toContain('data-step="1"');
  });
  it("places a marker per timed step on the rail", () => {
    expect(html).toContain('class="jrail"');
    expect(html).toContain("jmark"); // markers rendered
  });
  it("does not auto-seek (no failing step)", () => {
    expect(html).not.toContain("data-fail-seek");
  });
});

describe("renderJourneyCard — failed", () => {
  const failed = {
    ...passed,
    status: "failed",
    browsers: [{ engine: "firefox", status: "failed", duration_ms: 10, retries: 0 }],
    steps: [
      {
        index: 0,
        label: "Submit the score",
        status: "failed",
        screen: null,
        t_start_ms: 1500,
        thumbnail: null,
        assertions: [{ text: "saved toast is visible", status: "failed", actual: "not found" }],
      },
    ],
  };
  const html = renderJourneyCard(failed);
  it("marks the card and badge red with a red chip", () => {
    expect(html).toContain("j-failed");
    expect(html).toContain('<span class="jbadge fail">failed</span>');
    expect(html).toContain('class="chip fail"');
  });
  it("red-outlines the failing step and strikes the assertion against its actual", () => {
    expect(html).toContain('class="jstep fail"');
    expect(html).toContain("<s>saved toast is visible</s>");
    expect(html).toContain("not found");
    expect(html).toContain("✗");
  });
  it("auto-seeks the video to the failing step on load", () => {
    expect(html).toContain('data-fail-seek="1500"');
  });
});

describe("renderJourneyCard — flaky", () => {
  it("shows an amber badge that names the passing retry", () => {
    const html = renderJourneyCard({
      ...passed,
      status: "flaky",
      browsers: [{ engine: "chromium", status: "flaky", duration_ms: 600, retries: 2 }],
    });
    expect(html).toContain("j-flaky");
    expect(html).toContain('<span class="jbadge warn">flaky · passed on retry 2</span>');
  });
});

describe("renderJourneyCard — unverified", () => {
  const html = renderJourneyCard({
    id: "J9",
    name: "Future journey",
    product: "p",
    status: "unverified",
    browsers: [],
    duration_ms: null,
    run: null,
    video: null,
    trace_url: null,
    steps: [],
  });
  it("is dashed, cannot show a pass badge, and has no provenance bar", () => {
    expect(html).toContain("unverified");
    expect(html).toContain('<span class="jbadge unver">unverified</span>');
    expect(html).not.toContain("jbadge pass");
    expect(html).not.toContain("jprov");
  });
  it("greys the video area and shows no video element (cannot look like a pass)", () => {
    expect(html).toContain("UNVERIFIED — no run");
    expect(html).not.toContain("data-video");
    expect(html).not.toContain("data-fail-seek");
  });
});

describe("renderJourneyCard — pre-3b evidence (no step offsets)", () => {
  it("renders steps without a marker rail or seek handles", () => {
    const html = renderJourneyCard({
      ...passed,
      steps: [
        {
          index: 0,
          label: "Open",
          status: "passed",
          screen: null,
          t_start_ms: null,
          thumbnail: null,
          assertions: [],
        },
      ],
    });
    expect(html).toContain("Open");
    expect(html).not.toContain("jrail");
    expect(html).not.toContain("data-seek");
  });
});

describe("renderJourneyList", () => {
  it("renders one card per journey", () => {
    const html = renderJourneyList([passed, { ...passed, id: "J2", name: "Second" }]);
    expect(html).toContain("Score a probe");
    expect(html).toContain("Second");
    expect(html).toContain('class="jlist"');
  });
  it("handles an empty list", () => {
    expect(renderJourneyList([])).toContain("No journeys configured");
  });
});
