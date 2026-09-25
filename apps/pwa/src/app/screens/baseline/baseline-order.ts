// Baseline track display order (TEACH-25): record order is not stable across a
// reseed or reload, so cards and point chips are sorted before render.

import { compareCodePoints } from "@teacher-assistant/domain-core";
import type { BaselinePoint, IEPGoal } from "@teacher-assistant/schema";
import { compareStudentGoal, type StudentResolvers, studentGoalKey } from "../../display-order.js";

/** Proposed-goal cards in the shared student-goal order; goalId only for true duplicates. */
export function orderProposedGoals(goals: readonly IEPGoal[], r: StudentResolvers): IEPGoal[] {
  const key = (g: IEPGoal) => studentGoalKey(g.student_id, g.goal_text, r);
  return [...goals].sort(
    (a, b) => compareStudentGoal(key(a), key(b)) || compareCodePoints(a.goal_id, b.goal_id),
  );
}

/**
 * A card's baseline points oldest first: admin date, entry time, then the point
 * id ASCENDING. (The ARC oldest-first plot order breaks that last tie descending,
 * as the exact reverse of its newest-first history; the chips have no history
 * list to mirror, so plain ascending is kept on purpose.)
 */
export function baselinePointsOldestFirst(points: readonly BaselinePoint[]): BaselinePoint[] {
  return [...points].sort(
    (a, b) =>
      compareCodePoints(a.admin_date, b.admin_date) ||
      a.entry_ts - b.entry_ts ||
      compareCodePoints(a.baseline_point_id, b.baseline_point_id),
  );
}
