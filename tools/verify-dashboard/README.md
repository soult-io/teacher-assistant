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

When a push to `main` finishes its `e2e` run green (and on PRs, as a no-deploy build
check):

1. Runs each configured workspace's vitest with `--reporter=json` for **live counts**.
2. **Ingests journeys** from that same commit's `e2e` run (on a PR: the latest
   successful main run's)
   `journey-evidence.json` (steps + assertion text + per-browser results + video/trace
   + a per-step still),
   maps them onto the config manifest → `Journey[]`, each stamped with the run's
   provenance (run id/url, commit sha, workflow/job, timestamp, artifact sha256). A
   manifest journey with no matching run result renders **UNVERIFIED** (dashed,
   structurally incapable of a green PASS). Videos/traces/stills are copied out as
   served files (`videos/`, `traces/`, `stills/`), never inlined as data: URIs.
3. Derives the **e2e tile count** from those same ingested journeys (the verified
   ones), so it can never contradict the cards below it — no Playwright CLI is invoked
   at generate time. With no verified journey the tile degrades to a dash, like the
   UNVERIFIED cards, rather than a misleading `0`.
4. Reads **CI status for the page's own commit** from the GitHub Actions REST API
   (best-effort; degrades to neutral pills without a token) — see
   [CI pills](#ci-pills-bound-to-the-commit).
5. Fills `engine/template.html` → `dist-dashboard/index.html` + `videos/` + `traces/`
   + `stills/`. Each journey renders its human-pace walkthrough video (below) and a
   step-synced list; the gating run's fast video is only a raw-evidence link. The stills
   are taken by the e2e run itself, so the generator needs no browser and no preview
   server.

### CI pills: bound to the commit

The pill group is headed **`CI for <short sha>`** and every pill describes a run of
that one commit — the commit the journeys, counts and provenance come from. The
generator passes the FULL 40-char sha to `collectCiPills(repo, token, specs, sha)`
(from `COMMIT_SHA`, else `GITHUB_SHA`, else `git rev-parse HEAD`); the engine never
works from a short sha.

- **Query:** `…/workflows/<file>/runs?head_sha=<sha>&event=push&branch=main`.
- **Client-side re-check** of every candidate: `head_sha === sha`, `event === "push"`,
  `head_repository.full_name === repo` (case-insensitive). This rejects another
  commit's run, PR / `workflow_dispatch` runs, and a fork PR from a branch named
  `main`, even if the API ignored a filter.
- **Several matches:** newest `created_at` wins (ties: higher run id). Each list entry
  is a distinct run already at its latest attempt — a re-run bumps `run_attempt` on
  the same entry — so `run_attempt` does not order different runs. Job-split pills
  (e.g. `verify` + the `build-images` matrix) read `jobs?filter=latest` of that
  matched run only.

Pill states:

| state | class | shown as | meaning |
|---|---|---|---|
| `success` / `failure` | `pass` / `fail` | label | the run's verdict (`timed_out` → failure) |
| `in_progress` | `note` | `· in progress at build time <ISO>` | not finished when the page was generated |
| `no_run` | `none` (neutral, solid) | `· no run for this commit` | the API answered; no matching run exists. **Never** filled from another commit's run |
| `unknown` | `unk` (neutral, dashed) | `· status unknown` | the API could not be read (error, no repo/token, no valid sha); also a matched run with no job matching the spec, or a completed item with no conclusion |
| other (`cancelled`, `skipped`, …) | `note` | label | neutral |

The page is **static**, generated when the e2e run completes. Sibling workflows for
the same commit (CI, CodeQL) may still be running then, so their pills honestly read
"in progress at build time" — the page does not poll or update. On a PR build the
dashboard is built from the PR merge ref, which has no push run, so its pills read
"no run for this commit".

### Evidence: why a custom Playwright reporter

Playwright's built-in JSON reporter prunes a GREEN run to bare `test.step` titles — no
nested `expect` sub-steps, no assertion text. The reporter API DOES expose the full
tree, and `expect(locator, "message")` surfaces that message verbatim as the step
title. So `e2e/reporters/evidence-reporter.ts` records the full step+assertion tree
into `journey-evidence.json`; the dashboard renders only what a real run produced —
nothing is hand-authored.

### Walkthrough recording (Phase 3c, TEACH-16)

The gating run is fast (~2s per journey) — right for a pass/fail gate, unwatchable as a
video. So the card's video comes from a separate, **non-gating** capture:
`E2E_WALKTHROUGH=1 pnpm --filter @teacher-assistant/e2e e2e` re-runs J1–J6 on chromium
at the 390×844 phone viewport with `slowMo` 300ms per action, per-character typing
(80ms/char via `enterText`) and a 1.5s hold at the end of every step, recording video
1:1. It writes `test-results-walkthrough/walkthrough-evidence.json` (`mode:
"walkthrough"`, `commitSha`) whose step offsets are measured from the recording's first
frame, so markers and seek line up with that video. It refuses `E2E_BASE_URL` — it only
ever records the local synthetic build.

CI: the `walkthrough` job in `e2e.yml` runs after the gating job on pushes to main (and
manual dispatch), never on PRs, with `continue-on-error` so the workflow conclusion stays
the gating result. The dashboard downloads its `playwright-walkthrough` artifact from the
same run and binds a journey's walkthrough only if it is of the **same commit**, agrees
with the card's verdict (flaky counts as passed) and walked the same steps. Otherwise the
media slot shows a plain panel ("no walkthrough recorded for this commit", or why it was
not shown) — it never falls back to the fast video. The card labels the video
"walkthrough · run #N" linking the walkthrough job.

Size bounds (`engine/assets.mjs`): each video ≤ 20 MB and must be a WebM; every served
asset from both runs (videos, traces, stills) counts against one 100 MB published bound.
Over either → the generator fails loud.

### Per-step stills (Phase 3c)

Journey specs call the `step` fixture from `e2e/tests/support/journey.ts` instead of
`test.step`. On the canonical browser (the chromium project sets `stepStills: true`)
it attaches a full-height JPEG still (height capped at 4000px, quality 70) at the end
of every step — including a failing step, which shows the screen it failed on.

**Full height.** The app scrolls inside an inner container, so a `fullPage` screenshot
is only one viewport. The fixture instead measures what the on-screen vertical
scrollers hide (the main screen container, an open sheet — no selector, no per-journey
tuning), grows the viewport height by that, takes a plain viewport screenshot, then
restores the viewport and every scroll offset. A screen still cut off after that (over
the 4000px cap, or content that does not grow with the viewport) is recorded as
`truncated: true` — never silently cropped. The walkthrough project takes no stills,
so its video is untouched.

The reporter records the still as `steps[].screenshot` (schema `ta/journey-evidence/4`; v3 had the same still record):
a `{path, contentType, width, height, truncated}` record, or `null` when there is none.
Ingest maps it onto the Journey model as `steps[].screenshot` — a served
`stills/<journey>-<engine>-<NN>.jpg` path, or `null` — and `steps[].screenshot_truncated`:
`true`/`false` as recorded, or `null` when there is no still or the run predates the
flag (v2); `steps[].screenshot_width`/`screenshot_height` follow the same rule. The
journey also carries `steps_engine` (the browser its steps and stills come from) and
`unshown_still_engines` (browsers that took stills the card cannot show):

- **Absent is explicit.** A step with no still (a firefox-canonical card, a capture
  that failed, a file missing from the artifact) is `null` — never a placeholder, never
  a neighbour's still. Stills come only from the canonical browser's own record, so
  they always match the steps shown.
- **Loud on a broken contract.** A v2/v3 step without the field, a malformed record, a
  v3 still without a valid `width`/`height`/`truncated`, a file that is not a jpeg/png
  (extension and leading bytes), or a still over 2 MiB fails the generator.
- **v1 and v2 still ingest** (v1: every step `null`; v2: stills with
  `screenshot_truncated: null`, unknown — never shown as complete), so a dashboard
  pinned to an older run keeps rendering.
- **Flaky stays flaky.** Stills come from the final attempt, but journey status still
  comes from Playwright's `outcome`, so a retry that passed renders FLAKY.

### Step screens on the card (Phase 3c, TEACH-15)

The stills are hidden until a reader asks for one; the page fetches none on load.

- **Video | Screens.** With JS, a card with stills gets two views over its media
  column, and the step list drives both. Clicking a step seeks the video in the Video
  view and shows that step's still in the Screens view. The Screens view shows one still
  at a time, with Prev/Next and the arrow keys, which work only while focus is in the
  viewer. It shows the step's label and assertions, the still's size, an "open full size"
  link, and a "truncated at capture limit" note when the still was cut off. A tall still
  is shown at the column's width and scrolls inside a fixed-height stage. It is never
  squashed, and stepping does not shift the layout. The stills' browser is labelled.
- **Which view opens.** The Video view exists only when the card has a same-commit
  walkthrough. A passed card with one opens on Video. A card without one opens on
  Screens at step 1. A failed card opens on its failing step's still, which is the
  screen it failed on; the failing step also gets a "View failure screen" button.
- **No JS.** The tab row and the viewer stay hidden. Each step with a still has a
  "Screen ↗" link ("View failure screen ↗" on the failing step) that opens the image.
  This is a link rather than an inline image because browsers ignore `loading="lazy"`
  when scripting is off, so an inline image would fetch every still on load.
- **States.** A step without a still shows "no screen captured". A run with no stills
  shows one line instead of a viewer, and names the browser that has stills when the
  card's steps come from another browser. A flaky card names the retry its stills come
  from. An UNVERIFIED card never renders stills.

## Layout

- `engine/model.mjs` — Journey status derivation, UNVERIFIED, loud validation.
- `engine/ingest.mjs` — `journey-evidence.json` + manifest + provenance → `Journey[]`.
- `engine/assets.mjs` — serves run assets (videos, traces, stills) as files next to the page; still + video size caps, one published-bytes budget.
- `engine/provenance.mjs` — run provenance from CI env + artifact sha256.
- `engine/pii-scan.mjs` — the output scan (see [Output checks](#output-checks)); `engine/zip.mjs` reads trace.zip entries for it.
- `engine/counts.mjs` — vitest count mechanics + the journeys→e2e-tile count (`deriveE2eCount`).
- `engine/ci-status.mjs` — GitHub Actions API → status pills bound to one commit sha.
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
enable the CI pills (bound to `COMMIT_SHA`, else `GITHUB_SHA`, else the checkout's
HEAD). With no evidence file, every journey renders UNVERIFIED.

## Output checks

The page is private, but the image and the Actions artifacts are **public** (see
Hosting). Inputs are synthetic by construction; these checks refuse the whole build (no
`dist-dashboard/`, non-zero exit) if that ever stops being true:

- **Origin.** The evidence files (schema `ta/journey-evidence/4`) carry `baseURL`, the
  origin the run tested. Ingest refuses any value but `http://127.0.0.1:4173` (the local
  vite preview of the synthetic seed). This is the only check that covers videos and
  stills. Pre-stamp evidence (v1–v3) is refused when publishing and not ingested on a
  PR build. The gating Playwright config also throws when `CI` and `E2E_BASE_URL` are
  both set.
- **Network.** Every request in every trace.zip `*.network` log must go to `127.0.0.1`
  (or an RFC 2606 name that cannot resolve, e.g. `overlay.test`, which a test fulfils
  through a route).
- **Text scan.** `journey-evidence.json`, `walkthrough-evidence.json`, `results.json`,
  the rendered `index.html` and every text entry of every trace.zip are scanned for an
  email (RFC 2606 domains allowed), an SSN, a US phone number, and an `initials` value
  that is not 2–3 capital letters. There is no name blocklist and no bare-digit
  student-ID pattern (both collide with normal output).

A finding logs the file, the pattern type and the location — never the matched value:
the Actions logs are public too.

**Before upload.** The dashboard build runs these checks after `e2e.yml` has already
published its artifacts, so `e2e.yml` also runs them first:
`node tools/verify-dashboard/src/scan-artifacts.mjs <dir>` (`engine/artifact-scan.mjs`)
runs before each upload (`e2e/test-results/`, `e2e/test-results-walkthrough/`), pass or
fail, and the upload runs only when it exits 0. It walks the whole directory, fail-closed:
every `*.zip` gets the trace checks, videos and stills (`.webm .mp4 .png .jpg .jpeg .webp
.gif`) are skipped as pixels, every other file is text-scanned (a file with a NUL byte, or
a symlink, is a finding), and each `*-evidence.json` must carry the local origin stamp.
The CI run writes no Playwright HTML report: it was an unscanned public copy of every
trace. The walkthrough records a trace (snapshots on — without them Playwright logs no
network) so its videos get the network check too; it is never copied into the page.

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

The **page** is private, on the Lexington infra — not public GitHub Pages (Neil's call).
The **image** is public on GHCR, like this repo and its Actions artifacts: anyone can
pull it and read every video, still and trace in it (hence the
[output checks](#output-checks)). When a
push to `main` finishes its `e2e` run green, the workflow (triggered by `workflow_run`)
checks out that commit and builds the generated output (`dist-dashboard/`) into a static
nginx image and pushes it to GHCR:

- `ghcr.io/soult-io/teacher-assistant-verify:sha-<commit>` (immutable, pinned in the
  deploy stack) + a moving `:latest` (only while that commit is still main's tip).
  The image's provenance commit always equals its sha tag: the workflow fails rather
  than publish another commit's evidence (TEACH-21).

No screenshots or videos are committed to `main`. The deploy stack
`nsoult-agentic/stack-lexington-teacher-assistant` pins the image by tag + digest and
serves it behind the Lexington NPM on `ta-verify.stabpablo.com`. TLS + HTTP/2 terminate
at the NPM; **Neil applies the access gate** on that host — the image ships no auth of
its own. PII-free/synthetic, so a public GHCR image is fine; the private serving is
about who can view the page, not the image.
