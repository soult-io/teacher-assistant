// The product-agnostic Journey model: the reusable contract between the ingest
// engine and the renderers. No product vocabulary lives here — a journey is just a
// named, provenance-bound outcome with per-browser results and a step/assertion
// tree. The same model serves any product whose e2e suite emits journey-evidence.

/** @typedef {"passed"|"failed"|"flaky"|"skipped"|"unverified"} JourneyStatus */

export const JOURNEY_STATUS = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  FLAKY: "flaky",
  SKIPPED: "skipped",
  UNVERIFIED: "unverified",
});

/** The only recording a card may play: the human-pace walkthrough (never the gating run's). */
export const RECORDING = Object.freeze({ WALKTHROUGH: "walkthrough" });

const KNOWN_STATUS = new Set(Object.values(JOURNEY_STATUS));

// Why a verified card shows no video. The fast gating recording is never the fallback.
export const MEDIA_NOTE = Object.freeze({
  NONE: "no walkthrough recorded for this commit",
  FAILED: "the walkthrough recording failed for this commit — not shown",
  DIFFERS: "the walkthrough does not match this run's result or steps — not shown",
  UNPROVEN: "the walkthrough's trace does not show it recorded the local test build — not shown",
});

// A journey can only render a green PASS badge from a REAL, verified run. UNVERIFIED
// is structurally excluded so decoration can never impersonate a passing test.
export const PASSABLE_STATUS = new Set([JOURNEY_STATUS.PASSED, JOURNEY_STATUS.FLAKY]);

/**
 * Map one Playwright test outcome/status to a journey status. `outcome` is the
 * authoritative signal (it already folds retries into flaky); `status` is the
 * fallback when a runner omits the outcome.
 * @param {{outcome?: string, status?: string}} result
 * @returns {JourneyStatus}
 */
export function mapTestStatus({ outcome, status } = {}) {
  switch (outcome) {
    case "expected":
      return JOURNEY_STATUS.PASSED;
    case "unexpected":
      return JOURNEY_STATUS.FAILED;
    case "flaky":
      return JOURNEY_STATUS.FLAKY;
    case "skipped":
      return JOURNEY_STATUS.SKIPPED;
    default:
      break;
  }
  if (status === "passed") return JOURNEY_STATUS.PASSED;
  if (status === "skipped") return JOURNEY_STATUS.SKIPPED;
  return JOURNEY_STATUS.FAILED;
}

// Worst-wins precedence across the browsers a journey ran on: one red engine makes
// the whole journey red (spec: "any red engine → red card").
const STATUS_RANK = {
  [JOURNEY_STATUS.FAILED]: 4,
  [JOURNEY_STATUS.FLAKY]: 3,
  [JOURNEY_STATUS.SKIPPED]: 2,
  [JOURNEY_STATUS.PASSED]: 1,
};

/**
 * Reduce per-browser statuses to the journey's overall status (worst wins).
 * @param {{status: JourneyStatus}[]} browsers
 * @returns {JourneyStatus}
 */
export function deriveJourneyStatus(browsers) {
  if (!Array.isArray(browsers) || browsers.length === 0) return JOURNEY_STATUS.UNVERIFIED;
  let worst = JOURNEY_STATUS.PASSED;
  for (const b of browsers) {
    if ((STATUS_RANK[b.status] ?? 0) > (STATUS_RANK[worst] ?? 0)) worst = b.status;
  }
  return worst;
}

/**
 * A manifest journey with no matching run result. It carries the identity the config
 * declared but NO run/browsers/steps — structurally incapable of a green PASS.
 * @param {{id: string, name: string}} entry
 * @param {string} product
 */
export function makeUnverified(entry, product) {
  return {
    id: entry.id,
    name: entry.name,
    product,
    status: JOURNEY_STATUS.UNVERIFIED,
    browsers: [],
    duration_ms: null,
    run: null,
    video: null,
    media_note: null,
    raw_video_url: null,
    trace_url: null,
    steps_engine: null,
    unshown_still_engines: [],
    steps: [],
  };
}

/**
 * A step's still is a served path or an explicit null (absent) — nothing in between.
 * `screenshot_truncated` says whether that still is cut off at the height cap: a
 * boolean, or null when unknown (a pre-v3 run) — and always null when there is no still.
 * `screenshot_width`/`screenshot_height` follow the same rule: positive integers, or
 * null when unknown or when there is no still.
 */
function assertStepStills(id, steps) {
  for (const step of steps) {
    const still = step?.screenshot;
    if (still !== null && (typeof still !== "string" || still === "")) {
      throw new Error(
        `journey ${id} step ${step?.index} screenshot must be a path or null, got ${JSON.stringify(still)}`,
      );
    }
    const truncated = step?.screenshot_truncated;
    const truncatedOk =
      still === null ? truncated === null : [true, false, null].includes(truncated);
    if (!truncatedOk) {
      throw new Error(
        `journey ${id} step ${step?.index} screenshot_truncated must be ${still === null ? "null with no still" : "a boolean or null"}, got ${JSON.stringify(truncated)}`,
      );
    }
    assertStillSize(id, step, still);
  }
}

/** A still's pixel size: positive integers, or null (unknown, or no still at all). */
function assertStillSize(id, step, still) {
  for (const key of ["screenshot_width", "screenshot_height"]) {
    const n = step?.[key];
    const sizeOk = n === null || (still !== null && Number.isInteger(n) && n > 0);
    if (!sizeOk) {
      throw new Error(
        `journey ${id} step ${step?.index} ${key} must be ${still === null ? "null with no still" : "a positive integer or null"}, got ${JSON.stringify(n)}`,
      );
    }
  }
}

/**
 * Loud validation — a malformed journey is a broken generator, not a blank card.
 * Throws with the offending id so a bug surfaces at generate time.
 * @param {Record<string, unknown>} journey
 */
export function assertJourney(journey) {
  const id = journey?.id;
  if (!id || typeof id !== "string") throw new Error("journey is missing a string id");
  if (!journey.name || typeof journey.name !== "string") {
    throw new Error(`journey ${id} is missing a name`);
  }
  if (!KNOWN_STATUS.has(journey.status)) {
    throw new Error(`journey ${id} has unknown status ${JSON.stringify(journey.status)}`);
  }
  if (!Array.isArray(journey.browsers)) throw new Error(`journey ${id} browsers is not an array`);
  if (!Array.isArray(journey.steps)) throw new Error(`journey ${id} steps is not an array`);
  assertStepStills(id, journey.steps);
  // The card's video is only ever the human-pace walkthrough recording — the fast
  // gating recording is raw evidence (raw_video_url), never the card's media.
  if (journey.video && journey.video.recording !== RECORDING.WALKTHROUGH) {
    throw new Error(`journey ${id} video must be a walkthrough recording`);
  }
  // A verified (non-unverified) journey MUST be bound to a real run — a provenance
  // object of nulls is not a binding. "Provenance or nothing": no run id, no PASS.
  if (journey.status !== JOURNEY_STATUS.UNVERIFIED && !journey.run?.ci_run_id) {
    throw new Error(`journey ${id} is ${journey.status} but is not bound to a run id`);
  }
  // UNVERIFIED can never be provenance-bound (that would let it show a PASS).
  if (journey.status === JOURNEY_STATUS.UNVERIFIED && journey.run) {
    throw new Error(`journey ${id} is unverified but carries run provenance`);
  }
  return journey;
}
