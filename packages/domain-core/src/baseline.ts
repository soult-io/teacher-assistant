// M7 — baseline derivation (data-model §2.2 F3, design §F.F3). A baseline is
// usable only at ≥3 COMPARABLE points (same probe condition). The value is the
// MEAN by default with a median-of-3 option (the PM convention); it is always an
// ESTIMATE, never a trend (KY Decision Rules need 6–8 points for a trend).
//
// TEACH-46: a REMOVED point, and a point whose total differs from the probe's
// that the teacher has not kept, never count — not toward n, the value, the
// condition check or canAdopt.

import type { BaselinePoint, IEPGoal, OpaqueId } from "@teacher-assistant/schema";
import { percentCorrect } from "./value.js";

export type BaselineMethod = "mean" | "median";

export interface BaselineEstimate {
  /** The estimate (% for the % model), or null when not yet usable. */
  readonly value: number | null;
  /** Comparable baseline points considered. */
  readonly n: number;
  /** Usable only at ≥3 comparable points. */
  readonly usable: boolean;
  /** False when the points span more than one probe condition (not comparable). */
  readonly comparable: boolean;
  readonly method: BaselineMethod;
  /** The ids of the points counted (stored on the adoption Revision, C6). */
  readonly pointIds: readonly OpaqueId[];
  /** Always an ESTIMATE — never presented as a trend. */
  readonly label: "estimate";
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/**
 * Whether a baseline point counts toward the estimate (TEACH-46 C4/C8): not
 * removed, and not a mismatched total the teacher has yet to keep. A point
 * stored before TEACH-46 has no status and counts as recorded.
 */
/** A mismatched total still waiting for "Keep" or "Use N" (C8). */
export function needsTotalDecision(point: BaselinePoint): boolean {
  return (
    point.status !== "removed" &&
    point.denominator_mismatch === true &&
    point.mismatch_kept !== true
  );
}

export function isCountedBaselinePoint(p: BaselinePoint): boolean {
  return p.status !== "removed" && !needsTotalDecision(p);
}

/** The mean or median of the points' % correct (no usability check). Null for no points. */
export function baselineValueOf(
  points: readonly BaselinePoint[],
  method: BaselineMethod,
): number | null {
  if (points.length === 0) {
    return null;
  }
  const percents = points.map((p) => percentCorrect(p.numerator, p.denominator_used));
  return method === "median" ? median(percents) : mean(percents);
}

/**
 * Derive the baseline ESTIMATE for a proposed goal from its baseline points.
 * Only counted points (isCountedBaselinePoint) are considered. Points are
 * "comparable" only if they share one probe condition; mixed conditions are not
 * comparable and yield an unusable estimate. Usable requires ≥3 comparable
 * points. Default method is the mean; median-of-3 is offered.
 */
export function deriveBaseline(
  goal: IEPGoal,
  baselinePoints: readonly BaselinePoint[],
  method: BaselineMethod = "mean",
): BaselineEstimate {
  const cohort = baselinePoints.filter(
    (p) => p.goal_id === goal.goal_id && isCountedBaselinePoint(p),
  );
  const conditions = new Set(
    cohort
      .map((p) => p.probe_condition_id)
      .filter((id): id is NonNullable<typeof id> => id !== undefined),
  );
  const comparable = conditions.size <= 1;
  const n = cohort.length;
  const usable = comparable && n >= 3;
  const pointIds = cohort.map((p) => p.baseline_point_id);

  if (!usable) {
    return { value: null, n, usable: false, comparable, method, pointIds, label: "estimate" };
  }
  return {
    value: baselineValueOf(cohort, method),
    n,
    usable: true,
    comparable: true,
    method,
    pointIds,
    label: "estimate",
  };
}
