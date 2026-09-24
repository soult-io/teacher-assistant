// The full JourneyCard renderer (Phase 3b). Each journey renders as two coordinated
// columns in one card: the human-pace walkthrough video (left, sticky; Phase 3c —
// the fast gating video is only a raw-evidence link) with a step-marker rail,
// and the ordered step list with assertion sub-items (right). Header carries the name,
// per-browser chips, the aggregate pass/fail badge and total duration; a mono
// provenance bar binds the card to the exact CI run. Failure, flaky and UNVERIFIED are
// distinct visual states; UNVERIFIED is structurally incapable of a green PASS.
//
// Product-agnostic: renders ONLY Journey fields (model.mjs). Nothing here knows the
// product — labels and assertion text come from the run's evidence, never hand-typed.
// The video↔step sync (seek on click, auto-highlight while playing, auto-seek to a
// failure) is driven by the generic client script in template.html via the data-*
// attributes emitted here; with no JS the card is a static, readable list.

import { JOURNEY_STATUS, MEDIA_NOTE } from "../model.mjs";
import { escapeHtml, formatDuration } from "./lib.mjs";

const BADGE = {
  [JOURNEY_STATUS.PASSED]: { cls: "pass", label: "passed" },
  [JOURNEY_STATUS.FAILED]: { cls: "fail", label: "failed" },
  [JOURNEY_STATUS.FLAKY]: { cls: "warn", label: "flaky" },
  [JOURNEY_STATUS.SKIPPED]: { cls: "note", label: "skipped" },
  [JOURNEY_STATUS.UNVERIFIED]: { cls: "unver", label: "unverified" },
};

function statusClass(status) {
  return BADGE[status]?.cls ?? "unver";
}

/** The big header badge. Flaky spells out the retry it finally passed on. */
function badge(journey) {
  const b = BADGE[journey.status] ?? BADGE[JOURNEY_STATUS.UNVERIFIED];
  let label = b.label;
  if (journey.status === JOURNEY_STATUS.FLAKY) {
    const retries = Math.max(0, ...journey.browsers.map((br) => br.retries ?? 0));
    if (retries > 0) label = `flaky · passed on retry ${retries}`;
  }
  return `<span class="jbadge ${b.cls}">${escapeHtml(label)}</span>`;
}

function browserChips(browsers) {
  if (browsers.length === 0) return "";
  const chips = browsers
    .map((b) => {
      const cls = statusClass(b.status);
      const title = `${b.engine}: ${BADGE[b.status]?.label ?? b.status}`;
      return `<span class="chip ${cls}" title="${escapeHtml(title)}"><span class="dot"></span>${escapeHtml(b.engine)}</span>`;
    })
    .join("");
  return `<div class="jchips">${chips}</div>`;
}

// Raw evidence links on the provenance bar: the gating run's trace and its fast video.
// The fast video lives here only — it is never the card's media.
function rawEvidenceLinks(journey) {
  const links = [];
  if (journey.trace_url) {
    links.push(`<a href="${escapeHtml(journey.trace_url)}" download>trace.zip</a>`);
  }
  if (journey.raw_video_url) {
    links.push(
      `<a href="${escapeHtml(journey.raw_video_url)}" target="_blank" rel="noopener" title="the gating run's own recording, at machine speed">gating video</a>`,
    );
  }
  return links;
}

function provenanceBar(journey) {
  const run = journey.run;
  if (!run) return "";
  const parts = [];
  const sha = run.commit_sha ? escapeHtml(run.commit_sha.slice(0, 7)) : "unknown";
  const fullSha = run.commit_sha ? escapeHtml(run.commit_sha) : "unknown";
  if (run.ci_run_id) {
    const id = escapeHtml(String(run.ci_run_id));
    parts.push(
      run.ci_run_url
        ? `<a href="${escapeHtml(run.ci_run_url)}" target="_blank" rel="noopener">run #${id}</a>`
        : `run #${id}`,
    );
  }
  parts.push(`<span class="sha" title="${fullSha}">${sha}</span>`);
  parts.push(escapeHtml(`${run.workflow ?? "?"} / ${run.job ?? "?"}`));
  if (run.generated_at) parts.push(escapeHtml(run.generated_at));
  if (run.artifact_digest) {
    parts.push(
      `<span title="sha256:${escapeHtml(run.artifact_digest)}">sha256:${escapeHtml(run.artifact_digest.slice(0, 12))}…</span>`,
    );
  }
  parts.push(...rawEvidenceLinks(journey));
  return `<div class="jprov mono">${parts.join('<span class="sep">·</span>')}</div>`;
}

// Percentage position of an offset within the recording, clamped to [0,100].
function markerLeft(offsetMs, durationMs) {
  if (!durationMs || durationMs <= 0) return null;
  const pct = (offsetMs / durationMs) * 100;
  return Math.max(0, Math.min(100, pct));
}

// The marker rail beneath the video: one marker per step with a known offset, aligned
// to the video duration, click-to-seek. Skipped entirely when no offsets are known
// (pre-3b evidence) — no rail rather than a row of markers stacked at zero.
function markerRail(journey) {
  const duration = journey.video?.duration_ms;
  const marks = journey.steps
    .filter((s) => typeof s.t_start_ms === "number")
    .map((s) => ({ ...s, left: markerLeft(s.t_start_ms, duration) }))
    .filter((s) => s.left !== null);
  if (marks.length === 0) return "";
  const buttons = marks
    .map((s) => {
      const cls = s.status === "failed" ? "jmark fail" : "jmark";
      const label = `Seek to step ${s.index + 1}: ${s.label}`;
      return `<button type="button" class="${cls}" data-seek="${s.t_start_ms}" style="left:${s.left.toFixed(2)}%" title="${escapeHtml(s.label)}" aria-label="${escapeHtml(label)}"></button>`;
    })
    .join("");
  return `<div class="jrail" role="presentation">${buttons}</div>`;
}

