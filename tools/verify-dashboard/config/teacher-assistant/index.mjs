// Teacher Assistant product config — the thin, product-SPECIFIC half of the verify
// dashboard. Everything the engine must NOT know (which suites/workflows to read, the
// journey manifest, branding) lives here. Payroll onboards later as a second config
// against the same engine.

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
    // e2eCount is null when no journey is verified (no run bound); degrade to a dash
    // like the UNVERIFIED cards rather than showing a misleading "0".
    { value: metrics.e2eCount ?? "—", label: "end-to-end journey checks (Playwright)" },
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

// The page sections, in order. The engine-native "tests" section (count/CI-pill/
// coverage tiles + bars + callouts) sits above the journey list. The journey cards —
// each bound to the e2e run that produced it, with the run's own video, steps and
// assertions — are the visual proof; there is no hand-authored screenshot gallery any
// more (Phase 3 removed the last hand-authored captions: nothing on the page exists
// that a real run did not produce).
export const sections = [
  { kind: "tests" },
  {
    kind: "journeys",
    title: "User journeys",
    meta: "bound to the latest e2e run · synthetic data",
  },
];
