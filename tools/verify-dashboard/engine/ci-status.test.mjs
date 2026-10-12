import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCiPills } from "./ci-status.mjs";

// Route a stubbed fetch by URL: workflow-runs list → the given runs; run jobs → the
// given jobs. Lets us exercise the run selection, conclusionOf/worstOf/jobMatches
// through the public API without a network.
function stubFetch(routes) {
  return vi.fn(async (url) => {
    for (const [needle, body] of routes) {
      if (url.includes(needle)) return { ok: true, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REPO = "o/r";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

/** A run of SHA, push-triggered, from REPO itself — override fields per test. */
function run(overrides = {}) {
  return {
    id: 111,
    head_sha: SHA,
    event: "push",
    head_repository: { full_name: REPO },
    created_at: "2026-09-24T10:00:00Z",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

const PILL_SPECS = [
  {
    workflow: "ci.yml",
    jobs: [
      { label: "verify", equals: "verify" },
      { label: "build-images ×4", startsWith: "build-images" },
    ],
  },
  { workflow: "ferpa-guard.yml", label: "ferpa-guard" },
];

const GREEN_JOBS = {
  jobs: [
    { name: "verify", status: "completed", conclusion: "success" },
    { name: "build-images (pwa)", status: "completed", conclusion: "success" },
  ],
};

describe("collectCiPills", () => {
  it("splits a workflow into job pills; one failed matrix job makes its pill red", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch([
        ["workflows/ci.yml/runs", { workflow_runs: [run({ id: 111 })] }],
        [
          "runs/111/jobs",
          {
            jobs: [
              { name: "verify", status: "completed", conclusion: "success" },
              { name: "build-images (pwa)", status: "completed", conclusion: "success" },
              { name: "build-images (sync-relay)", status: "completed", conclusion: "failure" },
            ],
          },
        ],
        ["workflows/ferpa-guard.yml/runs", { workflow_runs: [run({ id: 900 })] }],
      ]),
    );
    const pills = await collectCiPills(REPO, "tok", PILL_SPECS, SHA);
    expect(pills).toEqual([
      { label: "verify", conclusion: "success" },
      { label: "build-images ×4", conclusion: "failure" }, // worst wins
      { label: "ferpa-guard", conclusion: "success" },
    ]);
  });

  it("queries runs by the full sha, push event and main — never an unfiltered latest", async () => {
    const fetchSpy = stubFetch([
      ["workflows/ci.yml/runs", { workflow_runs: [run()] }],
      ["runs/111/jobs", GREEN_JOBS],
      ["workflows/ferpa-guard.yml/runs", { workflow_runs: [run({ id: 900 })] }],
    ]);
    vi.stubGlobal("fetch", fetchSpy);
    await collectCiPills(REPO, "tok", PILL_SPECS, SHA);
    const runUrls = fetchSpy.mock.calls.map(([u]) => u).filter((u) => u.includes("/runs?"));
    expect(runUrls).toHaveLength(2);
    for (const u of runUrls) {
      const q = new URL(u).searchParams;
      expect(q.get("head_sha")).toBe(SHA);
      expect(q.get("event")).toBe("push");
      expect(q.get("branch")).toBe("main");
    }
  });

  it("treats an in-flight run as in_progress and a timed_out run as failure", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch([
        ["workflows/ci.yml/runs", { workflow_runs: [run({ id: 222, status: "in_progress" })] }],
        [
          "runs/222/jobs",
          {
            jobs: [
              { name: "verify", status: "in_progress" },
              { name: "build-images (pwa)", status: "completed", conclusion: "timed_out" },
            ],
          },
        ],
        ["workflows/ferpa-guard.yml/runs", { workflow_runs: [run({ status: "queued" })] }],
      ]),
    );
    const pills = await collectCiPills(REPO, "tok", PILL_SPECS, SHA);
    expect(pills).toEqual([
      { label: "verify", conclusion: "in_progress" },
      { label: "build-images ×4", conclusion: "failure" },
      { label: "ferpa-guard", conclusion: "in_progress" },
    ]);
  });

  it("reports a finished-but-skipped/cancelled matrix as that neutral result, not in progress", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch([
        ["workflows/ci.yml/runs", { workflow_runs: [run({ id: 333, conclusion: "failure" })] }],
        [
          "runs/333/jobs",
          {
            jobs: [
              // verify failed, so the `needs: [verify]` matrix was skipped.
              { name: "verify", status: "completed", conclusion: "cancelled" },
              { name: "build-images (pwa)", status: "completed", conclusion: "skipped" },
              { name: "build-images (sync-relay)", status: "completed", conclusion: "skipped" },
            ],
          },
        ],
        ["workflows/ferpa-guard.yml/runs", { workflow_runs: [run({ id: 900 })] }],
      ]),
    );
    const pills = await collectCiPills(REPO, "tok", PILL_SPECS, SHA);
    expect(pills.slice(0, 2)).toEqual([
      { label: "verify", conclusion: "cancelled" },
      { label: "build-images ×4", conclusion: "skipped" },
    ]);
  });

  it("orders a mixed matrix: failure over in-progress over a finished non-verdict", async () => {
    const jobs = (...cs) =>
      cs.map((c, i) =>
        c === "in_progress"
          ? { name: `build-images (${i})`, status: "in_progress" }
          : { name: `build-images (${i})`, status: "completed", conclusion: c },
      );
    const cases = [
      [["success", "skipped", "failure", "in_progress"], "failure"],
      [["success", "skipped", "in_progress"], "in_progress"],
      [["success", "skipped"], "skipped"],
      [["success", "success"], "success"],
      [[], "unknown"], // run found, no job matched the spec
    ];
    for (const [cs, expected] of cases) {
      vi.stubGlobal(
        "fetch",
        stubFetch([
          ["workflows/ci.yml/runs", { workflow_runs: [run({ id: 444 })] }],
          ["runs/444/jobs", { jobs: jobs(...cs) }],
        ]),
      );
      const pills = await collectCiPills(REPO, "tok", [PILL_SPECS[0]], SHA);
      expect(pills[1], cs.join(",")).toEqual({ label: "build-images ×4", conclusion: expected });
    }
  });

  describe("binding to the commit (client-side re-check of every candidate)", () => {
    // Each case: the API returns ONLY a non-matching run (as if a filter were ignored).
    // It must be rejected → "no run for this commit", never shown as that run's verdict.
    const rejected = [
      ["another commit's run", run({ head_sha: OTHER_SHA, conclusion: "failure" })],
      ["a fork's run (head_repository differs)", run({ head_repository: { full_name: "evil/r" } })],
      ["a run with no head_repository", run({ head_repository: null })],
      ["a pull_request run", run({ event: "pull_request" })],
      ["a workflow_dispatch run", run({ event: "workflow_dispatch" })],
    ];
    for (const [what, candidate] of rejected) {
      it(`rejects ${what}`, async () => {
        vi.stubGlobal(
          "fetch",
          stubFetch([["workflows/ferpa-guard.yml/runs", { workflow_runs: [candidate] }]]),
        );
        const pills = await collectCiPills(REPO, "tok", [PILL_SPECS[1]], SHA);
        expect(pills).toEqual([{ label: "ferpa-guard", conclusion: "no_run" }]);
      });
    }

    it("picks the matching run out of a mixed list, ignoring the non-matching ones", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch([
          [
            "workflows/ferpa-guard.yml/runs",
            {
              workflow_runs: [
                run({ id: 5, head_sha: OTHER_SHA, created_at: "2026-09-24T12:00:00Z" }),
                run({ id: 4, event: "pull_request", created_at: "2026-09-24T11:00:00Z" }),
                run({ id: 3, conclusion: "failure", created_at: "2026-09-24T09:00:00Z" }),
              ],
            },
          ],
        ]),
      );
      const pills = await collectCiPills(REPO, "tok", [PILL_SPECS[1]], SHA);
      expect(pills).toEqual([{ label: "ferpa-guard", conclusion: "failure" }]);
    });

    it("takes the newest matching run by created_at when several runs match", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch([
          [
            "workflows/ferpa-guard.yml/runs",
            {
              workflow_runs: [
                run({ id: 10, conclusion: "failure", created_at: "2026-09-24T09:00:00Z" }),
                run({ id: 11, conclusion: "success", created_at: "2026-09-24T10:00:00Z" }),
              ],
            },
          ],
        ]),
      );
      const pills = await collectCiPills(REPO, "tok", [PILL_SPECS[1]], SHA);
      expect(pills).toEqual([{ label: "ferpa-guard", conclusion: "success" }]);
    });

    it("matches the repo name case-insensitively (GitHub names are)", async () => {
      vi.stubGlobal(
        "fetch",
        stubFetch([
          [
            "workflows/ferpa-guard.yml/runs",
            { workflow_runs: [run({ head_repository: { full_name: "O/R" } })] },
          ],
        ]),
      );
      const pills = await collectCiPills(REPO, "tok", [PILL_SPECS[1]], SHA);
      expect(pills).toEqual([{ label: "ferpa-guard", conclusion: "success" }]);
    });
  });

  it("no run for the commit → no_run on every pill of that spec, and no jobs fetch", async () => {
    const fetchSpy = stubFetch([
      ["workflows/ci.yml/runs", { workflow_runs: [] }],
      ["workflows/ferpa-guard.yml/runs", { workflow_runs: [run({ id: 900 })] }],
    ]);
    vi.stubGlobal("fetch", fetchSpy);
    const pills = await collectCiPills(REPO, "tok", PILL_SPECS, SHA);
    expect(pills).toEqual([
      { label: "verify", conclusion: "no_run" },
      { label: "build-images ×4", conclusion: "no_run" },
      { label: "ferpa-guard", conclusion: "success" },
    ]);
    expect(fetchSpy.mock.calls.some(([u]) => u.includes("/jobs"))).toBe(false);
  });

  it("reads jobs-split pills from the matched run only (not another commit's run)", async () => {
    const fetchSpy = stubFetch([
      [
        "workflows/ci.yml/runs",
        {
          workflow_runs: [
            // A later commit's run listed first: its red jobs must not leak in.
            run({ id: 999, head_sha: OTHER_SHA, created_at: "2026-09-24T12:00:00Z" }),
            run({ id: 111 }),
          ],
        },
      ],
      ["runs/999/jobs", { jobs: [{ name: "verify", status: "completed", conclusion: "failure" }] }],
      ["runs/111/jobs", GREEN_JOBS],
      ["workflows/ferpa-guard.yml/runs", { workflow_runs: [run({ id: 900 })] }],
    ]);
    vi.stubGlobal("fetch", fetchSpy);
    const pills = await collectCiPills(REPO, "tok", PILL_SPECS, SHA);
    expect(pills.slice(0, 2)).toEqual([
      { label: "verify", conclusion: "success" },
      { label: "build-images ×4", conclusion: "success" },
    ]);
    const jobUrls = fetchSpy.mock.calls.map(([u]) => u).filter((u) => u.includes("/jobs"));
    expect(jobUrls).toHaveLength(1);
    expect(jobUrls[0]).toContain("/runs/111/jobs");
  });

  it("degrades every pill to unknown when the API errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const pills = await collectCiPills(REPO, "tok", PILL_SPECS, SHA);
    expect(pills).toEqual([
      { label: "verify", conclusion: "unknown" },
      { label: "build-images ×4", conclusion: "unknown" },
      { label: "ferpa-guard", conclusion: "unknown" },
    ]);
  });

  it("degrades to unknown (not no_run) on a non-OK API response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", stubFetch([])); // every URL → 404
    const pills = await collectCiPills(REPO, "tok", [PILL_SPECS[1]], SHA);
    expect(pills).toEqual([{ label: "ferpa-guard", conclusion: "unknown" }]);
  });

  it("returns the fallback pills (no fetch) when repo is missing", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const pills = await collectCiPills("", "tok", PILL_SPECS, SHA);
    expect(pills.map((p) => p.label)).toEqual(["verify", "build-images ×4", "ferpa-guard"]);
    expect(pills.every((p) => p.conclusion === "unknown")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  for (const [what, sha] of [
    ["missing", undefined],
    ["a short sha", "aaaaaaa"],
    ["not hex", "z".repeat(40)],
  ]) {
    it(`returns the unknown fallback (no fetch) when the sha is ${what}`, async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const spy = vi.fn();
      vi.stubGlobal("fetch", spy);
      const pills = await collectCiPills(REPO, "tok", PILL_SPECS, sha);
      expect(pills.every((p) => p.conclusion === "unknown")).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });
  }
});
