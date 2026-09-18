import { describe, expect, it } from "vitest";
import { renderJourneyCard, renderJourneyList } from "./journeys.mjs";

const passed = {
  id: "J1",
  name: "Score a probe",
  product: "p",
  status: "passed",
  browsers: [
    { engine: "chromium", status: "passed", duration_ms: 600 },
    { engine: "firefox", status: "passed", duration_ms: 700 },
  ],
  duration_ms: 700,
  run: {
    ci_run_id: "999",
    ci_run_url: "https://github.com/o/r/actions/runs/999",
    commit_sha: "deadbeefcafe",
    workflow: "e2e",
    job: "e2e",
    generated_at: "2026-09-18T18:19:55Z",
    artifact_digest: "abcdef0123456789",
  },
  video: { src: "videos/J1-chromium.webm", poster: null, duration_ms: 600 },
  trace_url: "traces/J1-chromium.zip",
  steps: [
    {
      index: 0,
      label: "s1",
      assertions: [
        { text: "a1", status: "passed" },
        { text: "a2", status: "passed" },
      ],
    },
  ],
};

describe("renderJourneyCard — verified", () => {
  const html = renderJourneyCard(passed);
  it("shows the name and a passed badge", () => {
    expect(html).toContain("<h3>Score a probe</h3>");
    expect(html).toContain('<span class="jbadge pass">passed</span>');
    expect(html).toContain("j-passed");
  });
  it("renders a provenance bar linking the run with short sha + artifact digest", () => {
    expect(html).toContain('href="https://github.com/o/r/actions/runs/999"');
    expect(html).toContain("run #999");
    expect(html).toContain("deadbee"); // 7-char short sha
    expect(html).toContain("sha256:abcdef012345…");
    expect(html).toContain("e2e / e2e");
  });
  it("renders a chip per browser and the step/assertion meta with a trace link", () => {
    expect(html).toContain("chromium");
    expect(html).toContain("firefox");
    expect(html).toContain("1 step");
    expect(html).toContain("2 assertions");
    expect(html).toContain("traces/J1-chromium.zip");
  });
});

describe("renderJourneyCard — failed", () => {
  it("marks the card and badge red", () => {
    const html = renderJourneyCard({
      ...passed,
      status: "failed",
      browsers: [{ engine: "firefox", status: "failed", duration_ms: 10 }],
    });
    expect(html).toContain("j-failed");
    expect(html).toContain('<span class="jbadge fail">failed</span>');
    expect(html).toContain('<span class="chip fail">');
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
    expect(html).toContain("UNVERIFIED — no matching run");
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