// Names the video as its own recording — a separate human-pace run of the same commit,
// not the gating run's capture — and links that run.
function recordingLabel(video) {
  const id = video.run_id ? escapeHtml(String(video.run_id)) : null;
  const run = id
    ? video.run_url
      ? `<a href="${escapeHtml(video.run_url)}" target="_blank" rel="noopener">run #${id}</a>`
      : `run #${id}`
    : "run unknown";
  return `<div class="jreclabel mono">walkthrough · ${run}</div>`;
}

// The left column: the walkthrough video + marker rail, or a plain panel saying why
// there is none. UNVERIFIED and any journey without a bound walkthrough show a greyed,
// label-only area — never the fast gating video, never a frame that could read as a
// passing run.
function videoColumn(journey) {
  if (journey.status === JOURNEY_STATUS.UNVERIFIED) {
    return `<div class="jvideo"><div class="jnovideo unver">UNVERIFIED — no run</div></div>`;
  }
  if (!journey.video?.src) {
    const note = journey.media_note ?? MEDIA_NOTE.NONE;
    return `<div class="jvideo"><div class="jnovideo">${escapeHtml(note)}</div></div>`;
  }
  const src = escapeHtml(journey.video.src);
  return `<div class="jvideo">
          ${recordingLabel(journey.video)}
          <video class="jvid" data-video controls playsinline preload="metadata" src="${src}"></video>
          ${markerRail(journey)}
        </div>`;
}

function assertionItem(a) {
  if (a.status === "failed") {
    const actual = a.actual ? ` <span class="actual mono">→ ${escapeHtml(a.actual)}</span>` : "";
    return `<li class="fail"><span class="mk">✗</span><s>${escapeHtml(a.text)}</s>${actual}</li>`;
  }
  return `<li class="pass"><span class="mk">✓</span>${escapeHtml(a.text)}</li>`;
}

function stepItem(step) {
  const failed = step.status === "failed";
  const seekable = typeof step.t_start_ms === "number";
  const cls = `jstep${failed ? " fail" : ""}`;
  const dataStep = ` data-step="${step.index}"`;
  const screen = step.screen ? `<span class="sscreen">${escapeHtml(step.screen)}</span>` : "";
  const label = `<span class="slabel">${escapeHtml(step.label)}${screen}</span>`;
  // A seekable step's header is a real button (native keyboard + focus); otherwise a
  // plain row. The status dot + label are the click target that seeks the video.
  const head = seekable
    ? `<button type="button" class="jstep-hd" data-seek="${step.t_start_ms}"><span class="sdot"></span>${label}</button>`
    : `<div class="jstep-hd"><span class="sdot"></span>${label}</div>`;
  const asserts =
    step.assertions.length > 0
      ? `<ul class="jasserts">${step.assertions.map(assertionItem).join("")}</ul>`
      : "";
  return `<li class="${cls}"${dataStep}>${head}${asserts}</li>`;
}

function stepColumn(journey) {
  if (journey.status === JOURNEY_STATUS.UNVERIFIED) {
    return `<div class="jsteps-wrap"><p class="jsteps-empty unver">No steps — this journey has no run to bind to.</p></div>`;
  }
  if (journey.steps.length === 0) {
    return `<div class="jsteps-wrap"><p class="jsteps-empty">No steps recorded for this run.</p></div>`;
  }
  return `<div class="jsteps-wrap"><ol class="jsteps">${journey.steps.map(stepItem).join("")}</ol></div>`;
}

// The offset of the first failing step, so a failed card can auto-seek its video to
// the failure on load. Null when no failing step carries an offset.
function failSeek(journey) {
  const failing = journey.steps.find(
    (s) => s.status === "failed" && typeof s.t_start_ms === "number",
  );
  return failing ? failing.t_start_ms : null;
}

/** Render one full journey card. */
export function renderJourneyCard(journey) {
  const unver = journey.status === JOURNEY_STATUS.UNVERIFIED ? " unverified" : "";
  const fseek = failSeek(journey);
  const failAttr = fseek !== null ? ` data-fail-seek="${fseek}"` : "";
  const duration =
    journey.status === JOURNEY_STATUS.UNVERIFIED
      ? ""
      : `<span class="jdur mono">${escapeHtml(formatDuration(journey.duration_ms))}</span>`;
  return `<article class="jcard j-${escapeHtml(journey.status)}${unver}" data-journey="${escapeHtml(journey.id)}"${failAttr}>
        <header class="jhead">
          <div class="jtitle">
            <h3>${escapeHtml(journey.name)}</h3>
            ${browserChips(journey.browsers)}
          </div>
          <div class="jverdict">
            ${badge(journey)}
            ${duration}
          </div>
        </header>
        ${provenanceBar(journey)}
        <div class="jbody">
          ${videoColumn(journey)}
          ${stepColumn(journey)}
        </div>
      </article>`;
}

/** Render the ordered journey list. */
export function renderJourneyList(journeys) {
  if (journeys.length === 0) return `<p class="jempty">No journeys configured.</p>`;
  return `<div class="jlist">
      ${journeys.map(renderJourneyCard).join("\n      ")}
    </div>`;
}
