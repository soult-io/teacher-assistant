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
  /** Has an unvalidated para point awaiting the teacher's OK (buildValidationQueue). */
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

export function buildLookups(records: DecryptedRecords): Lookups {
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
  for (const p of records.points) {
    if (p.state === "scored" && p.computed_value !== undefined) {
      valueByGoal.set(p.goal_id, p.computed_value);
    }
  }
  const pendingGoalIds = new Set(buildValidationQueue(records.points).map((e) => e.goalId));
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
 * alphabetized (design D1 / §E) — sort by initials, then a stable goal-id
 * tiebreak. Presentation sequencing only; the store's grouping is untouched.
 */
export function orderRowsByStudent(rows: readonly RowVM[]): RowVM[] {
  return [...rows].sort(
    (a, b) => compareCodePoints(a.initials, b.initials) || compareCodePoints(a.goalId, b.goalId),
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
 * Rows within a card are ordered by initials → goal-id (orderRowsByStudent) so a
 * student's goals stay adjacent (§E); the store's grouping is untouched.
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
    return aTodo - bTodo || compareCodePoints(a.initials, b.initials);
  });
}
