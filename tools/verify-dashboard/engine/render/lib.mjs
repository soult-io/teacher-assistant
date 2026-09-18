// Pure, product-agnostic HTML builders. No I/O and no product vocabulary — every
// function takes plain data (numbers, labels supplied by config) and returns a
// trusted HTML string, so the page is unit-testable without a browser or network.
// The impure parts (running vitest, the GitHub API, Playwright) live in the sibling
// engine modules and feed their results through these.

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

/** Map a GitHub Actions conclusion to the pill's CSS class. */
export function pillClass(conclusion) {
  if (conclusion === "success") return "pass";
  if (conclusion === "failure") return "fail";
  return "note";
}

/** Render the "CI on main" status pills from a normalised list. */
export function renderCiPills(pills) {
  return pills
    .map(
      (p) =>
        `<span class="pill ${pillClass(p.conclusion)}"><span class="dot"></span>${escapeHtml(p.label)}</span>`,
    )
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
