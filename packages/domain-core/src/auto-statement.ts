// M8 — auto progress-statement + trend engine (architecture §phase1 §5, design
// §G R3-3). Produces a DRAFT progress statement for an IEP %-goal in one of three
// locked variants — ON-TREND / NOT-ON-TREND / INDETERMINATE — whose wording is the
// §G R3-3 template text, filled ONLY from structured slots.
//
// FERPA (HARD): this engine is structurally incapable of a statement for a
// proposed/baseline or non-% goal (reuse of the M6a structural export guard
// isIcExportable); it ingests NO narrative field (goal.goal_text is the single
// composed goal string, already FERPA-reviewed; clinical notes, para observation
// chips, and free-text comments are never read). Every number it prints traces to
// a scored data point — it never fabricates a value, and it never averages across
// a criterion-level / denominator-model change (reuse of the M6a F4 clamp).
//
// It makes NO absolute promise ("will meet the goal"), NO trend claim below the
// NCII sufficiency gate (≥8 scored points AND ≥4 instructional weeks), and NO
// predicted mastery date — the horizon is the IEP end date (NOT the ARC date),
// and on-track is a defensible PROJECTION, not a guarantee.

import type { IEPGoal, IsoDate, OpaqueId, ProgressDataPoint } from "@teacher-assistant/schema";
import { compareArcOldestFirst } from "./comparators.js";
import { isIcExportable } from "./ic-export.js";
import { instructionalWeekCount } from "./instructional-weeks.js";
import { clampAfterFromRevisions, computeQuarterlySummary, QUARTERLY_WINDOW } from "./quarterly.js";
import { fourPointVerdict, olsTrend, valueAt, type XY } from "./trend.js";
import { computeValue } from "./value.js";

/** NCII sufficiency gate: a trend claim requires at least this many scored points. */
export const MIN_SCORED_POINTS = 8;
/** …AND at least this many INSTRUCTIONAL weeks of monitoring (M4 week axis). */
export const MIN_INSTRUCTIONAL_WEEKS = 4;
/** The four-point noise cross-check looks at the most recent this-many points. */
const FOUR_POINT = 4;

/** The fixed DRAFT banner (data-model §6.2): never a final statement. */
export const DRAFT_LABEL = "Draft progress statement — review before copying to IC" as const;

export type StatementVariant = "on_track" | "not_on_track" | "indeterminate";

/** Why a statement is INDETERMINATE — surfaced so the teacher knows what is missing. */
export type IndeterminateReason =
  | "no_scored_data" // no averageable scored point this period
  | "no_iep_end_date" // no projection horizon — cannot evaluate on-track
  | "below_point_gate" // < MIN_SCORED_POINTS comparable scored points
  | "insufficient_after_exclusion" // dropped below the point gate after mismatch exclusion
  | "below_week_gate" // < MIN_INSTRUCTIONAL_WEEKS instructional weeks
  | "undefined_trend" // OLS trend undefined (all points share one date)
  | "fourpoint_straddle" // last four straddle the aim line — too noisy to claim
  | "trend_fourpoint_disagree"; // OLS trend and four-point check disagree

/** The §6.2 structured slots — the ONLY inputs to the template; no narrative text. */
export interface StatementSlots {
  readonly initials: string;
  readonly goalText: string;
  readonly nUsed: number;
  readonly dateRange: string | null;
  readonly avgRecent: number | null;
  readonly conditionPhrase: string;
  readonly deltaBaseline: number | null;
  readonly baselineValue: number;
  readonly deltaPrior: number | null;
  readonly priorPeriodAvg: number | null;
  readonly totalPoints: number;
  readonly criterionLevel: number;
  readonly criterionConsistency: string;
  readonly iepEndDate: IsoDate | null;
}

export interface AutoStatement {
  readonly variant: StatementVariant;
  /** The assembled DRAFT text — §G R3-3 template filled from the slots. */
  readonly text: string;
  readonly label: typeof DRAFT_LABEL;
  readonly slots: StatementSlots;
  /** Trend projection ≥ criterion at the IEP end date; null when not evaluated (indeterminate). */
  readonly onTrack: boolean | null;
  readonly indeterminateReason?: IndeterminateReason;
  /** Points excluded for denominator/condition mismatch — surfaced, never silently dropped. */
  readonly excludedMismatches: number;
  /** True when the trend/average window was clamped at a criterion/denominator change. */
  readonly clampedAtChange: boolean;
}

