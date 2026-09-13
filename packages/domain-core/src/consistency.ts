// M5 — consistency window + mastery observation (design §A.3, §B "mastery
// framing"). "Consecutive" means consecutive SCORED PROBES in admin-date order,
// never weeks: a ⊘ (no-data) PAUSES the run (it is simply not a scored probe, so
// it neither counts nor resets); a denominator-mismatched point is EXCLUDED from
// the window unless the teacher elects it "counted" (F-2, flagged off-basis), and
// a criterion/denominator-model change CLAMPS the run first (hard, non-electable).
// Mastery is only OBSERVED here — the window being met
// flags a candidate for the ARC; the app never closes/retires the goal.

import type {
  IEPGoal,
  IsoDate,
  MasteryObservation,
  OpaqueId,
  ProgressDataPoint,
} from "@teacher-assistant/schema";
import { newOpaqueId } from "@teacher-assistant/schema";
import { compareCodePoints } from "./comparators.js";
import { inComputedMath, isCountedOffBasis, isUnresolvedMismatch } from "./mismatch.js";
import { clampAfterFromRevisions } from "./quarterly.js";
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
  /**
   * Count of mismatched points NOT in the run — resolved-excluded PLUS pending
   * (surfaced, never silently dropped). `unresolvedMismatches` is the pending subset.
   */
  readonly excludedMismatches: number;
  /** Mismatched points the teacher elected "counted" — IN the run, flagged off-basis. */
  readonly countedOffBasis: number;
  /** Mismatched points with no disposition yet — out of the run, surfaced as UNRESOLVED. */
  readonly unresolvedMismatches: number;
}

/**
 * Scored points for a goal that participate in the window, in admin-date order:
 * CLAMPED FIRST at a criterion/denominator-model change (hard, non-electable),
 * then a mismatched point is kept only if the teacher elected it "counted"
 * (`inComputedMath`). A ⊘ never appears here (only scored probes).
 */
function scoredProbesInOrder(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
  clampAfter: IsoDate | undefined,
): ProgressDataPoint[] {
  return points
    .filter(
      (p) =>
        p.goal_id === goal.goal_id &&
        p.state === "scored" &&
        (clampAfter === undefined || p.admin_date >= clampAfter) &&
        inComputedMath(p),
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
  // MVP is %-only (design C1). The %-vs-criterion window is defined ONLY for the
  // percent model; a non-% goal (rubric/count/duration) gets no coerced window —
  // it never reports met / a mastery candidate (its window is out of MVP scope).
  if (goal.denominator_model !== "percent_correct_over_total") {
    return {
      run: 0,
      required,
      met: false,
      excludedMismatches: 0,
      countedOffBasis: 0,
      unresolvedMismatches: 0,
    };
  }
  // Clamp FIRST (hard, non-electable), then the disposition decides survivors.
  const clampAfter = clampAfterFromRevisions(goal);
  const probes = scoredProbesInOrder(goal, points, clampAfter);
  // Mismatch counts are scoped to the clamped region (a mismatched point before
  // the model-change boundary is dropped by the clamp, not surfaced here).
  const clampedScored = points.filter(
    (p) =>
      p.goal_id === goal.goal_id &&
      p.state === "scored" &&
      (clampAfter === undefined || p.admin_date >= clampAfter),
  );
  const countedOffBasis = clampedScored.filter(isCountedOffBasis).length;
  const unresolvedMismatches = clampedScored.filter(isUnresolvedMismatch).length;
  const excludedMismatches = clampedScored.filter(
    (p) => p.denominator_mismatch === true && !isCountedOffBasis(p),
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
    countedOffBasis,
    unresolvedMismatches,
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
