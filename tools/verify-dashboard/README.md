# verify-dashboard

Generates the **TRACK Verification** dashboard — a live page that always reflects
`main`, replacing the old hand-built claude.ai snapshot. Published to GitHub Pages
by `.github/workflows/verification-dashboard.yml`.

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

GitHub Pages, source = **GitHub Actions** (one-time repo setting). No gh-pages
branch and no screenshots committed to `main`. URL:
<https://soult-io.github.io/teacher-assistant/>.