export interface AutoStatementOptions {
  /** Calendar break flag, keyed by ISO week id (M4) — drives the ≥4 instructional-week gate. */
  readonly isNonInstructional: (weekId: string) => boolean;
  /**
   * The goal's expected probe condition id. When given, a scored point whose
   * probe_condition_id differs is CONDITION-mismatched: excluded from the trend and
   * surfaced. Omit when condition comparability is enforced upstream.
   */
  readonly expectedConditionId?: OpaqueId;
}

/** Whole-number percentage for display; every printed figure is rounded consistently. */
function round(value: number): number {
  return Math.round(value);
}

/** Days since the Unix epoch for an ISO date (UTC) — a monotone x-axis for the trend. */
function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** The % value of a scored point under the goal's model. */
function pointValue(goal: IEPGoal, p: ProgressDataPoint): number {
  return computeValue(goal.denominator_model, p.numerator ?? 0, p.denominator_used ?? 0).value;
}

/**
 * condition_phrase derives from circumstance + accom/mod — the word "independently"
 * is NEVER emitted (a modified goal must not be dressed as independent; the
 * circumstance alone carries the performance condition). A posture clause is added
 * only for an accommodation / modification goal.
 */
export function conditionPhrase(goal: IEPGoal): string {
  switch (goal.accom_mod) {
    case "accommodation":
      return `${goal.circumstance}, with accommodations`;
    case "modification":
      return `${goal.circumstance}, with modifications`;
    default:
      return goal.circumstance;
  }
}

/** "increase" / "decrease" for a percentage-POINT delta (0 reads as a 0-point increase). */
function direction(delta: number): string {
  return delta < 0 ? "decrease" : "increase";
}

interface Determination {
  readonly variant: StatementVariant;
  readonly onTrack: boolean | null;
  readonly reason?: IndeterminateReason;
}

function indeterminate(reason: IndeterminateReason): Determination {
  return { variant: "indeterminate", onTrack: null, reason };
}

/**
 * The §G R3-3 determination, as a linear chain of early gates (keeps each branch
 * independently auditable): structural sufficiency first, then the trend projection
 * cross-checked against the four-point noise guard. Any ambiguity → INDETERMINATE.
 */
function determineVariant(
  goal: IEPGoal,
  trendPoints: readonly ProgressDataPoint[],
  avgRecent: number | null,
  excludedMismatches: number,
  options: AutoStatementOptions,
): Determination {
  if (avgRecent === null) {
    return indeterminate("no_scored_data");
  }
  if (goal.iep_end_date === undefined) {
    return indeterminate("no_iep_end_date");
  }
  const totalPoints = trendPoints.length;
  if (totalPoints < MIN_SCORED_POINTS) {
    return indeterminate(
      excludedMismatches > 0 ? "insufficient_after_exclusion" : "below_point_gate",
    );
  }
  const firstDate = trendPoints[0]?.admin_date;
  const lastDate = trendPoints[totalPoints - 1]?.admin_date;
  if (firstDate === undefined || lastDate === undefined) {
    return indeterminate("no_scored_data");
  }
  const weeks = instructionalWeekCount({
    firstAdminDate: firstDate,
    asOf: lastDate,
    isNonInstructional: options.isNonInstructional,
  });
  if (weeks < MIN_INSTRUCTIONAL_WEEKS) {
    return indeterminate("below_week_gate");
  }
  const x0 = dayNumber(firstDate);
  const xy: XY[] = trendPoints.map((p) => ({
    x: dayNumber(p.admin_date) - x0,
    y: pointValue(goal, p),
  }));
  const line = olsTrend(xy);
  if (line === null) {
    return indeterminate("undefined_trend");
  }
  const xEnd = dayNumber(goal.iep_end_date) - x0;
  // A malformed (non-ISO) iep_end_date parses to NaN — the horizon is not evaluable,
  // so no trend claim may be made (guards the bad-cast edge past the branded type).
  if (!Number.isFinite(xEnd)) {
    return indeterminate("no_iep_end_date");
  }
  const baseline = goal.baseline_value ?? 0;
  const verdict = fourPointVerdict(xy.slice(-FOUR_POINT), baseline, goal.criterion_level, xEnd);
  if (verdict === "straddle") {
    return indeterminate("fourpoint_straddle");
  }
  const trendOnTrack = valueAt(line, xEnd) >= goal.criterion_level;
  const fourPointOnTrack = verdict === "above";
  if (fourPointOnTrack !== trendOnTrack) {
    return indeterminate("trend_fourpoint_disagree");
  }
  return { variant: trendOnTrack ? "on_track" : "not_on_track", onTrack: trendOnTrack };
}

