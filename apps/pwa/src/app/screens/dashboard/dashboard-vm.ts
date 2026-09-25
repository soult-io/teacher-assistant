// Dashboard view-models — the presentation layer between the M3 store
// projections and the React rows/cards. This holds NO domain rules: which rows
// exist, their state, and the owes-first WITHIN-group ordering all come from
// @teacher-assistant/store (buildWeeklyDashboard / groupDashboard). This module
// only resolves opaque ids → display attributes (initials, goal text, period
// label, scored %), marks the pending-para rows (from the para-doc queue), and
// orders rows and GROUPS for display with the shared display-order comparators
// (TEACH-25) — presentation sequencing of engine-grouped data.

import { compareArcNewestFirst, compareCodePoints } from "@teacher-assistant/domain-core";
import type { NoDataReason, OpaqueId, ProgressDataPoint } from "@teacher-assistant/schema";
import type {
  DashboardGroup,
  DashboardRow,
  DashboardState,
  QueueEntry,
} from "@teacher-assistant/store";
import type { DecryptedRecords } from "../../../data/repository.js";
import {
  compareNumberAware,
  compareOptionalText,
  compareStudentGoal,
  compareDisplayText,
  type StudentGoalSortKey,
} from "../../display-order.js";

/** Goal-definition display fields shown in the owes-row meta (from the goal entity). */
interface GoalMeta {
  /** Progress-monitoring tool, e.g. "5-item probe" (goal.method_tool). */
  readonly probe: string;
  /** Mastery criterion, e.g. "80% × 4 consecutive probes" (level + consistency). */
  readonly criterion: string;
}

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
  /** Has an unvalidated para point awaiting the teacher's OK (from the para-doc queue). */
  readonly pending: boolean;
  /** Glanceable mid-class context for owes rows: probe tool + mastery criterion. */
  readonly probe: string;
  readonly criterion: string;
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
  readonly metaByGoal: ReadonlyMap<string, GoalMeta>;
  /** The assigned probe per goal — its label + expected total (for the score sheet). */
  readonly probeByGoal: ReadonlyMap<
    string,
    { readonly label: string; readonly expectedDenominator: number }
  >;
  /** Goals with a VARIABLE denominator basis (F-2 escape valve) — the sheet skips the off-basis check. */
  readonly variableBasisGoals: ReadonlySet<string>;
  readonly pendingGoalIds: ReadonlySet<string>;
  readonly periodByStudent: (studentId: OpaqueId) => OpaqueId | null;
}

/**
 * Resolve dashboard display lookups from the MASTER records. `paraPendingGoalIds`
 * marks goals that have a para capture awaiting validation — sourced from the para
 * doc's master-truth queue (D3), NOT master points (the para pending no longer live
 * in master), so an owes row still shows the ⏳ "awaiting your OK" cue.
 */
export function buildLookups(
  records: DecryptedRecords,
  paraPendingGoalIds: ReadonlySet<string> = new Set(),
): Lookups {
  const initialsById = new Map(records.students.map((s) => [s.student_id, s.initials]));
  const goalTextById = new Map(records.goals.map((g) => [g.goal_id, g.goal_text]));
  const periodLabelById = new Map(records.periods.map((p) => [p.period_id, p.label]));
  const membershipByStudent = new Map(
    records.students.map((s) => [s.student_id, s.period_memberships[0] ?? null]),
  );
  // Owes-row meta, resolved from goal-definition fields already in hand (no store
  // change): the probe tool + the mastery criterion (level × consistency phrase).
  const metaByGoal = new Map<string, GoalMeta>(
    records.goals.map((g) => [
      g.goal_id,
      {
        probe: g.method_tool,
        criterion: `${g.criterion_level}% × ${g.criterion_consistency.phrase}`,
      },
    ]),
  );

  const valueByGoal = new Map<string, number>();
  for (const p of oldestFirst(records.points)) {
    if (p.state === "scored" && p.computed_value !== undefined) {
      valueByGoal.set(p.goal_id, p.computed_value);
    }
  }
  const pendingGoalIds = paraPendingGoalIds;
  const probeByGoal = new Map(
    records.probes.map((p) => [
      p.goal_id,
      { label: p.label ?? "probe", expectedDenominator: p.expected_denominator },
    ]),
  );
  const variableBasisGoals = new Set(
    records.goals.filter((g) => g.denominator_basis === "variable").map((g) => g.goal_id),
  );

  return {
    initialsById,
    goalTextById,
    periodLabelById,
    valueByGoal,
    metaByGoal,
    probeByGoal,
    variableBasisGoals,
    pendingGoalIds,
    periodByStudent: (studentId) => membershipByStudent.get(studentId) ?? null,
  };
}

/**
 * Points oldest first (the reverse of the ARC history order), so a per-goal
 * "last one wins" Map keeps the NEWEST point rather than whichever came last in
 * record order (TEACH-25).
 */
export function oldestFirst(points: readonly ProgressDataPoint[]): ProgressDataPoint[] {
  return [...points].sort((a, b) => compareArcNewestFirst(b, a));
}

