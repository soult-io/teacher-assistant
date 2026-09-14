// Pure builders for the TRACK Verification dashboard. No I/O — every function
// here takes plain data and returns strings/objects, so the numbers, bars, and
// pills on the published page are unit-testable without a browser or a network.
// The impure parts (running vitest, the GitHub API, Playwright) live in the
// sibling modules and feed their results through these.

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
 * Reduce one package's vitest JSON report to the two figures the board shows.
 * `numPassedTests` is the pass count; `testResults.length` is the number of
 * test FILES (the jest-compatible `numTotalTestSuites` counts describe blocks,
 * not files, so it is deliberately not used).
 */
export function parseVitestReport(report) {
  const pass = Number.isFinite(report?.numPassedTests) ? report.numPassedTests : 0;
  const files = Array.isArray(report?.testResults) ? report.testResults.length : 0;
  return { pass, files };
}

/** Sum the per-package figures into the headline totals. */
export function aggregate(packages) {
  const unitTotal = packages.reduce((sum, p) => sum + p.pass, 0);
  const fileTotal = packages.reduce((sum, p) => sum + p.files, 0);
  return { unitTotal, fileTotal, pkgCount: packages.length };
}

/**
 * Render the per-package test bars. `packages` is expected pre-sorted
 * (descending pass count); bar width is relative to the largest count so the
 * leading package fills the track.
 */
export function renderBars(packages) {
  const max = Math.max(1, ...packages.map((p) => p.pass));
  return packages
    .map((p) => {
      const width = Math.round((p.pass / max) * 100);
      const cls = p.barClass ? ` ${p.barClass}` : "";
      const name = `${escapeHtml(p.label)}<span>${escapeHtml(p.sub)}</span>`;
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
 * Substitute `{{TOKEN}}` placeholders in the template. Values are inserted
 * verbatim — HTML-valued tokens (bars, pills) are pre-built trusted strings, and
 * text tokens are escaped by the caller. An unknown token is left in place so a
 * typo is visible on the page rather than silently blanked.
 */
export function fillTemplate(template, tokens) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(tokens, key) ? String(tokens[key]) : match,
  );
}
