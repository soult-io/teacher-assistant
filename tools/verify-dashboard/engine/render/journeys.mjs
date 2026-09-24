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
//
// Step screens (Phase 3c): the run's per-step stills are hidden until asked for. With
// JS the media column gets a Video | Screens pair of views that share the step list
// (Screens is a one-still-at-a-time viewer the client script fills on demand); with no
// JS each step carries a link that opens its still. No still is fetched until asked for. The Video view exists only
// when the card has a walkthrough; a failed card opens on its failing step's still.

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

// The walkthrough video + marker rail. `pane` adds the tab-panel wiring when the card
// also has a Screens view.
function videoPane(journey, pane = "") {
  const src = escapeHtml(journey.video.src);
  return `<div class="jvideo"${pane}>
          ${recordingLabel(journey.video)}
          <video class="jvid" data-video controls playsinline preload="metadata" src="${src}"></video>
          ${markerRail(journey)}
        </div>`;
}

// Why a card with steps has no stills to show: none were taken, or they were taken by
// a browser whose run is not the one the steps come from (stills are never grafted
// onto another browser's steps).
function noStillsNote(journey) {
  if (journey.steps.length === 0) return "";
  const elsewhere = journey.unshown_still_engines ?? [];
  const text =
    elsewhere.length > 0 && journey.steps_engine
      ? `no step screens from ${journey.steps_engine}, whose run these steps are from — screens exist for ${elsewhere.join(", ")}`
      : "no step screens in this run's evidence";
  return `<p class="jnoshots mono">${escapeHtml(text)}</p>`;
}

// The left column: the walkthrough video + marker rail, or a plain panel saying why
// there is none — plus, when the run has step stills, the Video | Screens views.
// UNVERIFIED and any journey without a bound walkthrough show a greyed, label-only
// area — never the fast gating video, never a frame that could read as a passing run.
function mediaColumn(journey, screens) {
  if (journey.status === JOURNEY_STATUS.UNVERIFIED) {
    return `<div class="jvideo"><div class="jnovideo unver">UNVERIFIED — no run</div></div>`;
  }
  const hasVideo = Boolean(journey.video?.src);
  if (!screens) {
    const media = hasVideo
      ? videoPane(journey)
      : `<div class="jvideo"><div class="jnovideo">${escapeHtml(journey.media_note ?? MEDIA_NOTE.NONE)}</div></div>`;
    const note = noStillsNote(journey);
    return note ? `<div class="jmedia">${media}${note}</div>` : media;
  }
  return screensMedia(journey, screens, hasVideo);
}

function assertionItem(a) {
  if (a.status === "failed") {
    const actual = a.actual ? ` <span class="actual mono">→ ${escapeHtml(a.actual)}</span>` : "";
    return `<li class="fail"><span class="mk">✗</span><s>${escapeHtml(a.text)}</s>${actual}</li>`;
  }
  return `<li class="pass"><span class="mk">✓</span>${escapeHtml(a.text)}</li>`;
}

// A step's still as it will be shown, from the Journey step — or null.
function stillOf(step, src, total) {
  if (!src) return null;
  const failed = step.status === "failed";
  return {
    src,
    width: step.screenshot_width ?? null,
    height: step.screenshot_height ?? null,
    truncated: step.screenshot_truncated === true,
    alt: `Screen for step ${step.index + 1} of ${total}: ${step.label}${failed ? " (failed)" : ""}`,
  };
}

// The no-JS form of a step's still: a link that opens it. Not an inline <img>: with
// scripting off, browsers ignore loading="lazy" (and a closed <details> does not stop
// the fetch), so an inline image would pull every still on page load.
function stillLink(step, still, screens) {
  const src = escapeHtml(still.src);
  const text = step.status === "failed" ? "View failure screen" : "Screen";
  const meta = [screens.engine];
  if (still.width && still.height) meta.push(`${still.width}×${still.height}`);
  if (still.truncated) meta.push("truncated at capture limit");
  const tail = meta
    .filter(Boolean)
    .map((m) => ` · ${escapeHtml(m)}`)
    .join("");
  return `<p class="jshot mono"><a href="${src}" target="_blank" rel="noopener" aria-label="${escapeHtml(still.alt)} (opens the image)">${text} ↗</a>${tail}</p>`;
}

