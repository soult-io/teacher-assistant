# Phase 3a — implementation spec (foundation)

Derived from `design/verify-dashboard-phase3-spec.md`. Scope: the FOUNDATION only — CI wiring +
ingest engine + engine/config split + provenance/UNVERIFIED + a MINIMAL card list. The full
JourneyCard (video player + synced step list) is Phase 3b and is deliberately NOT built here.

## VERIFY finding (the load-bearing decision for 3b)

Empirically confirmed against the real latest-main `e2e` run (`results.json`, run 35379314075) and an
isolated reporter-API experiment:

- The built-in Playwright **JSON reporter prunes green runs to top-level `test.step` titles only**
  (`{title, duration}` — no `category`, no nested `expect` sub-steps, no assertion text).
- The **reporter API** (`onStepEnd`) DOES expose the full tree, and **`expect(locator, "message")`
  surfaces the custom message verbatim as the `expect` step's `title`** (category `"expect"`),
  parented to its `test.step`.
- `results.json` has no per-test `id` (only a per-spec `spec.id` shared across browsers), so joining a
  side-car reporter file to `results.json` by id is fragile.

Therefore the spec's fallback ladder lands on rung 3: **a custom Playwright reporter is required** (not
hand-authored text). It emits a **complete, self-contained** evidence file so ingest reads ONE source.

## Deliverables

### 1. Evidence capture — custom reporter (`e2e/`)
- `e2e/reporters/evidence-reporter.ts` — writes `test-results/journey-evidence.json`
  (schema `journey-evidence/1`): per test result — titlePath, file/line, project (browser), final
  status + outcome (expected/unexpected/flaky/skipped), duration, retries, errors, attachments
  (video/trace, raw CI paths), and the ordered `test.step` tree with nested `expect` titles as
  assertions (`{text, status, detail?}`).
- Added to `playwright.config.ts` CI reporter array (alongside github/json/html).
- Product-agnostic: raw Playwright shapes, zero TA vocabulary.

### 2. Engine (`tools/verify-dashboard/engine/`, product-AGNOSTIC — no TA vocab)
- `model.mjs` — `JOURNEY_STATUS`, `deriveJourneyStatus(browsers)`, `makeUnverified(entry, product)`,
  `assertJourney()` (loud validation).
- `provenance.mjs` — `buildRunProvenance(env)` from `SOURCE_*`/`GITHUB_*`; `sha256Hex(bytes)`.
- `ingest.mjs` — `parseEvidence(text)` (loud-fail on unparseable / wrong schema);
  `buildJourneys({records, manifest, product, provenance, resolveAsset})` → `Journey[]`. A manifest
  entry with no matching test → `status:"unverified"`. `resolveAsset` is injected (keeps ingest I/O-free
  and testable); the orchestrator implements the copy-next-to-dashboard.
- `counts.mjs` — vitest mechanics (`parseVitestReport`, `collectPackageCounts(root, tmp, packages)`,
  `collectE2eCount(root)`); the package LIST comes from config.
- `ci-status.mjs` — GitHub Actions mechanics (`collectCiPills(repo, token, pillSpecs)`); the pill SPECS
  come from config.
- `render/lib.mjs` — pure builders (`escapeHtml`, `aggregate`, `renderBars`, `renderCiPills`,
  `fillTemplate`, tile/section renderers).
- `render/journeys.mjs` — `renderJourneyList` / `renderJourneyCard` (MINIMAL 3a card: name +
  pass/fail badge + provenance bar + browser chips; dashed UNVERIFIED variant that cannot show PASS).
- `template.html` — a product-agnostic shell: branding tokens + CI strip + `{{SECTIONS}}`. All TA prose
  lives in config as section data / custom-html.

### 3. Config (`tools/verify-dashboard/config/teacher-assistant/`)
- `index.mjs` — the TA config object: product slug/name, branding, `packages[]` (which suites),
  `ciPillSpecs[]` (which workflows/jobs), `tiles[]`, `journeyManifest[]` (ordering + display names +
  file/title match), `sections[]` (tiles/bars/journeys/custom-html incl. the existing gallery + desktop
  markup moved verbatim), and the capture target.
- `capture.mjs` — the TA screenshot flow (moved from `src/capture.mjs`; TA selectors are product-specific
  and rightly live in config).

### 4. Orchestrator (`tools/verify-dashboard/src/generate.mjs`)
Thin: load config → run engine mechanics (counts, ci pills, capture) → read evidence + provenance →
ingest → render → write `index.html` + copy videos/traces to `dist-dashboard/{videos,traces}/`.

### 5. CI wiring (`.github/workflows/verification-dashboard.yml`)
Resolve the latest **successful main `e2e` run** (GitHub API), download its `playwright-test-results`
artifact by `run-id` (already has `actions: read`), compute `artifact_digest` (sha256 of the evidence
file), pass `SOURCE_*` provenance env to the generator. Bound to the newest run's set. Existing tiles /
CI pills / image build unchanged.

## Acceptance criteria
1. Custom reporter emits `journey-evidence.json` with real `test.step` labels + `expect` assertion text
   from a GREEN run (no hand-authored evidence).
2. Ingest maps each manifest test → a Journey with provenance-bound `run{}`; browsers[] from per-project
   results; video/trace resolved to served files; unmatched manifest entry → UNVERIFIED.
3. Engine has NO TA/IEP/FERPA/probe vocabulary (grep-clean).
4. Loud-fail on unparseable evidence JSON preserved.
5. Existing count / CI-pill / coverage tiles still render.
6. Proof: `Journey[]` generated from a real e2e run + a minimal card list rendered incl. an UNVERIFIED
   example.
7. Full green CI (verify, e2e, ferpa-guard, codeql, verification-dashboard build); PR assignee neilsoult;
   not self-merged.

## Out of scope (3b)
Full JourneyCard visual (video player, synced step list, failure/flaky detail), replacing the gallery
custom-html with native journey rendering, repo extraction.
