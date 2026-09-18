# verify-dashboard

Generates the **TRACK Verification** dashboard — a live page that always reflects
`main`, provenance-bound to the CI runs that produced it. Packaged into a small static
nginx image (`teacher-assistant-verify`) and pushed to GHCR by
`.github/workflows/verification-dashboard.yml`, then served privately on Lexington.

## Architecture: engine + config (extraction-ready)

A clean seam so the same generator serves other products later (payroll next) with
only a new config — brain #3654, a hard Phase 3 acceptance criterion.

- **`engine/`** — product-AGNOSTIC. Artifact ingest (`journey-evidence.json` →
  `Journey[]`), the Journey model + status/UNVERIFIED logic, provenance binding, the
  vitest/CI mechanics, the renderers, and `template.html`. Takes only `Journey[]` +
  config data + tokens. No product vocabulary anywhere in it.
- **`config/teacher-assistant/`** — product-SPECIFIC. Which suites to count, which
  workflows/jobs become CI pills, the journey manifest (ordering + display names +
  which test each maps to), branding, and the page section order.

`src/generate.mjs` is a thin orchestrator: it wires config into the engine.

## What it does

On every push to `main` (and on PRs, as a no-deploy build check):

1. Runs each configured workspace's vitest with `--reporter=json` for **live counts**.
2. Counts Playwright tests via `playwright test --list`.
3. Reads **CI status** for `main` from the GitHub Actions REST API (best-effort;
   degrades to neutral pills without a token).
4. **Ingests journeys** from the latest successful main `e2e` run's
   `journey-evidence.json` (steps + assertion text + per-browser results + video/trace),
   maps them onto the config manifest → `Journey[]`, each stamped with the run's
   provenance (run id/url, commit sha, workflow/job, timestamp, artifact sha256). A
   manifest journey with no matching run result renders **UNVERIFIED** (dashed,
   structurally incapable of a green PASS). Videos/traces are copied out as served
   files (`videos/`, `traces/`), never inlined as data: URIs.
5. Fills `engine/template.html` → `dist-dashboard/index.html` + `videos/` + `traces/`.
   Each journey renders its own run video and step-synced list — there is no separate
   screenshot capture step, so the generator needs no browser and no preview server.

### Evidence: why a custom Playwright reporter

Playwright's built-in JSON reporter prunes a GREEN run to bare `test.step` titles — no
nested `expect` sub-steps, no assertion text. The reporter API DOES expose the full
tree, and `expect(locator, "message")` surfaces that message verbatim as the step
title. So `e2e/reporters/evidence-reporter.ts` records the full step+assertion tree
into `journey-evidence.json`; the dashboard renders only what a real run produced —
nothing is hand-authored.

## Layout

- `engine/model.mjs` — Journey status derivation, UNVERIFIED, loud validation.
- `engine/ingest.mjs` — `journey-evidence.json` + manifest + provenance → `Journey[]`.
- `engine/provenance.mjs` — run provenance from CI env + artifact sha256.
- `engine/counts.mjs` — vitest/playwright count mechanics.
- `engine/ci-status.mjs` — GitHub Actions API → status pills.
- `engine/render/lib.mjs` — pure builders (tiles, bars, pills, callouts, template fill).
- `engine/render/journeys.mjs` — the full JourneyCard (video + synced step list +
  assertions + failure/flaky/UNVERIFIED states) + list.
- `engine/template.html` — the product-agnostic page shell (tokens + card CSS + the
  generic video↔step sync script).
- `config/teacher-assistant/index.mjs` — the TA config (suites, pills, manifest, branding, sections).
- `src/generate.mjs` — orchestrator (`pnpm --filter @teacher-assistant/verify-dashboard run generate`).
- `*.test.mjs` — vitest unit tests (run by `pnpm -r run test`).

## Run locally

```sh
pnpm install
pnpm -r run build                       # dist for vitest imports + the e2e preview
pnpm --filter @teacher-assistant/e2e exec playwright install chromium firefox
CI=1 pnpm --filter @teacher-assistant/e2e e2e   # CI=1 enables the evidence reporter → e2e/test-results/journey-evidence.json
pnpm --filter @teacher-assistant/verify-dashboard run generate
# open dist-dashboard/index.html
```

The evidence reporter (and thus `journey-evidence.json`) is only wired into the CI
reporter array, so a local run needs `CI=1` to produce it.

`EVIDENCE_FILE` overrides the evidence path; `SOURCE_*` supply the run provenance (the
CI wiring sets them from the resolved e2e run). `GITHUB_REPOSITORY` + `GITHUB_TOKEN`
enable the live CI pills. With no evidence file, every journey renders UNVERIFIED.

## Phase status

Phase 3a: CI wiring + ingest engine + engine/config split + provenance/UNVERIFIED + a
minimal card. Phase 3b (this): the full JourneyCard — embedded run video with a
step-marker rail, a synced step list (click a step to seek; the current step
highlights as the video plays), assertion sub-items, and distinct failure/flaky/
UNVERIFIED states. The video's canonical browser is chosen to MATCH the card's
aggregate badge (chromium-first within that status), so a failed card can never show a
passing sibling's video. This replaced the hand-authored screenshot gallery — the page
now carries nothing a real run did not produce.

## Hosting

**Private**, on the Lexington infra — not public GitHub Pages (Neil's call). On push
to `main` the workflow builds the generated output (`dist-dashboard/`) into a static
nginx image and pushes it to GHCR:

- `ghcr.io/soult-io/teacher-assistant-verify:sha-<commit>` (immutable, pinned in the
  deploy stack) + a moving `:latest`.

No screenshots or videos are committed to `main`. The deploy stack
`nsoult-agentic/stack-lexington-teacher-assistant` pins the image by tag + digest and
serves it behind the Lexington NPM on `ta-verify.stabpablo.com`. TLS + HTTP/2 terminate
at the NPM; **Neil applies the access gate** on that host — the image ships no auth of
its own. PII-free/synthetic, so a public GHCR image is fine; the private serving is
about who can view the page, not the image.
