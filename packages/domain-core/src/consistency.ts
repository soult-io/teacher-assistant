// M5 — consistency window + mastery observation (design §A.3, §B "mastery
// framing"). "Consecutive" means consecutive SCORED PROBES in admin-date order,
// never weeks: a ⊘ (no-data) PAUSES the run (it is simply not a scored probe, so
// it neither counts nor resets); a denominator/condition-mismatched point is
// EXCLUDED from the window. Mastery is only OBSERVED here — the window being met
// flags a candidate for the ARC; the app never closes/retires the goal.

import type {
  IEPGoal,
  MasteryObservation,
  OpaqueId,
  ProgressDataPoint,
} from "@teacher-assistant/schema";
import { newOpaqueId } from "@teacher-assistant/schema";
import { compareCodePoints } from "./comparators.js";
import { percentCorrect } from "./value.js";

export interface ConsistencyResult {
  /** Length of the current trailing run of consecutive scored probes meeting criterion. */
  readonly run: number;
  /** Required consecutive probes (goal.criterion_consistency.n_probes). */
  readonly required: number;
  readonly met: boolean;
  /**
   * Admin date at which the window was FIRST-EVER satisfied (independent of the
   * current run — a later below-criterion probe can reset `run`/`met` while this
   * stays set). Consumers deciding mastery must check `met`, not this alone.
   */
  readonly windowMetDate?: ProgressDataPoint["admin_date"];
  /** Count of mismatched points excluded from the window (surfaced, never silently dropped). */
  readonly excludedMismatches: number;
}

/** Scored, non-mismatched points for a goal, in admin-date order (the probe axis). */
function scoredProbesInOrder(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
): ProgressDataPoint[] {
  return points
    .filter(
      (p) => p.goal_id === goal.goal_id && p.state === "scored" && p.denominator_mismatch !== true,
    )
    .sort((a, b) => compareCodePoints(a.admin_date, b.admin_date));
}

// MVP is %-only (design C1); the consistency window compares each probe's percent
// to criterion_level. A non-% model is out of MVP scope and has no defined window.
function meetsCriterion(goal: IEPGoal, p: ProgressDataPoint): boolean {
  return percentCorrect(p.numerator ?? 0, p.denominator_used ?? 0) >= goal.criterion_level;
}

/**
 * The consistency window for a goal: the current consecutive run of scored probes
 * meeting the criterion level, in admin-date order. A ⊘ never appears here (only
 * scored probes), so it pauses rather than breaks; a below-criterion scored probe
 * resets the run; mismatched points are excluded (and counted).
 */
export function consistencyWindow(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
): ConsistencyResult {
  const required = goal.criterion_consistency.n_probes;
  const probes = scoredProbesInOrder(goal, points);
  const excludedMismatches = points.filter(
    (p) => p.goal_id === goal.goal_id && p.state === "scored" && p.denominator_mismatch === true,
  ).length;

  let run = 0;
  let windowMetDate: ProgressDataPoint["admin_date"] | undefined;
  for (const p of probes) {
    run = meetsCriterion(goal, p) ? run + 1 : 0;
    if (run >= required && windowMetDate === undefined) {
      windowMetDate = p.admin_date; // first time the window was satisfied
    }
  }

  return {
    run,
    required,
    met: run >= required,
    excludedMismatches,
    ...(windowMetDate !== undefined ? { windowMetDate } : {}),
  };
}

/** An app-observed mastery candidate — the window is met, flagged for ARC review. Never closes the goal. */
export interface MasteryCandidate {
  readonly goalId: OpaqueId;
  readonly windowMetDate: ProgressDataPoint["admin_date"];
}

/**
 * Observe (never decide) mastery: returns a candidate iff the consistency window
 * is met. The app OBSERVES; the teacher/ARC closes the goal — this never mutates
 * goal status.
 */
export function observeMastery(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
): MasteryCandidate | null {
  const result = consistencyWindow(goal, points);
  if (!result.met || result.windowMetDate === undefined) {
    return null;
  }
  return { goalId: goal.goal_id, windowMetDate: result.windowMetDate };
}

/**
 * Teacher acknowledgement of an observed window → a MasteryObservation flagged for
 * ARC. This records the observation; it does NOT transition the goal to mastered
 * (that is an ARC action).
 */
export function acknowledgeMastery(candidate: MasteryCandidate): MasteryObservation {
  return {
    observation_id: newOpaqueId(),
    goal_id: candidate.goalId,
    window_met_date: candidate.windowMetDate,
    acknowledged_by: "teacher",
    flagged_for_arc: true,
  };
}
