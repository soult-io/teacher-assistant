// Ingest: journey-evidence.json (+ a per-product manifest + run provenance) → the
// product-agnostic Journey[] the renderers consume. Nothing here knows the product;
// the manifest decides which tests are journeys, their order, and their display names.

import { basename } from "node:path";
import { EVIDENCE_SCHEMA, EVIDENCE_SCHEMA_V1 } from "./evidence-schema.mjs";
import { assertJourney, deriveJourneyStatus, makeUnverified, mapTestStatus } from "./model.mjs";

// Which browser's step tree + video stand in for the journey. Both browsers run the
// same steps, so a stable preference keeps the canonical view deterministic.
const CANONICAL_ENGINES = ["chromium", "firefox"];

/**
 * Parse + validate the evidence file. Loud on anything unparseable or off-schema —
 * the generator's ethos is loud failure over a silently empty board.
 * @param {string} text
 */
export function parseEvidence(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`journey-evidence is not valid JSON: ${err.message}`);
  }
  const schema = data?.schema;
  if (schema !== EVIDENCE_SCHEMA && schema !== EVIDENCE_SCHEMA_V1) {
    throw new Error(
      `journey-evidence schema mismatch: expected ${EVIDENCE_SCHEMA} (or ${EVIDENCE_SCHEMA_V1}), got ${JSON.stringify(schema)}`,
    );
  }
  if (!Array.isArray(data.tests)) {
    throw new Error("journey-evidence has no tests array");
  }
  for (const test of data.tests) {
    for (const step of test.steps ?? []) {
      if (schema === EVIDENCE_SCHEMA_V1) step.screenshot = null;
      else assertStillField(step, test);
    }
  }
  return data;
}

/**
 * v2 makes `screenshot` a required step field: a still record or an explicit null. A
 * missing or malformed field is a reporter bug — fail loud rather than read it as
 * "no still" and silently drop evidence the run produced.
 */
function assertStillField(step, test) {
  const where = `${test.project}/${test.title} step ${JSON.stringify(step.label)}`;
  if (!("screenshot" in step)) {
    throw new Error(`journey-evidence ${where} has no screenshot field (required in v2)`);
  }
  const still = step.screenshot;
  if (still === null) return;
  if (typeof still !== "object" || typeof still.path !== "string" || still.path === "") {
    throw new Error(
      `journey-evidence ${where} has a malformed screenshot: ${JSON.stringify(still)}`,
    );
  }
}

/**
 * A manifest entry maps to exactly ONE test (each test → a journey). If a file-only
 * match resolves to several distinct test titles, first-wins would silently drop a
 * failing sibling and show a false PASS — so fail loud and demand a disambiguating title.
 */
function assertSingleTest(entry, records) {
  const titles = new Set(records.map((r) => r.title));
  if (titles.size > 1) {
    throw new Error(
      `manifest entry ${entry.id} matched ${titles.size} tests in ${entry.match.file} ` +
        `(${[...titles].join(" | ")}) — add a title to disambiguate`,
    );
  }
}

/** Records (across browsers) whose file basename + title match a manifest entry. */
function matchRecords(records, entry) {
  const wantFile = entry.match.file;
  const wantTitle = entry.match.title;
  return records.filter((r) => {
    if (basename(r.file) !== wantFile) return false;
    if (wantTitle && !r.title.includes(wantTitle)) return false;
    return true;
  });
}

/** One record per browser (first wins on a duplicate), stable-sorted by engine. */
function oneRecordPerEngine(records) {
  const byEngine = new Map();
  for (const r of records) {
    if (!byEngine.has(r.project)) byEngine.set(r.project, r);
  }
  return [...byEngine.values()].sort((a, b) =>
    a.project < b.project ? -1 : a.project > b.project ? 1 : 0,
  );
}

/**
 * Choose the browser whose video + steps stand in for the journey. It must MATCH the
 * card's aggregate badge, or the video could contradict the verdict — a failed card
 * (one red engine) must not show a passing sibling's green video. So prefer a browser
 * whose own status equals the journey's worst-wins status, chromium-first within that
 * set; fall back to chromium-first overall. Per-browser status stays visible in chips.
 * @param {object[]} records one per engine
 * @param {string} journeyStatus the derived worst-wins status
 */
