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
  which test each maps to), branding, the screenshot gallery, and the capture flow.

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
5. Captures **fresh screenshots** of the running app (config's capture flow).
6. Fills `engine/template.html` → `dist-dashboard/index.html` + `images/` + `videos/`
   + `traces/`.

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
- `engine/render/journeys.mjs` — the minimal journey card + list (Phase 3a).
- `engine/template.html` — the product-agnostic page shell (branding tokens + sections).
- `config/teacher-assistant/index.mjs` — the TA config (suites, pills, manifest, branding, gallery).
- `config/teacher-assistant/capture.mjs` — the TA screenshot flow.
- `src/generate.mjs` — orchestrator (`pnpm --filter @teacher-assistant/verify-dashboard run generate`).
- `*.test.mjs` — vitest unit tests (run by `pnpm -r run test`).

## Run locally

```sh
pnpm install
pnpm -r run build                       # dist for vitest imports + vite preview
pnpm --filter @teacher-assistant/verify-dashboard exec playwright install chromium
CI=1 pnpm --filter @teacher-assistant/e2e e2e   # produces e2e/test-results/journey-evidence.json
pnpm --filter @teacher-assistant/verify-dashboard run generate
# open dist-dashboard/index.html
```

`EVIDENCE_FILE` overrides the evidence path; `SOURCE_*` supply the run provenance (the
CI wiring sets them from the resolved e2e run). `GITHUB_REPOSITORY` + `GITHUB_TOKEN`
enable the live CI pills. With no evidence file, every journey renders UNVERIFIED.

## Phase status

Phase 3a (this): CI wiring + ingest engine + engine/config split + provenance/UNVERIFIED
+ a MINIMAL card (name + badge + provenance bar + browser chips). Phase 3b: the full
JourneyCard — embedded video, synced step list, assertion sub-items, failure/flaky
states — replacing the screenshot gallery.

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