export function toRowVM(row: DashboardRow, lk: Lookups): RowVM {
  // Label off the store-computed row.periodId — the single source for the period,
  // so the label can never contradict the by-period bucket keyed on the same id.
  const periodLabel = row.periodId !== null ? (lk.periodLabelById.get(row.periodId) ?? null) : null;
  const meta = lk.metaByGoal.get(row.goalId);
  return {
    goalId: row.goalId,
    studentId: row.studentId,
    initials: lk.initialsById.get(row.studentId) ?? "??",
    goalText: lk.goalTextById.get(row.goalId) ?? "(goal)",
    state: row.state,
    periodLabel,
    value: lk.valueByGoal.get(row.goalId),
    noDataReason: row.noDataReason,
    pending: lk.pendingGoalIds.has(row.goalId),
    probe: meta?.probe ?? "",
    criterion: meta?.criterion ?? "",
  };
}

/**
 * Order a group's rows for display: a student's goals stay ADJACENT and
 * alphabetized (design D1 / §E; TEACH-25) — initials, period label, studentId,
 * goal text, with goalId only for true duplicates. Presentation sequencing only;
 * the store's grouping is untouched.
 */
export function orderRowsByStudent(rows: readonly RowVM[]): RowVM[] {
  return [...rows].sort(
    (a, b) => compareStudentGoal(a, b) || compareCodePoints(a.goalId, b.goalId),
  );
}

/** The on-screen sort key of a student's goal, resolved from the lookups (as toRowVM shows it). */
export function studentGoalKey(
  studentId: OpaqueId,
  goalId: OpaqueId,
  lk: Lookups,
): StudentGoalSortKey {
  const periodId = lk.periodByStudent(studentId);
  return {
    initials: lk.initialsById.get(studentId) ?? "??",
    periodLabel: periodId !== null ? (lk.periodLabelById.get(periodId) ?? null) : null,
    studentId,
    goalText: lk.goalTextById.get(goalId) ?? "(goal)",
  };
}

/**
 * The To-Score queue in display order: the dashboard's student-goal order, then
 * the collected admin date (oldest first), then the point id for true duplicates.
 * The store's buildToScoreQueue keeps record order, which is not stable.
 */
export function orderToScoreQueue(queue: readonly QueueEntry[], lk: Lookups): QueueEntry[] {
  return [...queue].sort(
    (a, b) =>
      compareStudentGoal(
        studentGoalKey(a.studentId, a.goalId, lk),
        studentGoalKey(b.studentId, b.goalId, lk),
      ) ||
      compareCodePoints(a.adminDate, b.adminDate) ||
      compareCodePoints(a.dataPointId, b.dataPointId),
  );
}

/**
 * The para-validation queue in display order: admin date first (the confirm
 * batch stays chronological, as orderPendingForValidation), then the
 * student-goal order, then entry time, then the point id for true duplicates.
 */
export function orderValidationQueue(
  queue: readonly ProgressDataPoint[],
  lk: Lookups,
): ProgressDataPoint[] {
  return [...queue].sort(
    (a, b) =>
      compareCodePoints(a.admin_date, b.admin_date) ||
      compareStudentGoal(
        studentGoalKey(a.student_id, a.goal_id, lk),
        studentGoalKey(b.student_id, b.goal_id, lk),
      ) ||
      a.entry_ts - b.entry_ts ||
      compareCodePoints(a.data_point_id, b.data_point_id),
  );
}

/**
 * The right-hand value text for a row, shared by the flat GoalRow and the nested
 * StudentCard: the scored % or the ⊘ no-data reason, or null when the goal owes
 * (the flat row hides the value and shows the score-later flag; the card renders
 * a plain "owes"). One source of truth for state → value display.
 */
export function rowValueText(vm: RowVM): string | null {
  if (vm.state === "has_point" && vm.value !== undefined) {
    return `${Math.round(vm.value * 100)}%`;
  }
  if (vm.state === "documented_no_data") {
    return `⊘ ${vm.noDataReason ?? "excused"}`;
  }
  return null;
}

/**
 * The label a by-period group renders under. The store buckets by-period on
 * `row.periodId`, so the group key IS the period id (or the literal "unassigned"
 * for rows with no period) — resolve the label straight off it.
 */
export function periodLabelOfGroup(group: DashboardGroup, lk: Lookups): string {
  return lk.periodLabelById.get(group.key) ?? "Unassigned";
}

/**
 * Order by-period groups by their period label, number-aware ("Period 2" before
 * "Period 10"), then the group key (periodId) for equal labels.
 */
export function orderPeriodGroups(
  groups: readonly DashboardGroup[],
  lk: Lookups,
): DashboardGroup[] {
  return [...groups].sort(
    (a, b) =>
      compareNumberAware(periodLabelOfGroup(a, lk), periodLabelOfGroup(b, lk)) ||
      compareCodePoints(a.key, b.key),
  );
}

/**
 * Build by-student cards from the store's by-student groups. Card order is
 * presentation: students who owe a point first, then initials, then the card's
 * first period label (none last), then studentId (design §E.4; TEACH-25). Rows
 * within a card follow orderRowsByStudent, so a student's goals read A–Z.
 */
export function buildStudentCards(groups: readonly DashboardGroup[], lk: Lookups): StudentCardVM[] {
  const cards: StudentCardVM[] = groups.map((group) => {
    const rows = orderRowsByStudent(group.rows.map((r) => toRowVM(r, lk)));
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
    return (
      aTodo - bTodo ||
      compareDisplayText(a.initials, b.initials) ||
      compareOptionalText(a.periodLabels[0] ?? null, b.periodLabels[0] ?? null) ||
      compareCodePoints(a.studentId, b.studentId)
    );
  });
}
