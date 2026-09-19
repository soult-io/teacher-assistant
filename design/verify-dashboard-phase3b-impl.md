# Phase 3b — Full JourneyCard renderer (impl notes)

Status: build spec, 2026-09-19. Builds on the merged Phase 3a foundation (PR #46): the custom
evidence reporter → `journey-evidence.json`, the ingest engine → `Journey[]`, provenance binding,
the UNVERIFIED degraded state, and the minimal card list. This phase delivers the full visual:
each journey renders its embedded video, a step-synced list, assertions, provenance, and the
failure/flaky/unverified states — all from the run's evidence, no hand-authored captions.

Source of truth for the layout: `verify-dashboard-phase3-spec.md` §"Journey-card layout (Phase 3b)".
Product-agnostic engine only (`tools/verify-dashboard/engine/render/*`) — no TA/IEP/probe/FERPA
vocabulary; TA specifics stay in `config/teacher-assistant/`.

## What changes

### 1. Evidence reporter — per-step time offset (`e2e/reporters/evidence-reporter.ts`)
The video↔step sync (scrubber markers, click-to-seek, play-time auto-highlight, auto-seek to a
failing step) needs each step's start time as an offset into the recording. Playwright's `TestStep`
exposes `startTime`; the video recording begins at context creation (~test start = `result.startTime`).
Add `startOffsetMs = max(0, round(step.startTime - result.startTime))` to each `StepRecord`. This is
an approximation (video start ≈ test start) but stable and good enough for markers/seek. Old evidence
(from a pre-change run) has no field → the engine renders no markers and a non-seekable list; it never
crashes and never fabricates an offset.

### 2. Ingest (`engine/ingest.mjs`)
- **Close the 3a-flagged canonical trap.** `pickCanonical` becomes status-aware: it prefers the
  browser whose per-browser status equals the journey's aggregate (worst-wins) status, chromium-first
  within that set, falling back to chromium-first overall. So a failed card shows a *failing* run's
  video/steps — the badge can never contradict the video (no passing-chromium video under a
  failed-firefox badge). Per-browser status stays visible in the chips.
- Carry `status` and `t_start_ms` (from the reporter's `startOffsetMs`) on each ingested step, so the
  failing step can be outlined and the list can seek. `screen`/`thumbnail` stay null (not in evidence;
  never hand-authored).
- Carry `retries` on each browser, for the flaky "passed on retry N" badge.

### 3. Renderer (`engine/render/journeys.mjs`) — the full JourneyCard
Two coordinated columns in one card:
- **Header:** name + per-browser chips (each with its own status dot/colour) + a large pass/fail
  badge + total duration. Any red engine → red card (`deriveJourneyStatus`, worst-wins).
- **Provenance bar** (mono): `run #<id>` → `ci_run_url`, short sha (full on hover via `title`),
  workflow/job, timestamp, `sha256:<12>…`, `trace.zip ↓` → served trace.
- **Left (~58%, sticky):** the embedded `<video controls preload=metadata>` (served file, frame 0 as
  poster via preload), with a marker rail beneath aligned to the video duration — one marker per step
  with a known offset, click-to-seek.
- **Right (~42%):** the ordered step list — each step = status dot + label (+ screen when present) +
  its assertions as ticked sub-items (green ✓). A failed step is red-outlined; a failed assertion is
  struck against its `actual`. Clicking a step seeks the video.
- **Flaky:** amber badge "flaky · passed on retry N". **UNVERIFIED:** dashed border, greyed video
  area with "UNVERIFIED — no run", no steps, structurally cannot show a PASS.

Emits `data-seek` (ms) on steps/markers only when the offset is known, and `data-fail-seek` on the
card for the first failing step. All product-agnostic; renders only `Journey` fields.

### 4. Template (`engine/template.html`)
- New CSS for the two-column card, sticky video, marker rail, step list, assertion sub-items, and the
  states — all on the existing tokens (`--pass/--fail/--pend/--warn/--mono`), light + dark, and a
  narrow breakpoint that stacks the columns (video on top, full width, markers kept; provenance bar
  always visible).
- A small generic client script: click a step/marker → seek; `timeupdate` → highlight the current
  step + marker; on load, a failed card auto-seeks to its failing step. Operates only on data
  attributes, degrades to a static (non-seeking) card with no JS.
- Remove the now-dead `.gallery`/`.view`/`.shot`/`.desk`/`.frame` CSS.

### 5. Gallery replacement + capture removal (`config/…/index.mjs`, `capture.mjs`, `src/generate.mjs`)
The two hand-authored `custom` prose sections ("Every screen" gallery + "Desktop layout") are the
last hand-authored captions on the page — exactly what Phase 3 exists to remove. They are deleted;
the full JourneyCards (real video per journey) carry the visual proof. The count/CI-pill/coverage
tiles stay above the journey list.

Deleting the gallery orphans the screenshot-capture pipeline (its only consumer), so it goes too:
`capture.mjs`, the `captureTarget` config export, the `captureWithPreview`/vite-preview helpers in
`generate.mjs`, the `images/` output dir, the unused `playwright` devDependency, and the workflow's
`playwright install chromium` step. The dashboard build no longer needs a browser or a preview server
— it ingests the e2e run's videos/traces and renders. **Reviewer note:** if the screen gallery is
wanted alongside the journey videos, this removal is the piece to veto.

## Verify
Run the e2e suite locally with the updated reporter (CI reporter array) on synthetic seed data to
produce fresh `journey-evidence.json` *with* step offsets, then run the generator against it and
confirm every card's steps/assertions/video/provenance come from that run. Screenshot desktop +
narrow. Synthetic data only.
