// TEACH-41 — the IEP goal label: its audited edit and the per-student duplicate
// check. A duplicate WARNS, never blocks: two offline devices can each save
// "Goal 2" and the merge keeps both, so the cue must persist until a label is
// changed (ky-sped-lbd-sdi-sme binding condition), not only show at save time.

import type { GoalStatus, IEPGoal, OpaqueId, Revision, Timestamp } from "@teacher-assistant/schema";
import { compareCodePoints } from "./comparators.js";
import { validateGoalLabel } from "./goal-validation.js";

/** Which IEP a goal's label belongs to: the current IEP, the next (proposed) one, or none. */
export type GoalLabelCohort = "current" | "next";

/**
 * A goal's label cohort: active + mastered goals are the CURRENT IEP; proposed
 * goals are the NEXT IEP (checked separately — their numbers are only final at
 * the ARC). A retired goal is in no cohort: its label stays frozen and never
 * counts as a duplicate.
 */
export function goalLabelCohort(status: GoalStatus): GoalLabelCohort | null {
  if (status === "active" || status === "mastered") {
    return "current";
  }
  return status === "proposed" ? "next" : null;
}

/** The fields a label-conflict check reads (a saved goal, or a goal still being entered). */
export interface GoalLabelCandidate {
  readonly goal_id?: OpaqueId;
  readonly student_id: OpaqueId;
  readonly status: GoalStatus;
  readonly goal_label?: string;
}

/**
 * The duplicate-check key: case-insensitive, and leading zeros in a number dropped,
 * so it agrees with the number-aware sort ("01" and "1" are the same Goal 1).
 */
function labelKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ""));
}

/**
 * The other goals of the same student, in the same cohort, whose label matches
 * the candidate's case-insensitively — ordered by goal id so the result is stable.
 * Empty when the candidate has no label or is in no cohort (retired).
 */
export function goalLabelConflicts(
  goals: readonly IEPGoal[],
  candidate: GoalLabelCandidate,
): IEPGoal[] {
  const cohort = goalLabelCohort(candidate.status);
  if (candidate.goal_label === undefined || cohort === null) {
    return [];
  }
  const key = labelKey(candidate.goal_label);
  return goals
    .filter(
      (g) =>
        g.goal_id !== candidate.goal_id &&
        g.student_id === candidate.student_id &&
        g.goal_label !== undefined &&
        goalLabelCohort(g.status) === cohort &&
        labelKey(g.goal_label) === key,
    )
    .sort((a, b) => compareCodePoints(a.goal_id, b.goal_id));
}

/**
 * The student's duplicate-labelled goals, per cohort: each goal id that shares its
 * label with another goal of the same cohort → those other goals. A goal absent
 * from the map has no duplicate. Retired goals never appear.
 */
export function duplicateGoalLabels(
  goals: readonly IEPGoal[],
  studentId: OpaqueId,
): ReadonlyMap<OpaqueId, readonly IEPGoal[]> {
  const mine = goals.filter((g) => g.student_id === studentId);
  const result = new Map<OpaqueId, readonly IEPGoal[]>();
  for (const goal of mine) {
    const others = goalLabelConflicts(mine, goal);
    if (others.length > 0) {
      result.set(goal.goal_id, others);
    }
  }
  return result;
}

/**
 * Every goal whose IEP label is duplicated within its student's cohort (current =
 * active + mastered, next = proposed; retired never) — the set behind the lasting
 * duplicate cue on the dashboard rows and the IC export's duplicateLabel flag.
 */
export function duplicateLabelGoalIds(goals: readonly IEPGoal[]): ReadonlySet<OpaqueId> {
  const ids = new Set<OpaqueId>();
  for (const studentId of new Set(goals.map((g) => g.student_id))) {
    for (const goalId of duplicateGoalLabels(goals, studentId).keys()) {
      ids.add(goalId);
    }
  }
  return ids;
}

/** Thrown when setGoalLabel is handed a label that fails validateGoalLabel. */
export class GoalLabelError extends Error {
  constructor() {
    super("goal label must be 1–6 of A–Z, a–z, 0–9 or '.'");
    this.name = "GoalLabelError";
  }
}

export interface SetGoalLabelOptions {
  readonly who: string;
  readonly when: Timestamp;
}

/**
 * Set or clear (undefined / blank) a goal's IEP label, appending an audited
 * Revision {goal_label: old → new} (null = no label). Unchanged → the same goal,
 * no revision. Throws GoalLabelError for an invalid label. The revision key is
 * `goal_label` only, so it never trips the F4 quarterly clamp.
 */
export function setGoalLabel(
  goal: IEPGoal,
  label: string | undefined,
  options: SetGoalLabelOptions,
): IEPGoal {
  const check = validateGoalLabel(label ?? "");
  if (!check.ok) {
    throw new GoalLabelError();
  }
  const next = check.label;
  if (next === goal.goal_label) {
    return goal;
  }
  const revision: Revision = {
    who: options.who,
    when: options.when,
    old: { goal_label: goal.goal_label ?? null },
    new: { goal_label: next ?? null },
  };
  const { goal_label: _previous, ...rest } = goal;
  return {
    ...rest,
    ...(next !== undefined ? { goal_label: next } : {}),
    revisions: [...goal.revisions, revision],
  };
}