// The still-related data + markup for one step (empty when the card has no stills).
function stepStill(step, screens) {
  if (!screens) return { attrs: "", body: "" };
  const still = screens.stills[step.index];
  if (!still) {
    return { attrs: "", body: `<p class="jnoshot-inline mono">no screen captured</p>` };
  }
  let attrs = ` data-shot-src="${escapeHtml(still.src)}"`;
  if (still.width && still.height) {
    attrs += ` data-shot-w="${still.width}" data-shot-h="${still.height}"`;
  }
  if (still.truncated) attrs += " data-shot-trunc";
  // The JS form of "show me the failure": the disclosure is hidden once JS runs.
  const failBtn =
    step.status === "failed"
      ? `<button type="button" class="jfailbtn" hidden>View failure screen</button>`
      : "";
  return { attrs, body: `${failBtn}${stillLink(step, still, screens)}` };
}

function stepItem(step, screens) {
  const failed = step.status === "failed";
  const seekable = typeof step.t_start_ms === "number";
  const cls = `jstep${failed ? " fail" : ""}`;
  const dataStep = ` data-step="${step.index}"`;
  const screen = step.screen ? `<span class="sscreen">${escapeHtml(step.screen)}</span>` : "";
  const label = `<span class="slabel">${escapeHtml(step.label)}${screen}</span>`;
  // A seekable step's header is a real button (native keyboard + focus); so is every
  // step's on a card with stills (it selects the step in the Screens view). Otherwise
  // a plain row. The status dot + label are the click target.
  const seek = seekable ? ` data-seek="${step.t_start_ms}"` : "";
  const head =
    seekable || screens
      ? `<button type="button" class="jstep-hd"${seek}><span class="sdot"></span>${label}</button>`
      : `<div class="jstep-hd"><span class="sdot"></span>${label}</div>`;
  const asserts =
    step.assertions.length > 0
      ? `<ul class="jasserts">${step.assertions.map(assertionItem).join("")}</ul>`
      : "";
  const still = stepStill(step, screens);
  return `<li class="${cls}"${dataStep}${still.attrs}>${head}${asserts}${still.body}</li>`;
}

function stepColumn(journey, screens) {
  if (journey.status === JOURNEY_STATUS.UNVERIFIED) {
    return `<div class="jsteps-wrap"><p class="jsteps-empty unver">No steps — this journey has no run to bind to.</p></div>`;
  }
  if (journey.steps.length === 0) {
    return `<div class="jsteps-wrap"><p class="jsteps-empty">No steps recorded for this run.</p></div>`;
  }
  const items = journey.steps.map((step) => stepItem(step, screens)).join("");
  return `<div class="jsteps-wrap"><ol class="jsteps">${items}</ol></div>`;
}

