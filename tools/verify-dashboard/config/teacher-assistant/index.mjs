// Teacher Assistant product config — the thin, product-SPECIFIC half of the verify
// dashboard. Everything the engine must NOT know (which suites/workflows to read, the
// journey manifest, branding, the existing screenshot gallery prose, the capture
// flow) lives here. Payroll onboards later as a second config against the same engine.

import { captureScreens } from "./capture.mjs";

export const productSlug = "teacher-assistant";

// The tested workspaces, in a stable display order (bars re-sort by pass count at
// render). content-api and diff-orchestrator are scaffolds with no tests.
export const packages = [
  {
    name: "@teacher-assistant/domain-core",
    label: "domain-core",
    sub: "the honesty engine",
    barClass: "eng",
  },
  { name: "@teacher-assistant/pwa", label: "apps/pwa", sub: "the UI, U1–U7", barClass: "ui" },
  {
    name: "@teacher-assistant/ferpa-guard",
    label: "ferpa-guard",
    sub: "privacy CI",
    barClass: "guard",
  },
  { name: "@teacher-assistant/store", label: "store", sub: "projections" },
  { name: "@teacher-assistant/crypto", label: "crypto", sub: "keyring / DEK" },
  { name: "@teacher-assistant/auth", label: "auth", sub: "passkey unlock" },
  { name: "@teacher-assistant/schema", label: "schema", sub: "entities" },
  { name: "@teacher-assistant/sync", label: "sync", sub: "relay client" },
  { name: "@teacher-assistant/sync-relay", label: "sync-relay", sub: "service" },
];

export const e2ePackage = "@teacher-assistant/e2e";
export const ferpaPackage = "@teacher-assistant/ferpa-guard";
export const enginePackage = "@teacher-assistant/domain-core";
export const pwaPackage = "@teacher-assistant/pwa";

// Which CI workflows/jobs become the "CI on main" pills.
export const ciPillSpecs = [
  {
    workflow: "ci.yml",
    jobs: [
      { label: "verify", equals: "verify" },
      { label: "build-images ×4", startsWith: "build-images" },
    ],
  },
  { workflow: "ferpa-guard.yml", label: "ferpa-guard" },
  { workflow: "codeql.yml", label: "CodeQL" },
  { workflow: "e2e.yml", label: "e2e" },
];

// The journey manifest: each e2e test → a journey, in display order. `match` selects
// the test by spec-file basename (+ a title substring where a file holds several).
// An entry with no matching run result renders UNVERIFIED (loud, not dropped).
export const journeyManifest = [
  {
    id: "J1",
    name: "Score a probe — the 3-tap daily loop",
    match: { file: "j1-score-probe.spec.ts" },
  },
  {
    id: "J2",
    name: "Offline capture → reconnect → sync",
    match: { file: "j2-offline-sync.spec.ts" },
  },
  { id: "J3", name: "Weekly close-out", match: { file: "j3-weekly-closeout.spec.ts" } },
  { id: "J4", name: "Para ↔ teacher FERPA boundary", match: { file: "j4-para-boundary.spec.ts" } },
  {
    id: "J5",
    name: "New goal → mandatory baseline (adopt)",
    match: { file: "j5-new-goal-baseline.spec.ts", title: "ADOPT" },
  },
  {
    id: "J5-draft",
    name: "Draft goal is unreachable by IC export",
    match: { file: "j5-new-goal-baseline.spec.ts", title: "DRAFT" },
  },
  {
    id: "J6",
    name: "No-data — a documented gap, not a zero",
    match: { file: "j6-no-data.spec.ts" },
  },
];

export const branding = {
  pageTitle: "TRACK Verification",
  pageDescription:
    "Test suite, CI status, and every user journey of the Teacher Assistant TRACK app — verified from real CI artifacts. Auto-generated from main by CI.",
  eyebrow: "Teacher Assistant · TRACK loop",
  heading: "TRACK Verification",
  lede: "The shippable IEP progress-tracking MVP — every test suite, CI check, and user journey, provenance-bound to the run that proved it. Offline-first, end-to-end encrypted, synthetic data only.",
  footerLinks: [
    { label: "Live staging", href: "https://ta-qa.stabpablo.com", text: "ta-qa.stabpablo.com" },
    {
      label: "Mobile prototype",
      href: "https://nsoult-agentic.github.io/teacher-assistant-p0/",
      text: "teacher-assistant-p0",
    },
    {
      label: "Source",
      href: "https://github.com/soult-io/teacher-assistant",
      text: "soult-io/teacher-assistant",
    },
  ],
  footerNote:
    "Auto-generated from soult-io/teacher-assistant by CI. Counts run live from the suites; CI status read from GitHub Actions; journeys bound to the e2e run that produced them. Synthetic data only — no real student record.",
};

/** Summary tiles, from the engine-computed metrics. Labels are product prose. */
export function tiles(metrics) {
  return [
    { value: metrics.unitTotal, label: "unit & component tests passing", variant: "accent" },
    { value: metrics.fileTotal, label: `test files across ${metrics.pkgCount} packages` },
    {
      value: metrics.ferpaCount,
      label: "FERPA-guard assertions (the compliance gate)",
      variant: "pass",
    },
    { value: metrics.e2eCount, label: "end-to-end journey checks (Playwright)" },
  ];
}

