// Dashboard view-models — the presentation layer between the M3 store
// projections and the React rows/cards. This holds NO domain rules: which rows
// exist, their state, and the owes-first WITHIN-group ordering all come from
// @teacher-assistant/store (buildWeeklyDashboard / groupDashboard). This module
// only resolves opaque ids → display attributes (initials, goal text, period
// label, scored %), marks the pending-para rows (buildValidationQueue), and
// orders the GROUPS for display (student cards owes-first then by initials;
// period groups by label) — presentation sequencing of engine-grouped data.

import { compareCodePoints } from "@teacher-assistant/domain-core";
import type { NoDataReason, OpaqueId } from "@teacher-assistant/schema";
import {
  buildValidationQueue,
  type DashboardGroup,
  type DashboardRow,
  type DashboardState,
} from "@teacher-assistant/store";
import type { DecryptedRecords } from "../../../data/repository.js";

/** A single dashboard row resolved to display attributes. */
export interface RowVM {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  readonly initials: string;
  readonly goalText: string;
  readonly state: DashboardState;
  readonly periodLabel: string | null;
  readonly value: number | undefined;
  readonly noDataReason: NoDataReason | undefined;
  /** Has an unvalidated para point awaiting the teacher's OK (buildValidationQueue). */
  readonly pending: boolean;
}

/** A by-student card: the student header plus their nested goal rows. */
export interface StudentCardVM {
  readonly studentId: OpaqueId;
  readonly initials: string;
  readonly periodLabels: readonly string[];
  /** Count of rows still owing a point (drives the "N to do" / "✓ done" tally). */
  readonly todo: number;
  readonly rows: readonly RowVM[];
}

/** Resolved lookups over the decrypted records, built once per render. */
export interface Lookups {
  readonly initialsById: ReadonlyMap<string, string>;
  readonly goalTextById: ReadonlyMap<string, string>;
  readonly periodLabelById: ReadonlyMap<string, string>;
  readonly valueByGoal: ReadonlyMap<string, number>;
  readonly pendingGoalIds: ReadonlySet<string>;
  readonly periodByStudent: (studentId: OpaqueId) => OpaqueId | null;
}

export function buildLookups(records: DecryptedRecords): Lookups {
  const initialsById = new Map(records.students.map((s) => [s.student_id, s.initials]));
  const goalTextById = new Map(records.goals.map((g) => [g.goal_id, g.goal_text]));
  const periodLabelById = new Map(records.periods.map((p) => [p.period_id, p.label]));
  const membershipByStudent = new Map(
    records.students.map((s) => [s.student_id, s.period_memberships[0] ?? null]),
  );

  const valueByGoal = new Map<string, number>();
  for (const p of records.points) {
    if (p.state === "scored" && p.computed_value !== undefined) {
      valueByGoal.set(p.goal_id, p.computed_value);
    }
  }
  const pendingGoalIds = new Set(buildValidationQueue(records.points).map((e) => e.goalId));

  return {
    initialsById,
    goalTextById,
    periodLabelById,
    valueByGoal,
    pendingGoalIds,
    periodByStudent: (studentId) => membershipByStudent.get(studentId) ?? null,
  };
}

/** Resolve a period id to its label via the lookups (null when unassigned/unknown). */
function periodLabelFor(studentId: OpaqueId, lk: Lookups): string | null {
  const periodId = lk.periodByStudent(studentId);
  return periodId !== null ? (lk.periodLabelById.get(periodId) ?? null) : null;
}

export function toRowVM(row: DashboardRow, lk: Lookups): RowVM {
  return {
    goalId: row.goalId,
    studentId: row.studentId,
    initials: lk.initialsById.get(row.studentId) ?? "??",
    goalText: lk.goalTextById.get(row.goalId) ?? "(goal)",
    state: row.state,
    periodLabel: periodLabelFor(row.studentId, lk),
    value: lk.valueByGoal.get(row.goalId),
    noDataReason: row.noDataReason,
    pending: lk.pendingGoalIds.has(row.goalId),
  };
}

/** The label a by-period group renders under (its rows share one period). */
export function periodLabelOfGroup(group: DashboardGroup, lk: Lookups): string {
  const first = group.rows[0];
  if (first === undefined) {
    return "Unassigned";
  }
  return periodLabelFor(first.studentId, lk) ?? "Unassigned";
}

/** Order by-period groups by their period label (presentation ordering). */
export function orderPeriodGroups(
  groups: readonly DashboardGroup[],
  lk: Lookups,
): DashboardGroup[] {
  return [...groups].sort((a, b) =>
    compareCodePoints(periodLabelOfGroup(a, lk), periodLabelOfGroup(b, lk)),
  );
}

/**
 * Build by-student cards from the store's by-student groups. Card order is
 * presentation: students who owe a point first, then by initials (design §E.4).
 * Row order within a card is the store's owes-first ordering, untouched.
 */
export function buildStudentCards(groups: readonly DashboardGroup[], lk: Lookups): StudentCardVM[] {
  const cards: StudentCardVM[] = groups.map((group) => {
    const rows = group.rows.map((r) => toRowVM(r, lk));
    const periodLabels = [...new Set(rows.map((r) => r.periodLabel).filter((l) => l !== null))];
    return {
      studentId: group.key as OpaqueId,
      initials: rows[0]?.initials ?? "??",
      periodLabels,
      todo: rows.filter((r) => r.state === "owes").length,
      rows,
    };
  });
  return cards.sort((a, b) => {
    const aTodo = a.todo > 0 ? 0 : 1;
    const bTodo = b.todo > 0 ? 0 : 1;
    return aTodo - bTodo || compareCodePoints(a.initials, b.initials);
  });
}
