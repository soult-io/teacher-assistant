// The context a Quick-Score sheet opens against — resolved display attributes +
// the assigned probe (expected total) + the admin date. Built either from a
// dashboard row (score directly, dated today) or from a queued point (score from
// the To-Score queue, keeping the collected admin date + the existing point).

import type { IEPGoal, IsoDate, OpaqueId, ProgressDataPoint } from "@teacher-assistant/schema";
import type { Lookups, RowVM } from "./screens/dashboard/dashboard-vm.js";

export interface SheetTarget {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  readonly initials: string;
  readonly goalText: string;
  readonly periodLabel: string | null;
  readonly probeLabel: string;
  readonly expectedDenominator: number;
  /**
   * The goal has a VARIABLE denominator basis (F-2 escape valve): the entered total
   * is accepted as-is, so the sheet passes NO expected total to capture — no off-basis
   * flag, no mismatch ack. `expectedDenominator` is only a suggested default here.
   */
  readonly variableBasis: boolean;
  /** Probe administration date — today for a direct score, the collected date from the queue. */
  readonly adminDate: IsoDate;
  /** Present when re-scoring a queued/bookmarked point (audited edit, same id). */
  readonly existingPoint?: ProgressDataPoint;
}

function probeOf(goalId: OpaqueId, lk: Lookups): { label: string; expectedDenominator: number } {
  return lk.probeByGoal.get(goalId) ?? { label: "probe", expectedDenominator: 5 };
}

function periodLabelOf(studentId: OpaqueId, lk: Lookups): string | null {
  const periodId = lk.periodByStudent(studentId);
  return periodId !== null ? (lk.periodLabelById.get(periodId) ?? null) : null;
}

/** Sheet target for scoring a dashboard row directly, dated to `adminDate` (today). */
export function targetForRow(vm: RowVM, lk: Lookups, adminDate: IsoDate): SheetTarget {
  const probe = probeOf(vm.goalId, lk);
  return {
    goalId: vm.goalId,
    studentId: vm.studentId,
    initials: vm.initials,
    goalText: vm.goalText,
    periodLabel: vm.periodLabel,
    probeLabel: probe.label,
    expectedDenominator: probe.expectedDenominator,
    variableBasis: lk.variableBasisGoals.has(vm.goalId),
    adminDate,
  };
}

/**
 * Sheet target for scoring a goal directly from Goal Detail. `existingPoint` is
 * passed for an audited [Fix] of a stored point (keeps its admin date + id); it is
 * omitted for "+ Add a point" (a fresh capture dated today).
 */
export function targetForGoal(
  goal: IEPGoal,
  lk: Lookups,
  today: IsoDate,
  existingPoint?: ProgressDataPoint,
): SheetTarget {
  const probe = probeOf(goal.goal_id, lk);
  return {
    goalId: goal.goal_id,
    studentId: goal.student_id,
    initials: lk.initialsById.get(goal.student_id) ?? "??",
    goalText: goal.goal_text,
    periodLabel: periodLabelOf(goal.student_id, lk),
    probeLabel: probe.label,
    expectedDenominator: probe.expectedDenominator,
    variableBasis: goal.denominator_basis === "variable",
    adminDate: existingPoint?.admin_date ?? today,
    ...(existingPoint !== undefined ? { existingPoint } : {}),
  };
}

/** Sheet target for scoring a queued point from the To-Score queue (keeps its admin date + id). */
export function targetForQueued(point: ProgressDataPoint, lk: Lookups): SheetTarget {
  const probe = probeOf(point.goal_id, lk);
  return {
    goalId: point.goal_id,
    studentId: point.student_id,
    initials: lk.initialsById.get(point.student_id) ?? "??",
    goalText: lk.goalTextById.get(point.goal_id) ?? "(goal)",
    periodLabel: periodLabelOf(point.student_id, lk),
    probeLabel: probe.label,
    expectedDenominator: probe.expectedDenominator,
    variableBasis: lk.variableBasisGoals.has(point.goal_id),
    adminDate: point.admin_date,
    existingPoint: point,
  };
}