// A still path is served next to the page: relative, no scheme, no parent segment. A
// path that is not (the evidence is untrusted data) is treated as no still at all.
function servedStillPath(src) {
  if (typeof src !== "string" || src === "") return null;
  if (src.startsWith("/") || src.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  if (src.split("/").includes("..")) return null;
  return src;
}

// An HTML-id-safe prefix, unique per card on the page (the list index keeps two
// journey ids that sanitise alike apart).
function cardDomId(journey, index) {
  return `jc${index}-${String(journey.id).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * Everything the step-screens UI needs for one card, or null when it has none: an
 * UNVERIFIED card never shows stills (whatever its input carries), and a card whose
 * run took no stills gets a one-line note instead of a viewer.
 */
function screensContext(journey, index) {
  if (journey.status === JOURNEY_STATUS.UNVERIFIED) return null;
  const total = journey.steps.length;
  const stills = journey.steps.map((step) =>
    stillOf(step, servedStillPath(step.screenshot), total),
  );
  const count = stills.filter(Boolean).length;
  if (count === 0) return null;
  const failStep = journey.steps.find((s) => s.status === "failed")?.index ?? null;
  const engine = journey.steps_engine ?? null;
  const retries = journey.browsers.find((b) => b.engine === engine)?.retries ?? 0;
  return { id: cardDomId(journey, index), total, stills, count, failStep, engine, retries };
}

// The media column of a card with stills: the Video | Screens views (Screens only when
// there is no walkthrough). The server renders the no-JS state — video visible, the
// tab row and viewer hidden; the client script reveals them and applies `data-view`.
function screensMedia(journey, screens, hasVideo) {
  const { id } = screens;
  // Failed cards open on the failure screen; passed cards with a walkthrough on Video.
  const view = screens.failStep !== null || !hasVideo ? "screens" : "video";
  const failMark =
    screens.failStep !== null ? `<span class="jfailmark" aria-hidden="true"></span>` : "";
  const source = screens.engine
    ? `<span class="jsrc mono">stills · ${escapeHtml(screens.engine)}</span>`
    : "";
  const count = `<span class="jcount mono">${screens.count}/${screens.total}</span>`;
  const head = hasVideo
    ? `<div class="jmodes" role="tablist" aria-label="Evidence view" hidden>
            <button type="button" role="tab" id="${id}-tab-v" aria-controls="${id}-pane-v" data-mode="video" aria-selected="true">Video</button>
            <button type="button" role="tab" id="${id}-tab-s" aria-controls="${id}-pane-s" data-mode="screens" aria-selected="false" tabindex="-1">Screens ${count}${failMark}</button>
            ${source}
          </div>`
    : `<div class="jmodes solo" hidden><span class="jsolo mono">Screens ${count}</span>${source}</div>`;
  const video = hasVideo
    ? videoPane(journey, ` id="${id}-pane-v" role="tabpanel" aria-labelledby="${id}-tab-v"`)
    : `<p class="jmnote mono">${escapeHtml(journey.media_note ?? MEDIA_NOTE.NONE)}</p>`;
  const panel = hasVideo
    ? ` role="tabpanel" aria-labelledby="${id}-tab-s"`
    : ` role="region" aria-label="Step screens"`;
  const flaky =
    journey.status === JOURNEY_STATUS.FLAKY && screens.retries > 0
      ? `<p class="jsnote warn mono">screens from the passing attempt (retry ${screens.retries})</p>`
      : "";
  const pips = journey.steps
    .map(
      (s) =>
        `<i class="${s.status === "failed" ? "fail" : ""}${screens.stills[s.index] ? "" : " none"}"></i>`,
    )
    .join("");
  return `<div class="jmedia" data-media data-view="${view}">
          ${head}
          ${video}
          <div class="jscreens" id="${id}-pane-s"${panel} hidden>
            ${flaky}
            <div class="jstage" tabindex="0" aria-roledescription="screen viewer" aria-label="Step screens. Left and right arrow keys move between steps; up and down scroll the screen."></div>
            <div class="jstepper">
              <button type="button" class="jprev" aria-label="Previous step">‹ Prev</button>
              <span class="jpos mono"></span>
              <button type="button" class="jnext" aria-label="Next step">Next ›</button>
            </div>
            <div class="jpips" aria-hidden="true">${pips}</div>
            <span class="jlive" aria-live="polite" aria-atomic="true"></span>
            <div class="jcap"></div>
          </div>
        </div>`;
}

// The offset of the first failing step, so a failed card can auto-seek its video to
// the failure on load. Null when no failing step carries an offset.
function failSeek(journey) {
  const failing = journey.steps.find(
    (s) => s.status === "failed" && typeof s.t_start_ms === "number",
  );
  return failing ? failing.t_start_ms : null;
}

/**
 * Render one full journey card.
 * @param {object} journey
 * @param {number} [index] the card's position on the page (keeps its element ids unique)
 */
export function renderJourneyCard(journey, index = 0) {
  const unver = journey.status === JOURNEY_STATUS.UNVERIFIED ? " unverified" : "";
  const fseek = failSeek(journey);
  const screens = screensContext(journey, index);
  let failAttr = fseek !== null ? ` data-fail-seek="${fseek}"` : "";
  if (screens?.failStep != null) failAttr += ` data-fail-step="${screens.failStep}"`;
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
          ${mediaColumn(journey, screens)}
          ${stepColumn(journey, screens)}
        </div>
      </article>`;
}

/** Render the ordered journey list. */
export function renderJourneyList(journeys) {
  if (journeys.length === 0) return `<p class="jempty">No journeys configured.</p>`;
  return `<div class="jlist">
      ${journeys.map((journey, index) => renderJourneyCard(journey, index)).join("\n      ")}
    </div>`;
}
