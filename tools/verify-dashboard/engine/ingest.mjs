// Ingest: journey-evidence.json (+ a per-product manifest + run provenance) → the
// product-agnostic Journey[] the renderers consume. Nothing here knows the product;
// the manifest decides which tests are journeys, their order, and their display names.

import { basename } from "node:path";
import { EVIDENCE_SCHEMA, EVIDENCE_SCHEMA_V1, EVIDENCE_SCHEMA_V2 } from "./evidence-schema.mjs";
import {
  assertJourney,
  deriveJourneyStatus,
  JOURNEY_STATUS,
  MEDIA_NOTE,
  makeUnverified,
  mapTestStatus,
  RECORDING,
} from "./model.mjs";

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
  if (![EVIDENCE_SCHEMA, EVIDENCE_SCHEMA_V2, EVIDENCE_SCHEMA_V1].includes(schema)) {
    throw new Error(
      `journey-evidence schema mismatch: expected ${EVIDENCE_SCHEMA} (or ${EVIDENCE_SCHEMA_V2}, ${EVIDENCE_SCHEMA_V1}), got ${JSON.stringify(schema)}`,
    );
  }
  if (!Array.isArray(data.tests)) {
    throw new Error("journey-evidence has no tests array");
  }
  for (const test of data.tests) {
    for (const step of test.steps ?? []) {
      if (schema === EVIDENCE_SCHEMA_V1) step.screenshot = null;
      else assertStillField(step, test, schema === EVIDENCE_SCHEMA);
    }
  }
  return data;
}

/**
 * Parse the human-pace walkthrough's evidence. Same schema as the gating file, but it
 * must say it is a walkthrough — a gating file passed here by mistake would put the
 * fast recording back on the card, which the walkthrough exists to replace.
 * @param {string} text
 */
export function parseWalkthroughEvidence(text) {
  const data = parseEvidence(text);
  if (data.mode !== "walkthrough") {
    throw new Error(
      `walkthrough evidence has mode ${JSON.stringify(data.mode)} — expected "walkthrough"`,
    );
  }
  return data;
}

/**
 * v2 makes `screenshot` a required step field: a still record or an explicit null. A
 * missing or malformed field is a reporter bug — fail loud rather than read it as
 * "no still" and silently drop evidence the run produced. v3 (`sized`) also requires
 * the still's pixel size and its `truncated` flag: a still with no flag could be a
 * silently cut-off screen, so it fails loud. A v2 still's flag is unknown (null).
 */
