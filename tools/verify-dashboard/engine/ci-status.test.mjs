import { afterEach, describe, expect, it, vi } from "vitest";
import { collectCiPills } from "./ci-status.mjs";

// Route a stubbed fetch by URL: workflow-runs list → the given run; run jobs → the
// given jobs. Lets us exercise conclusionOf/worstOf/jobMatches through the public API
// without a network.
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
});

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

describe("collectCiPills", () => {
  it("splits a workflow into job pills; one failed matrix job makes its pill red", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch([
        ["workflows/ci.yml/runs", { workflow_runs: [{ id: 111 }] }],
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
        [
          "workflows/ferpa-guard.yml/runs",
          { workflow_runs: [{ status: "completed", conclusion: "success" }] },
        ],
      ]),
    );
    const pills = await collectCiPills("o/r", "tok", PILL_SPECS);
    expect(pills).toEqual([
      { label: "verify", conclusion: "success" },
      { label: "build-images ×4", conclusion: "failure" }, // worst wins
      { label: "ferpa-guard", conclusion: "success" },
    ]);
  });

  it("treats an in-flight run as in_progress and a timed_out run as failure", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch([
        ["workflows/ci.yml/runs", { workflow_runs: [{ id: 222 }] }],
        [
          "runs/222/jobs",
          {
            jobs: [
              { name: "verify", status: "in_progress" },
              { name: "build-images (pwa)", status: "completed", conclusion: "timed_out" },
            ],
          },
        ],
        [
          "workflows/ferpa-guard.yml/runs",
          { workflow_runs: [{ status: "completed", conclusion: "success" }] },
        ],
      ]),
    );
    const pills = await collectCiPills("o/r", "tok", PILL_SPECS);
    expect(pills[0]).toEqual({ label: "verify", conclusion: "in_progress" });
    expect(pills[1]).toEqual({ label: "build-images ×4", conclusion: "failure" });
  });

  it("degrades every pill to unknown when the API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const pills = await collectCiPills("o/r", "tok", PILL_SPECS);
    expect(pills).toEqual([
      { label: "verify", conclusion: "unknown" },
      { label: "build-images ×4", conclusion: "unknown" },
      { label: "ferpa-guard", conclusion: "unknown" },
    ]);
  });

  it("returns the fallback pills (no fetch) when repo is missing", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const pills = await collectCiPills("", "tok", PILL_SPECS);
    expect(pills.map((p) => p.label)).toEqual(["verify", "build-images ×4", "ferpa-guard"]);
    expect(pills.every((p) => p.conclusion === "unknown")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
