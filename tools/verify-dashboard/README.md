# verify-dashboard

Generates the **TRACK Verification** dashboard — a live page that always reflects
`main`, replacing the old hand-built claude.ai snapshot. Packaged into a small
static nginx image (`teacher-assistant-verify`) and pushed to GHCR by
`.github/workflows/verification-dashboard.yml`, then served privately on Lexington.

## What it does

On every push to `main` (and on PRs, as a no-deploy build check):

1. Runs each tested workspace's vitest with `--reporter=json` for **live counts**
   — per-package pass count (`numPassedTests`) and test-file count
   (`testResults.length`, not the suite count).
2. Counts Playwright tests via `playwright test --list`.
3. Reads **CI status** for `main` from the GitHub Actions REST API (best-effort;
   degrades to neutral pills without a token).
4. Captures **fresh screenshots** of the running app — 8 mobile views + 2 desktop
   views — by building the PWA, serving it with `vite preview`, and driving it
   with Playwright. Unlock is one click on the SyntheticPasskey gateway
   (`getByTestId("unlock")`); no real WebAuthn.
5. Fills `template.html` → `dist-dashboard/index.html` + `dist-dashboard/images/`.

Selector care: the goal-detail trigger's accessible name is its aria-label
`trend and history <goal>`, **not** the `Trend & history` title. Every selector
miss throws — a blank or wrong shot fails the run rather than slipping through.

## Layout

- `src/lib.mjs` — pure builders (counts → totals, bars, pills, template fill). Unit-tested.
- `src/lib.test.mjs` — vitest unit tests (run by `pnpm -r run test`).
- `src/counts.mjs` — runs vitest/playwright for live counts.
- `src/ci-status.mjs` — GitHub Actions API → status pills.
- `src/capture.mjs` — Playwright screenshot flow.
- `src/generate.mjs` — orchestrator (`pnpm --filter @teacher-assistant/verify-dashboard run generate`).
- `template.html` — tokenised copy of `design/verification-dashboard.html`.

## Run locally

```sh
pnpm install
pnpm -r run build                       # dist for vitest imports + vite preview
pnpm --filter @teacher-assistant/verify-dashboard exec playwright install chromium
pnpm --filter @teacher-assistant/verify-dashboard run generate
# open dist-dashboard/index.html
```

`GITHUB_REPOSITORY` + `GITHUB_TOKEN` in the environment enable the live CI pills;
without them the pills render as "status unknown".

## Hosting

**Private**, on the Lexington infra — not public GitHub Pages (Neil's call). On push
to `main` the workflow builds the generated output (`dist-dashboard/`) into a static
nginx image and pushes it to GHCR:

- `ghcr.io/soult-io/teacher-assistant-verify:sha-<commit>` (immutable, pinned in the
  deploy stack) + a moving `:latest`.

No screenshots are committed to `main`. The deploy stack
`nsoult-agentic/stack-lexington-teacher-assistant` (`verify/docker-compose.yml`, stack
`teacher-assistant-verify`) pins the image by tag + digest and serves it behind the
Lexington NPM on `ta-verify.stabpablo.com` (proposed). TLS + HTTP/2 terminate at the
NPM; **Neil applies the access gate (access-list / local-only)** on that host — the
image ships no auth of its own. The dashboard is PII-free/synthetic, so a public GHCR
image is fine; the private serving is about who can view the page, not the image.

To make the first image public on GHCR (so the Lexington host pulls with no
credential, like the four app images): a one-time package-visibility toggle by the
operator after the first push (GHCR packages default to private).
