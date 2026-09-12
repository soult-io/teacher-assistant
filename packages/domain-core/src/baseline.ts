// M7 — baseline derivation (data-model §2.2 F3, design §F.F3). A baseline is
// usable only at ≥3 COMPARABLE points (same probe condition). The value is the
// MEAN by default with a median-of-3 option (the PM convention); it is always an
// ESTIMATE, never a trend (KY Decision Rules need 6–8 points for a trend).

import type { BaselinePoint, IEPGoal } from "@teacher-assistant/schema";
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
 * Derive the baseline ESTIMATE for a proposed goal from its baseline points.
 * Points are "comparable" only if they share one probe condition; mixed
 * conditions are not comparable and yield an unusable estimate. Usable requires
 * ≥3 comparable points. Default method is the mean; median-of-3 is offered.
 */
export function deriveBaseline(
  goal: IEPGoal,
  baselinePoints: readonly BaselinePoint[],
  method: BaselineMethod = "mean",
): BaselineEstimate {
  const cohort = baselinePoints.filter((p) => p.goal_id === goal.goal_id);
  const conditions = new Set(
    cohort
      .map((p) => p.probe_condition_id)
      .filter((id): id is NonNullable<typeof id> => id !== undefined),
  );
  const comparable = conditions.size <= 1;
  const n = cohort.length;
  const usable = comparable && n >= 3;

  if (!usable) {
    return { value: null, n, usable: false, comparable, method, label: "estimate" };
  }
  const percents = cohort.map((p) => percentCorrect(p.numerator, p.denominator_used));
  return {
    value: method === "median" ? median(percents) : mean(percents),
    n,
    usable: true,
    comparable: true,
    method,
    label: "estimate",
  };
}