function assertStillField(step, test, sized) {
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
  if (!sized) {
    still.truncated = null;
    return;
  }
  const sizeOk = [still.width, still.height].every((n) => Number.isInteger(n) && n > 0);
  if (!sizeOk || typeof still.truncated !== "boolean") {
    throw new Error(
      `journey-evidence ${where} still has no valid width/height/truncated (required in v3): ${JSON.stringify(still)}`,
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

// Flaky is a pass that needed a retry; the walkthrough never retries, so it compares as a pass.
const foldFlaky = (status) => (status === JOURNEY_STATUS.FLAKY ? JOURNEY_STATUS.PASSED : status);

const sameLabels = (a, b) => a.length === b.length && a.every((s, i) => s.label === b[i].label);

/**
 * Bind the journey to its human-pace walkthrough recording, or say why not. The
 * walkthrough is only shown when it is provably of the same commit as the gating run,
 * agrees with the card's verdict, and walked the same steps — so its step offsets
 * line up with the list beside it. Anything else → no video and a note; the fast
 * gating recording is never substituted.
 * @param {object} entry manifest entry
 * @param {object} canonical the gating record the card's steps come from
 * @param {string} status the journey's derived status
 * @param {object} provenance the gating run's provenance
 * @param {{evidence: object, run: {ci_run_id: string|null, ci_run_url: string|null},
 *   resolveAsset: Function}|null} walkthrough
 * @returns {{video: object|null, offsets: (number|null)[]|null, note: string|null}}
 */
function bindWalkthrough(entry, canonical, status, provenance, walkthrough) {
  const none = (note) => ({ video: null, offsets: null, note });
  if (!walkthrough) return none(MEDIA_NOTE.NONE);
  const sha = walkthrough.evidence.commitSha;
  if (!sha || sha !== provenance.commit_sha) return none(MEDIA_NOTE.NONE);
  const matched = matchRecords(walkthrough.evidence.tests, entry);
  if (matched.length === 0) return none(MEDIA_NOTE.NONE);
  assertSingleTest(entry, matched);
  const record = matched[0];
  const walkStatus = mapTestStatus(record);
  if (walkStatus !== foldFlaky(status)) {
    return none(walkStatus === JOURNEY_STATUS.FAILED ? MEDIA_NOTE.FAILED : MEDIA_NOTE.DIFFERS);
  }
  if (!sameLabels(record.steps, canonical.steps)) return none(MEDIA_NOTE.DIFFERS);
  const att = findAttachment(record, "video");
  const src = att ? walkthrough.resolveAsset(att.path, "video", entry.id, record.project) : null;
  if (!src) return none(MEDIA_NOTE.NONE);
  return {
    video: {
      src,
      poster: null,
      duration_ms: record.durationMs,
      recording: RECORDING.WALKTHROUGH,
      run_id: walkthrough.run.ci_run_id,
      run_url: walkthrough.run.ci_run_url,
    },
    // Offsets into THIS recording, where the reporter emitted them (pre-3b: null).
    offsets: record.steps.map((s) =>
      typeof s.startOffsetMs === "number" ? s.startOffsetMs : null,
    ),
    note: null,
  };
}

/**
 * @param {object} record the canonical browser's test record
 * @param {(stillPath: string, index: number) => (string|null)} resolveStill
 * @param {(number|null)[]|null} offsets each step's offset into the card's video (the
 *   walkthrough), or null when the card has no video
 */
function toSteps(record, resolveStill, offsets) {
  return record.steps.map((step, index) => toStep(step, index, resolveStill, offsets));
}

function toStep(step, index, resolveStill, offsets) {
  const served = step.screenshot?.path ? resolveStill(step.screenshot.path, index) : null;
  return {
    index,
    label: step.label,
    status: step.status ?? "passed",
    screen: null,
    // Offset into the card's video (the walkthrough recording). No video → null, and
    // the renderer degrades to a non-seekable list (never a guess, never an offset
    // into a recording that is not on the card).
    t_start_ms: offsets?.[index] ?? null,
    thumbnail: null,
    // The still the run took at the end of this step, as a served path — or null when
    // that browser took none (stills come from the canonical browser's own record, so
    // they always match the steps shown) or the file could not be served. Never a
    // placeholder, never a neighbour's still.
    screenshot: served,
    // Whether that still is cut off at the height cap: true/false as the run recorded
    // it, null when there is no still or the run predates the record (v2) — unknown is
    // never shown as complete.
    screenshot_truncated: served ? (step.screenshot.truncated ?? null) : null,
    assertions: step.assertions.map((a) => ({
      text: a.text,
      status: a.status,
      actual: a.detail ?? null,
    })),
  };
}

/**
 * Build one journey from the browser records that matched a manifest entry.
 * @param {object} entry manifest entry {id, name, match}
 * @param {object[]} records matched, one per engine
 * @param {string} product
 * @param {object} provenance shared run provenance
 * @param {(rawPath:string, kind:string, journeyId:string, engine:string, index?:number)=>(string|null)} resolveAsset
 * @param {object|null} walkthrough see bindWalkthrough
 */
function buildJourney(entry, records, product, provenance, resolveAsset, walkthrough) {
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
  // The fast gating recording is raw evidence only (a link beside trace.zip), never
  // the card's video — at machine pace it cannot be watched.
  const rawVideoUrl = videoAtt
    ? resolveAsset(videoAtt.path, "video", entry.id, canonical.project)
    : null;
  const traceUrl = traceAtt
    ? resolveAsset(traceAtt.path, "trace", entry.id, canonical.project)
    : null;
  const media = bindWalkthrough(entry, canonical, status, provenance, walkthrough);

  return {
    id: entry.id,
    name: entry.name,
    product,
    status,
    browsers,
    duration_ms: Math.max(...browsers.map((b) => b.duration_ms ?? 0)),
    run: provenance,
    video: media.video,
    media_note: media.note,
    raw_video_url: rawVideoUrl,
    trace_url: traceUrl,
    steps: toSteps(
      canonical,
      (stillPath, index) => resolveAsset(stillPath, "still", entry.id, canonical.project, index),
      media.offsets,
    ),
  };
}

/**
 * Map the manifest (in order) onto the evidence records → Journey[]. A manifest
 * entry with no matching record renders UNVERIFIED. `resolveAsset` maps a raw CI
 * attachment path to a served path (injected so ingest stays I/O-free + testable).
 * `walkthrough` (optional) is the human-pace recording run — {evidence, run,
 * resolveAsset} — whose videos become the cards' videos where they bind (see
 * bindWalkthrough).
 * @param {{evidence: object, manifest: object[], product: string, provenance: object,
 *   resolveAsset?: Function, walkthrough?: object|null}} args
 */
export function buildJourneys({
  evidence,
  manifest,
  product,
  provenance,
  resolveAsset,
  walkthrough = null,
}) {
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
        : buildJourney(entry, matched, product, provenance, resolve, walkthrough);
    return assertJourney(journey);
  });
}