function pickCanonical(records, journeyStatus) {
  const matching = records.filter((r) => mapTestStatus(r) === journeyStatus);
  const pool = matching.length > 0 ? matching : records;
  for (const engine of CANONICAL_ENGINES) {
    const hit = pool.find((r) => r.project === engine);
    if (hit) return hit;
  }
  return pool[0];
}

function findAttachment(record, name) {
  return record.attachments.find((a) => a.name === name && a.path) ?? null;
}

/**
 * @param {object} record the canonical browser's test record
 * @param {(stillPath: string, index: number) => (string|null)} resolveStill
 */
function toSteps(record, resolveStill) {
  return record.steps.map((step, index) => ({
    index,
    label: step.label,
    status: step.status ?? "passed",
    screen: null,
    // Offset into the recording, when the reporter emitted it. Pre-3b evidence has no
    // offset → null, and the renderer degrades to a non-seekable list (never a guess).
    t_start_ms: typeof step.startOffsetMs === "number" ? step.startOffsetMs : null,
    thumbnail: null,
    // The still the run took at the end of this step, as a served path — or null when
    // that browser took none (stills come from the canonical browser's own record, so
    // they always match the steps shown) or the file could not be served. Never a
    // placeholder, never a neighbour's still.
    screenshot: step.screenshot?.path ? resolveStill(step.screenshot.path, index) : null,
    assertions: step.assertions.map((a) => ({
      text: a.text,
      status: a.status,
      actual: a.detail ?? null,
    })),
  }));
}

/**
 * Build one journey from the browser records that matched a manifest entry.
 * @param {object} entry manifest entry {id, name, match}
 * @param {object[]} records matched, one per engine
 * @param {string} product
 * @param {object} provenance shared run provenance
 * @param {(rawPath:string, kind:string, journeyId:string, engine:string, index?:number)=>(string|null)} resolveAsset
 */
function buildJourney(entry, records, product, provenance, resolveAsset) {
  assertSingleTest(entry, records);
  const perEngine = oneRecordPerEngine(records);
  const browsers = perEngine.map((r) => ({
    engine: r.project,
    status: mapTestStatus(r),
    duration_ms: r.durationMs,
    retries: r.retries ?? 0,
  }));
  const status = deriveJourneyStatus(browsers);
  const canonical = pickCanonical(perEngine, status);
  const videoAtt = findAttachment(canonical, "video");
  const traceAtt = findAttachment(canonical, "trace");
  const videoSrc = videoAtt
    ? resolveAsset(videoAtt.path, "video", entry.id, canonical.project)
    : null;
  const traceUrl = traceAtt
    ? resolveAsset(traceAtt.path, "trace", entry.id, canonical.project)
    : null;

  return {
    id: entry.id,
    name: entry.name,
    product,
    status,
    browsers,
    duration_ms: Math.max(...browsers.map((b) => b.duration_ms ?? 0)),
    run: provenance,
    video: videoSrc ? { src: videoSrc, poster: null, duration_ms: canonical.durationMs } : null,
    trace_url: traceUrl,
    steps: toSteps(canonical, (stillPath, index) =>
      resolveAsset(stillPath, "still", entry.id, canonical.project, index),
    ),
  };
}

/**
 * Map the manifest (in order) onto the evidence records → Journey[]. A manifest
 * entry with no matching record renders UNVERIFIED. `resolveAsset` maps a raw CI
 * attachment path to a served path (injected so ingest stays I/O-free + testable).
 * @param {{evidence: object, manifest: object[], product: string, provenance: object,
 *   resolveAsset?: Function}} args
 */
export function buildJourneys({ evidence, manifest, product, provenance, resolveAsset }) {
  const resolve = resolveAsset ?? (() => null);
  // With no real run id there is nothing to bind a PASS to, so no journey can be
  // verified regardless of the evidence present ("provenance or nothing").
  const bound = Boolean(provenance?.ci_run_id);
  const records = evidence.tests;
  return manifest.map((entry) => {
    const matched = bound ? matchRecords(records, entry) : [];
    const journey =
      matched.length === 0
        ? makeUnverified(entry, product)
        : buildJourney(entry, matched, product, provenance, resolve);
    return assertJourney(journey);
  });
}
