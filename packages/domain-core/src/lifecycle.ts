// M7 — goal lifecycle transitions (data-model §2.5, design §F.F3 / §G R3-4):
// proposed (baselining) → ARC adoption → active → mastered | retired.
//
// ARC adoption LOCKS the derived baseline into the goal and flips it active; it
// requires a usable baseline (≥3 comparable points), enforcing baseline-mandatory.
// The app never transitions active→mastered autonomously — mastered/retired are
// explicit ARC actions (M5 only OBSERVES the mastery window).

import type {
  BaselinePoint,
  GoalStatus,
  IEPGoal,
  Revision,
  Timestamp,
} from "@teacher-assistant/schema";
import { type BaselineMethod, deriveBaseline } from "./baseline.js";

export type AdoptionBlock = "not_proposed" | "insufficient_baseline" | "mixed_conditions";

export interface AdoptionCheck {
  readonly ok: boolean;
  readonly reason?: AdoptionBlock;
}

/** Thrown when ARC adoption is attempted on a goal that cannot be adopted. */
export class AdoptionError extends Error {
  constructor(readonly reason: AdoptionBlock) {
    super(`goal cannot be adopted: ${reason}`);
    this.name = "AdoptionError";
  }
}

/** Whether a proposed goal may be adopted: it must be proposed and have a usable (≥3 comparable) baseline. */
export function canAdopt(goal: IEPGoal, baselinePoints: readonly BaselinePoint[]): AdoptionCheck {
  if (goal.status !== "proposed") {
    return { ok: false, reason: "not_proposed" };
  }
  const estimate = deriveBaseline(goal, baselinePoints);
  if (!estimate.comparable) {
    return { ok: false, reason: "mixed_conditions" };
  }
  if (!estimate.usable) {
    return { ok: false, reason: "insufficient_baseline" };
  }
  return { ok: true };
}

export interface AdoptOptions {
  readonly who: string;
  readonly when: Timestamp;
  readonly method?: BaselineMethod;
}

/**
 * ARC adoption: lock the derived baseline into the goal and flip proposed → active.
 * Throws AdoptionError if the goal isn't proposed or lacks a usable baseline.
 * Baseline points are separate entities and are never discarded.
 */
export function adoptGoal(
  goal: IEPGoal,
  baselinePoints: readonly BaselinePoint[],
  options: AdoptOptions,
): IEPGoal {
  const check = canAdopt(goal, baselinePoints);
  if (!check.ok) {
    throw new AdoptionError(check.reason ?? "insufficient_baseline");
  }
  const estimate = deriveBaseline(goal, baselinePoints, options.method);
  if (estimate.value === null) {
    throw new AdoptionError("insufficient_baseline"); // unreachable given canAdopt, but keeps value non-null
  }
  const revision: Revision = {
    who: options.who,
    when: options.when,
    old: { status: "proposed" },
    new: {
      status: "active",
      baseline_value: estimate.value,
      baseline_source: "computed_from_baseline_points",
      // F3: the (previously provisional) criterion is FINALIZED at ARC adoption.
      // Recorded as a distinct flag (not the `criterion_level` key) so the F4
      // quarterly clamp does not read adoption as a criterion CHANGE.
      criterion_confirmed: true,
    },
  };
  return {
    ...goal,
    status: "active",
    baseline_value: estimate.value,
    baseline_source: "computed_from_baseline_points",
    revisions: [...goal.revisions, revision],
  };
}

export interface CloseOptions {
  readonly who: string;
  readonly when: Timestamp;
}

/**
 * Record an explicit ARC decision to close a goal (mastered or retired). This is
 * never autonomous — it represents a human ARC action; the app only observes the
 * mastery window (M5), it does not close goals on its own.
 */
export function closeGoalByArc(
  goal: IEPGoal,
  status: Extract<GoalStatus, "mastered" | "retired">,
  options: CloseOptions,
): IEPGoal {
  const revision: Revision = {
    who: options.who,
    when: options.when,
    old: { status: goal.status },
    new: { status },
  };
  return { ...goal, status, revisions: [...goal.revisions, revision] };
}
