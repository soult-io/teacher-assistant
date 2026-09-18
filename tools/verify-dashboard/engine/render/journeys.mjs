// Minimal journey renderer (Phase 3a). Renders each Journey as a compact card:
// name + pass/fail badge + provenance bar + per-browser chips, with a dashed
// UNVERIFIED variant that structurally cannot show a green PASS. The full
// JourneyCard (embedded video, synced step list, assertion sub-items, failure/flaky
// detail) is Phase 3b — this proves the data path and the provenance/UNVERIFIED
// contract without the visual build. Product-agnostic: renders only Journey fields.

import { JOURNEY_STATUS } from "../model.mjs";
import { escapeHtml } from "./lib.mjs";

const BADGE = {
  [JOURNEY_STATUS.PASSED]: { cls: "pass", label: "passed" },
  [JOURNEY_STATUS.FAILED]: { cls: "fail", label: "failed" },
  [JOURNEY_STATUS.FLAKY]: { cls: "warn", label: "flaky" },
  [JOURNEY_STATUS.SKIPPED]: { cls: "note", label: "skipped" },
  [JOURNEY_STATUS.UNVERIFIED]: { cls: "unver", label: "unverified" },
};

function badge(status) {
  const b = BADGE[status] ?? BADGE[JOURNEY_STATUS.UNVERIFIED];
  return `<span class="jbadge ${b.cls}">${escapeHtml(b.label)}</span>`;
}

function browserChips(browsers) {
  if (browsers.length === 0) return "";
  const chips = browsers
    .map((b) => {
      const cls = BADGE[b.status]?.cls ?? "note";
      return `<span class="chip ${cls}"><span class="dot"></span>${escapeHtml(b.engine)}</span>`;
    })
    .join("");
  return `<div class="jchips">${chips}</div>`;
}

function provenanceBar(run) {
  if (!run) return "";
  const parts = [];
  const sha = run.commit_sha ? escapeHtml(run.commit_sha.slice(0, 7)) : "unknown";
  if (run.ci_run_id) {
    const id = escapeHtml(String(run.ci_run_id));
    parts.push(
      run.ci_run_url
        ? `<a href="${escapeHtml(run.ci_run_url)}" target="_blank" rel="noopener">run #${id}</a>`
        : `run #${id}`,
    );
  }
  parts.push(`<span title="${sha}">${sha}</span>`);
  parts.push(escapeHtml(`${run.workflow ?? "?"} / ${run.job ?? "?"}`));
  if (run.generated_at) parts.push(escapeHtml(run.generated_at));
  if (run.artifact_digest) parts.push(`sha256:${escapeHtml(run.artifact_digest.slice(0, 12))}…`);
  return `<div class="jprov mono">${parts.join('<span class="sep">·</span>')}</div>`;
}

function metaLine(journey) {
  if (journey.status === JOURNEY_STATUS.UNVERIFIED) {
    return `<div class="jmeta unver">UNVERIFIED — no matching run</div>`;
  }
  const stepCount = journey.steps.length;
  const assertionCount = journey.steps.reduce((n, s) => n + s.assertions.length, 0);
  const bits = [`${stepCount} step${stepCount === 1 ? "" : "s"}`, `${assertionCount} assertions`];
  if (journey.trace_url) {
    bits.push(
      `<a href="${escapeHtml(journey.trace_url)}" target="_blank" rel="noopener">trace.zip ↓</a>`,
    );
  }
  return `<div class="jmeta mono">${bits.join('<span class="sep">·</span>')}</div>`;
}

/** Render one journey card. */
export function renderJourneyCard(journey) {
  const unver = journey.status === JOURNEY_STATUS.UNVERIFIED ? " unverified" : "";
  return `<article class="jcard j-${escapeHtml(journey.status)}${unver}">
        <header class="jhead">
          <h3>${escapeHtml(journey.name)}</h3>
          ${badge(journey.status)}
        </header>
        ${provenanceBar(journey.run)}
        ${browserChips(journey.browsers)}
        ${metaLine(journey)}
      </article>`;
}

/** Render the ordered journey list. */
export function renderJourneyList(journeys) {
  if (journeys.length === 0) return `<p class="jempty">No journeys configured.</p>`;
  return `<div class="jlist">
      ${journeys.map(renderJourneyCard).join("\n      ")}
    </div>`;
}