/** S1 + S2: the two reporting sentences shared by all three variants (require scored data). */
function leadSentences(slots: StatementSlots): string {
  const s1 = `According to the ${slots.nUsed} most recent data points (${slots.dateRange}), ${slots.initials} is averaging ${slots.avgRecent}% accuracy on ${slots.goalText}, ${slots.conditionPhrase}.`;
  const deltaBaseline = slots.deltaBaseline ?? 0;
  let s2 = `This is a ${Math.abs(deltaBaseline)}-point ${direction(deltaBaseline)} from the baseline of ${slots.baselineValue}%`;
  // The prior-period clause is printed ONLY when a prior reporting period exists —
  // a delta against a non-existent period would be a fabricated number.
  if (slots.priorPeriodAvg !== null && slots.deltaPrior !== null) {
    s2 += ` and a ${Math.abs(slots.deltaPrior)}-point ${direction(slots.deltaPrior)} from the previous reporting period (${slots.priorPeriodAvg}%)`;
  }
  return `${s1} ${s2}.`;
}

/** Assemble the DRAFT text for the determined variant from the structured slots. */
function assembleText(
  variant: StatementVariant,
  slots: StatementSlots,
  reason?: IndeterminateReason,
): string {
  if (variant === "on_track") {
    return `${leadSentences(slots)} Based on the current trend across ${slots.totalPoints} data points, ${slots.initials} is on track to meet the goal criterion of ${slots.criterionLevel}% (${slots.criterionConsistency}) by the end of the IEP period (${slots.iepEndDate}).`;
  }
  if (variant === "not_on_track") {
    return `${leadSentences(slots)} Based on the current trend across ${slots.totalPoints} data points, ${slots.initials} is not yet on track to meet the goal criterion of ${slots.criterionLevel}% by ${slots.iepEndDate}; progress will continue to be supported and adjusted through specially designed instruction.`;
  }
  // INDETERMINATE — no trend claim, no horizon projection, no consistency promise.
  const close = `additional data are needed to establish a reliable trend toward ${slots.criterionLevel}%. Progress will continue to be monitored and supported through specially designed instruction.`;
  if (reason === "no_scored_data") {
    return `No scored data points have been collected this period; ${close}`;
  }
  return `${leadSentences(slots)} ${slots.totalPoints} data points have been collected this period; ${close}`;
}

/**
 * Compute the DRAFT auto progress-statement for a goal. Returns null when the goal
 * is structurally incapable of a statement (proposed/baseline/non-%, via the M6a
 * structural guard) — there is no code path that emits one for such a goal.
 *
 * `initials` is the single permitted human handle (data-model §10.2); the caller
 * supplies it — this pure module never derives identity from a student record.
 */