/** The two "test suite" callouts, from the engine-computed metrics. */
export function callouts(metrics) {
  return [
    {
      kind: "info",
      heading: "Where coverage is deep",
      html: `The engine (${metrics.engineCount}) and UI (${metrics.pwaCount}) carry the weight. The engine tests are where the progress-monitoring rules live — the ≥8-point trend gate, ⊘-as-gap, the consistency window, the denominator-mismatch disposition. Several were caught by adversarial review and are now regression-locked.`,
    },
    {
      kind: "",
      heading: "Honest gaps",
      html: `The <span class="mono">content-api</span> and <span class="mono">diff-orchestrator</span> services are scaffolds with no tests — differentiation isn't built yet (<span class="mono">/differentiate</span> returns 501). The journey cards below are bound to the e2e run that produced them; a declared journey with no run shows as UNVERIFIED, never as a silent pass.`,
    },
  ];
}

// Capture target for the screenshot gallery (the existing visual tiles). The unlock
// flow + selectors are product-specific, so the capture routine lives in config.
export const captureTarget = { previewPort: 4173, captureScreens };

// The screenshot gallery + desktop sections, moved verbatim out of the engine
// template (product prose). Phase 3b replaces the gallery with native JourneyCards.
export const sections = [
  { kind: "tests" },
  {
    kind: "journeys",
    title: "User journeys",
    meta: "bound to the latest e2e run · synthetic data",
  },
  {
    kind: "custom",
    title: "Every screen, from the running app",
    meta: "real build · synthetic seed",
    html: `<div class="gallery">
      <div class="view">
        <div class="shot"><img src="images/lock.png" alt="Lock screen" loading="lazy"></div>
        <div class="body"><div class="vh"><h3>Unlock</h3><span class="tag">M0 auth</span></div>
          <p>Passkey gate. The encrypted store is unreadable until a verified passkey unlocks the device-held keys.</p>
          <div class="cover">covered · <b>auth · crypto</b></div></div>
      </div>
      <div class="view">
        <div class="shot"><img src="images/dashboard.png" alt="Weekly dashboard" loading="lazy"></div>
        <div class="body"><div class="vh"><h3>Weekly Dashboard</h3><span class="tag">U2</span></div>
          <p>The three-state header — scored · excused · owe — owes-first, with para points awaiting the teacher's OK.</p>
          <div class="cover">covered · <b>pwa · store</b></div></div>
      </div>
      <div class="view">
        <div class="shot"><img src="images/by-student.png" alt="By-student lens" loading="lazy"></div>
        <div class="body"><div class="vh"><h3>By-student lens</h3><span class="tag">U2</span></div>
          <p>One of three grouping lenses — student cards with the fixed monogram colours, a goal's context on each.</p>
          <div class="cover">covered · <b>store projections</b></div></div>
      </div>
      <div class="view">
        <div class="shot"><img src="images/quickscore.png" alt="Quick-Score sheet" loading="lazy"></div>
        <div class="body"><div class="vh"><h3>Quick-Score</h3><span class="tag">U3</span></div>
          <p>#correct stepper over a custom total → live %. Save, No-data, or bookmark to score later.</p>
          <div class="cover">covered · <b>pwa · domain-core</b></div></div>
      </div>
      <div class="view">
        <div class="shot"><img src="images/nodata.png" alt="No-data flow" loading="lazy"></div>
        <div class="body"><div class="vh"><h3>No-Data</h3><span class="tag">U3</span></div>
          <p>"A documented gap, not a zero." The five locked reasons, and the honest note: any no-data pauses the run, never breaks it.</p>
          <div class="cover">covered · <b>domain-core · SME-ruled</b></div></div>
      </div>
      <div class="view">
        <div class="shot"><img src="images/goal-detail.png" alt="Goal detail" loading="lazy"></div>
        <div class="body"><div class="vh"><h3>Goal Detail</h3><span class="tag">U4</span></div>
          <p>Trend with ⊘ shown as a gap, quarterly averaged as-is, and the draft IC statement held at <b>Indeterminate</b> under the 8-point gate.</p>
          <div class="cover">covered · <b>the honesty surface</b></div></div>
      </div>
      <div class="view">
        <div class="shot"><img src="images/new-goal.png" alt="New goal form" loading="lazy"></div>
        <div class="body"><div class="vh"><h3>New Goal</h3><span class="tag">U5</span></div>
          <p>The six KY IEP components, baseline-mandatory, fixed vs variable probe basis, accom/mod kept out of the IC statement.</p>
          <div class="cover">covered · <b>pwa · domain-core</b></div></div>
      </div>
      <div class="view">
        <div class="shot"><img src="images/para.png" alt="Para aide surface" loading="lazy"></div>
        <div class="body"><div class="vh"><h3>Para surface</h3><span class="tag">U6 · FERPA</span></div>
          <p>The least-privilege aide view — one class only, catalog labels (no goal text), no trends, no export. A real key boundary, not a filter.</p>
          <div class="cover">covered · <b>ferpa-guard</b></div></div>
      </div>
    </div>`,
  },
  {
    kind: "custom",
    title: "Desktop layout",
    meta: "TEACH-8 · U7 shipped",
    html: `<div class="desk">
      <div class="frame"><img src="images/desktop-dashboard.png" alt="Desktop dashboard — sidebar + master-detail"></div>
      <div class="note">
        <h3>Co-equal desktop, shipped</h3>
        <p>The app is mobile-first, but on a laptop it now renders its own responsive desktop shell: a left sidebar and a master–detail dashboard that puts a goal's whole record beside the list — not a stretched phone strip.</p>
        <div class="status-line st-done"><span class="dot"></span>U7 built and on main</div>
        <p style="margin-top:.8rem;font-size:.84rem;">Captured live from the running app at ≥900px. Every token, status glyph, and honesty string carries over verbatim from the verified mobile screens.</p>
      </div>
    </div>
    <div class="frame wide"><img src="images/desktop-para.png" alt="Desktop para surface"></div>`,
  },
];
