// Pure, product-agnostic HTML builders. No I/O and no product vocabulary — every
// function takes plain data (numbers, labels supplied by config) and returns a
// trusted HTML string, so the page is unit-testable without a browser or network.
// The impure parts (running vitest, the GitHub API, Playwright) live in the sibling
// engine modules and feed their results through these.

import { NO_RUN, UNKNOWN } from "../ci-status.mjs";

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Escape the four HTML-significant characters in a text value. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Human-readable duration from milliseconds: "820ms", "4.2s", "1m 03s". Null/negative
 * inputs render as an em dash so a card never shows a bare "0ms" for a missing value.
 */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Sum per-package figures into the headline totals. */
export function aggregate(packages) {
  const unitTotal = packages.reduce((sum, p) => sum + p.pass, 0);
  const fileTotal = packages.reduce((sum, p) => sum + p.files, 0);
  return { unitTotal, fileTotal, pkgCount: packages.length };
}

/**
 * Render the per-package test bars. `packages` is expected pre-sorted (descending
 * pass count); bar width is relative to the largest count so the leader fills the
 * track. Labels/subs come from config, so this stays product-agnostic.
 */
export function renderBars(packages) {
  const max = Math.max(1, ...packages.map((p) => p.pass));
  return packages
    .map((p) => {
      const width = Math.round((p.pass / max) * 100);
      const cls = p.barClass ? ` ${p.barClass}` : "";
      const name = `${escapeHtml(p.label)}<span>${escapeHtml(p.sub ?? "")}</span>`;
      const track = `<div class="track"><i style="width:${width}%"></i></div>`;
      return `<div class="barrow${cls}"><div class="name">${name}</div>${track}<div class="val tnum">${p.pass}</div></div>`;
    })
    .join("\n      ");
}

/**
 * Map a GitHub Actions conclusion to the pill's CSS class. The two non-verdicts get
 * their own neutral classes so a reader can tell them apart: `none` (no run exists for
 * the commit) and `unk` (status could not be determined — see ci-status.mjs). Neither
 * is ever green.
 */
export function pillClass(conclusion) {
  if (conclusion === "success") return "pass";
  if (conclusion === "failure") return "fail";
  if (conclusion === NO_RUN) return "none";
  if (conclusion === UNKNOWN) return "unk";
  return "note";
}

/**
 * The visible qualifier (and tooltip) for a pill that is not a settled verdict. The
 * page is static, generated once: an in-progress pill says it was in progress AT
 * BUILD TIME, so it is never read as live.
 */
function pillQualifier(conclusion, builtAt) {
  if (conclusion === "in_progress") {
    return {
      text: `in progress at build time ${builtAt}`,
      title: `This run had not finished when the page was generated (${builtAt}). The page is static and does not update.`,
    };
  }
  if (conclusion === NO_RUN) {
    return {
      text: "no run for this commit",
      title:
        "No push run of this workflow exists for this commit. Another commit's run is never shown.",
    };
  }
  if (conclusion === UNKNOWN) {
    return {
      text: "status unknown",
      title: `CI status could not be determined at build time (${builtAt}): the GitHub API could not be read, or the run had no matching job or no conclusion.`,
    };
  }
  return null;
}

/**
 * Render the CI status pills for the dashboard's commit from a normalised list.
 * `builtAt` is the ISO time the page was generated, shown on non-final pills.
 */
export function renderCiPills(pills, { builtAt }) {
  return pills
    .map((p) => {
      const q = pillQualifier(p.conclusion, builtAt);
      const title = q ? ` title="${escapeHtml(q.title)}"` : "";
      const qual = q ? ` <span class="q">· ${escapeHtml(q.text)}</span>` : "";
      return `<span class="pill ${pillClass(p.conclusion)}"${title}><span class="dot"></span>${escapeHtml(p.label)}${qual}</span>`;
    })
    .join("\n    ");
}

/**
 * Render the summary tiles. `tiles` is [{value, label, variant?}] — the values are
 * computed by the engine mechanics, the labels are supplied by config.
 */
export function renderTiles(tiles) {
  return tiles
    .map((t) => {
      const variant = t.variant ? ` ${t.variant}` : "";
      return `<div class="tile${variant}"><div class="n tnum">${escapeHtml(t.value)}</div><div class="t">${escapeHtml(t.label)}</div></div>`;
    })
    .join("\n      ");
}

/**
 * Render the callout cards. `callouts` is [{kind, heading, html}] — kind "info" tints
 * the left border; `html` is a pre-built trusted string (product prose from config).
 */
export function renderCallouts(callouts) {
  return callouts
    .map((c) => {
      const cls = c.kind === "info" ? " info" : "";
      return `<div class="callout${cls}"><h4>${escapeHtml(c.heading)}</h4><p>${c.html}</p></div>`;
    })
    .join("\n      ");
}

/** Wrap a section body with the shared section header (title + optional meta). */
export function renderSection({ title, meta, body }) {
  const metaHtml = meta ? `<span class="k">${escapeHtml(meta)}</span>` : "";
  return `<section>
    <div class="sechead"><h2>${escapeHtml(title)}</h2>${metaHtml}</div>
    ${body}
  </section>`;
}

/**
 * Substitute `{{TOKEN}}` placeholders. Values are inserted verbatim — HTML-valued
 * tokens are pre-built trusted strings; text tokens are escaped by the caller. An
 * unknown token is left in place so a typo is visible on the page, not silently blanked.
 */
export function fillTemplate(template, tokens) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(tokens, key) ? String(tokens[key]) : match,
  );
}
