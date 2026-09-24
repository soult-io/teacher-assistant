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
  video: {
    src: "videos/J1-walkthrough.webm",
    poster: null,
    duration_ms: 4000,
    recording: "walkthrough",
    run_id: "999",
    run_url: "https://github.com/o/r/actions/runs/999",
  },
  media_note: null,
  raw_video_url: "videos/J1-chromium.webm",
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
  it("embeds the walkthrough video, labelled as its own recording with its run", () => {
    expect(html).toContain("data-video controls");
    expect(html).toContain('src="videos/J1-walkthrough.webm"');
    expect(html).toContain(
      'class="jreclabel mono">walkthrough · <a href="https://github.com/o/r/actions/runs/999"',
    );
  });
  it("keeps the fast gating video out of the media slot — a raw link beside trace.zip only", () => {
    expect(html).not.toContain('src="videos/J1-chromium.webm"');
    const prov = html.slice(html.indexOf("jprov"), html.indexOf("jbody"));
    expect(prov).toContain('href="traces/J1-chromium.zip" download>trace.zip</a>');
    expect(prov).toContain('href="videos/J1-chromium.webm"');
    expect(prov).toContain("gating video");
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

describe("renderJourneyCard — no walkthrough for this commit", () => {
  const html = renderJourneyCard({
    ...passed,
    video: null,
    media_note: "no walkthrough recorded for this commit",
    steps: passed.steps.map((st) => ({ ...st, t_start_ms: null })),
  });
  it("shows a plain panel in the media slot — never the fast video", () => {
    expect(html).toContain('<div class="jnovideo">no walkthrough recorded for this commit</div>');
    expect(html).not.toContain("<video");
    expect(html).not.toContain("jreclabel");
  });
  it("still offers the fast video as raw evidence", () => {
    expect(html).toContain('href="videos/J1-chromium.webm"');
  });
  it("renders the steps without seek handles", () => {
    expect(html).toContain("Tap Save");
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

// ---- Phase 3c: per-step screens (stills) ----

const shot = (n, over = {}) => ({
  screenshot: `stills/J1-chromium-${String(n).padStart(2, "0")}.jpg`,
  screenshot_truncated: false,
  screenshot_width: 390,
  screenshot_height: 1430,
  ...over,
});
const noShot = {
  screenshot: null,
  screenshot_truncated: null,
  screenshot_width: null,
  screenshot_height: null,
};
const withStills = {
  ...passed,
  steps_engine: "chromium",
  unshown_still_engines: [],
  steps: [
    { ...passed.steps[0], ...shot(0) },
    { ...passed.steps[1], ...shot(1, { screenshot_truncated: true, screenshot_height: 4000 }) },
    {
      index: 2,
      label: "Close the sheet",
      status: "passed",
      screen: null,
      t_start_ms: 3000,
      thumbnail: null,
      assertions: [],
      ...noShot,
    },
  ],
};
const failedWithStills = {
  ...withStills,
  status: "failed",
  browsers: [{ engine: "chromium", status: "failed", duration_ms: 10, retries: 0 }],
  steps: [
    withStills.steps[0],
    {
      ...withStills.steps[1],
      status: "failed",
      assertions: [{ text: "saved toast is visible", status: "failed", actual: "not found" }],
    },
  ],
};
const between = (html, from, to) =>
  html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
// One step's <li>, up to the next step or the end of the list.
const stepHtml = (html, n) => {
  const start = html.indexOf(`data-step="${n}"`);
  const next = html.indexOf("data-step=", start + 1);
  return html.slice(start, next === -1 ? html.indexOf("</ol>", start) : next);
};

describe("renderJourneyCard — step screens, passed card with a walkthrough", () => {
  const html = renderJourneyCard(withStills, 0);
  it("puts each still's served path + size on its step, and a no-JS link that opens it", () => {
    expect(html).toContain(
      'data-shot-src="stills/J1-chromium-00.jpg" data-shot-w="390" data-shot-h="1430"',
    );
    expect(html).toContain(
      '<p class="jshot mono"><a href="stills/J1-chromium-00.jpg" target="_blank" rel="noopener" aria-label="Screen for step 1 of 3: Open the dashboard (opens the image)">Screen ↗</a> · chromium · 390×1430</p>',
    );
  });
  it("renders no <img> at all: nothing is fetched until a reader asks (JS or not)", () => {
    expect(html).not.toContain("<img");
  });
  it("flags a still cut off at the capture limit, in the disclosure and on the step", () => {
    expect(html).toContain("data-shot-trunc");
    expect(html).toContain("truncated at capture limit");
    // only step 2 is truncated
    expect(html.match(/data-shot-trunc/g)).toHaveLength(1);
  });
  it("a step with no still says so plainly and has no image", () => {
    const step3 = stepHtml(html, 2);
    expect(step3).toContain('<p class="jnoshot-inline mono">no screen captured</p>');
    expect(step3).not.toContain("<img");
    expect(step3).not.toContain("data-shot-src");
  });
  it("renders the Video | Screens tabs (hidden until JS), Video selected, labelled source", () => {
    expect(html).toContain('class="jmodes" role="tablist" aria-label="Evidence view" hidden');
    expect(html).toMatch(/role="tab" id="jc0-J1-tab-v"[^>]*aria-selected="true"/);
    expect(html).toMatch(/role="tab" id="jc0-J1-tab-s"[^>]*aria-selected="false" tabindex="-1"/);
    expect(html).toContain('<span class="jcount mono">2/3</span>');
    expect(html).toContain('<span class="jsrc mono">stills · chromium</span>');
    expect(html).toContain('data-view="video"');
  });
  it("renders the screen viewer hidden, with an empty stage (nothing fetched on load)", () => {
    const viewer = between(html, 'class="jscreens"', 'class="jsteps-wrap"');
    expect(viewer).toContain("hidden");
    expect(viewer).toContain('class="jstage" tabindex="0"');
    expect(viewer).toContain('class="jlive" aria-live="polite" aria-atomic="true"');
    expect(viewer).not.toContain("<img");
    expect(viewer).not.toContain("stills/");
  });
  it("has no failure marks on a passed card", () => {
    expect(html).not.toContain("jfailmark");
    expect(html).not.toContain("data-fail-step");
    expect(html).not.toContain("View failure screen");
  });
  it("makes every step header a button so Screens can select it", () => {
    expect(stepHtml(html, 2)).toContain('<button type="button" class="jstep-hd"');
  });
});

describe("renderJourneyCard — step screens, failed card", () => {
  const html = renderJourneyCard(failedWithStills, 0);
  it("opens on Screens at the failing step", () => {
    expect(html).toContain('data-view="screens"');
    expect(html).toContain('data-fail-step="1"');
    expect(html).toContain('class="jfailmark"');
  });
  it("labels the failing step's disclosure and gives it a failure-screen button", () => {
    const step2 = stepHtml(html, 1);
    expect(step2).toContain(">View failure screen ↗</a>");
    expect(step2).toContain('class="jfailbtn" hidden>View failure screen</button>');
    expect(step2).toContain("(failed)");
  });
  it("a failed step with no still gets no failure-screen button", () => {
    const h = renderJourneyCard(
      {
        ...failedWithStills,
        steps: [failedWithStills.steps[0], { ...failedWithStills.steps[1], ...noShot }],
      },
      0,
    );
    expect(h).not.toContain("jfailbtn");
    expect(stepHtml(h, 1)).toContain("no screen captured");
  });
});

describe("renderJourneyCard — step screens, no walkthrough", () => {
  const html = renderJourneyCard(
    { ...withStills, video: null, media_note: "no walkthrough recorded for this commit" },
    0,
  );
  it("has no Video tab and opens on Screens", () => {
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("<video");
    expect(html).toContain('data-view="screens"');
  });
  it("still says why there is no video", () => {
    expect(html).toContain("no walkthrough recorded for this commit");
  });
});

describe("renderJourneyCard — zero stills / UNVERIFIED / other-engine stills", () => {
  it("zero stills: no tabs, no viewer, no per-step lines, one note", () => {
    const html = renderJourneyCard(
      { ...withStills, steps: withStills.steps.map((s) => ({ ...s, ...noShot })) },
      0,
    );
    expect(html).not.toContain("jmodes");
    expect(html).not.toContain("jscreens");
    expect(html).not.toContain("no screen captured");
    expect(html).toContain("no step screens in this run's evidence");
  });
  it("names the browser that has the stills when the steps come from another", () => {
    const html = renderJourneyCard(
      {
        ...withStills,
        steps_engine: "firefox",
        unshown_still_engines: ["chromium"],
        steps: withStills.steps.map((s) => ({ ...s, ...noShot })),
      },
      0,
    );
    expect(html).toContain(
      "no step screens from firefox, whose run these steps are from — screens exist for chromium",
    );
  });
  it("UNVERIFIED renders no screens even when the input carries stills", () => {
    const html = renderJourneyCard(
      { ...withStills, status: "unverified", run: null, video: null },
      0,
    );
    for (const s of ["jmodes", "jscreens", "jshot", "data-shot", "stills/"]) {
      expect(html).not.toContain(s);
    }
  });
});

describe("renderJourneyCard — step screens, flaky", () => {
  it("says which attempt the screens come from", () => {
    const html = renderJourneyCard(
      {
        ...withStills,
        status: "flaky",
        browsers: [{ engine: "chromium", status: "flaky", duration_ms: 600, retries: 2 }],
      },
      0,
    );
    expect(html).toContain("screens from the passing attempt (retry 2)");
  });
});

describe("renderJourneyCard — still path safety", () => {
  it("treats an absolute, schemed or parent-relative still path as absent", () => {
    for (const bad of [
      "javascript:alert(1)",
      "https://x.test/a.jpg",
      "/abs/a.jpg",
      "../x.jpg",
      "a/../../x.jpg",
      "a\\b.jpg",
    ]) {
      const html = renderJourneyCard(
        {
          ...withStills,
          steps: [{ ...withStills.steps[0], screenshot: bad }, withStills.steps[1]],
        },
        0,
      );
      expect(html).not.toContain(bad);
      expect(stepHtml(html, 0)).toContain("no screen captured");
    }
  });
  it("escapes a still path", () => {
    const html = renderJourneyCard(
      { ...withStills, steps: [{ ...withStills.steps[0], screenshot: 'stills/a"b<.jpg' }] },
      0,
    );
    expect(html).toContain("stills/a&quot;b&lt;.jpg");
    expect(html).not.toContain('a"b<');
  });
});

describe("renderJourneyList — step-screen ids", () => {
  it("gives every card unique, id-safe ids, even for colliding journey ids", () => {
    const html = renderJourneyList([
      { ...withStills, id: "J 1" },
      { ...withStills, id: "J-1" },
    ]);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  });
});