export function computeAutoStatement(
  goal: IEPGoal,
  initials: string,
  points: readonly ProgressDataPoint[],
  options: AutoStatementOptions,
): AutoStatement | null {
  // FERPA structural guard — proposed/baseline/non-% goals get NO statement.
  if (!isIcExportable(goal)) {
    return null;
  }
  const baselineValue = goal.baseline_value;
  if (baselineValue === undefined) {
    return null; // unreachable given isIcExportable; keeps the value non-null
  }

  const clampAfter = clampAfterFromRevisions(goal);
  const inClamp = (p: ProgressDataPoint): boolean =>
    clampAfter === undefined || p.admin_date >= clampAfter;

  const isConditionMismatch = (p: ProgressDataPoint): boolean =>
    options.expectedConditionId !== undefined &&
    p.probe_condition_id !== undefined &&
    p.probe_condition_id !== options.expectedConditionId;

  // Condition comparability gates the DISPLAYED average AND the trend — one dataset,
  // so the reported figure and the on-track determination can never diverge. A
  // condition-mismatched point is dropped from both.
  const conditionOk = points.filter((p) => p.goal_id === goal.goal_id && !isConditionMismatch(p));
  // §G R3-3 step 4: M8 HARD-excludes EVERY denominator-mismatched point regardless
  // of the teacher's F-2 disposition — "counted" is for the consistency window +
  // the F4 report card, NOT the IC progress statement. So the displayed average is
  // computed over the SAME hard-excluded set as the trend/gate below and can never
  // blend an off-basis point (the disposition is deliberately not read here).
  const statementBasis = conditionOk.filter((p) => p.denominator_mismatch !== true);

  // Display figures reuse the M6a F4 quarterly over that hard-excluded set (the
  // number shown on the IC card).
  const quarterly = computeQuarterlySummary(
    goal,
    statementBasis,
    clampAfter === undefined ? {} : { clampAfter },
  );
  const avgRecent = quarterly.average === null ? null : round(quarterly.average);
  const dateRange =
    quarterly.dateRange === null
      ? null
      : `${quarterly.dateRange.start} to ${quarterly.dateRange.end}`;

  // The trend/gate + prior-period dataset: the F4-comparable points (clamped, scored,
  // denominator- and condition-comparable) in the shared oldest-first order — the same
  // order F4 draws its most-recent window from, so the prior period is the window just
  // before it and the four-point tail ends on the last-entered point (TEACH-27).
  const trendPoints = conditionOk
    .filter((p) => p.state === "scored" && inClamp(p) && p.denominator_mismatch !== true)
    .sort(compareArcOldestFirst);

  // Mismatches (scored, in clamp) excluded for denominator OR condition — surfaced, not silently dropped.
  const excludedMismatches = points.filter(
    (p) =>
      p.goal_id === goal.goal_id &&
      p.state === "scored" &&
      inClamp(p) &&
      (p.denominator_mismatch === true || isConditionMismatch(p)),
  ).length;

  // Prior reporting period = the QUARTERLY_WINDOW comparable points BEFORE the F4 window.
  const priorWindow = trendPoints
    .slice(0, Math.max(0, trendPoints.length - quarterly.n))
    .slice(-QUARTERLY_WINDOW);
  const priorPeriodAvg =
    priorWindow.length === 0 ? null : round(mean(priorWindow.map((p) => pointValue(goal, p))));

  const baselineRounded = round(baselineValue);
  const deltaBaseline = avgRecent === null ? null : avgRecent - baselineRounded;
  const deltaPrior =
    avgRecent === null || priorPeriodAvg === null ? null : avgRecent - priorPeriodAvg;

  const slots: StatementSlots = {
    initials,
    goalText: goal.goal_text,
    nUsed: quarterly.n,
    dateRange,
    avgRecent,
    conditionPhrase: conditionPhrase(goal),
    deltaBaseline,
    baselineValue: baselineRounded,
    deltaPrior,
    priorPeriodAvg,
    totalPoints: trendPoints.length,
    criterionLevel: goal.criterion_level,
    criterionConsistency: goal.criterion_consistency.phrase,
    iepEndDate: goal.iep_end_date ?? null,
  };

  const { variant, onTrack, reason } = determineVariant(
    goal,
    trendPoints,
    avgRecent,
    excludedMismatches,
    options,
  );

  return {
    variant,
    text: assembleText(variant, slots, reason),
    label: DRAFT_LABEL,
    slots,
    onTrack,
    ...(reason !== undefined ? { indeterminateReason: reason } : {}),
    excludedMismatches,
    clampedAtChange: clampAfter !== undefined,
  };
}
