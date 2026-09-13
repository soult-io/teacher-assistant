// M3 — queryable projections over already-decrypted in-memory records
// (architecture §2 M3, data-model §6, design §A.2/§E.4). Pure functions: the
// decryption happens in the sync/keyring layer; this module only shapes the
// decrypted goals/points into view models.
//
// Locked rules enforced here:
//   - The weekly dashboard has exactly THREE states — has-point / documented-
//     no-data / owes (design §A.2).
//   - Exactly THREE grouping lenses — owes-first → by period → by student (§E.4).
//   - A proposed/baseline goal NEVER reaches the active weekly dashboard or its
//     owes math (data-model §10.3); baseline data lives only in the segregated
//     baseline view.
//   - Break weeks generate no owes by construction (M4 instructional-weeks).

import {
  compareCodePoints,
  isCalendarInstructional,
  isDueInWeek,
  isoWeekId,
} from "@teacher-assistant/domain-core";
import type {
  BaselinePoint,
  IEPGoal,
  NoDataReason,
  OpaqueId,
  ProgressDataPoint,
} from "@teacher-assistant/schema";
import { bucketBy } from "./group.js";

/** A week is "excused" for a goal only for these ⊘ reasons (design §A.2). Behavior/no_time are documented but not excused. */
const EXCUSED_REASONS: ReadonlySet<NoDataReason> = new Set<NoDataReason>([
  "absent",
  "testing",
  "no_school",
]);

/** The three dashboard states (design §A.2). */
export type DashboardState = "has_point" | "documented_no_data" | "owes";

export interface DashboardRow {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  /** The monitoring period for grouping (Phase-0: the student's resolved period; null if unresolved). */
  readonly periodId: OpaqueId | null;
  readonly state: DashboardState;
  /** True only for a documented ⊘ with an excused reason (absent/testing/no_school). */
  readonly excused: boolean;
  readonly noDataReason?: NoDataReason;
}

export interface DashboardHeader {
  readonly scored: number;
  readonly collectable: number;
  readonly excused: number;
  readonly owe: number;
}

export interface WeeklyDashboard {
  readonly week: string;
  readonly rows: readonly DashboardRow[];
  readonly header: DashboardHeader;
}

export interface WeeklyDashboardInput {
  readonly goals: readonly IEPGoal[];
  readonly points: readonly ProgressDataPoint[];
  /** Evaluation date; its ISO week is the dashboard week. */
  readonly asOf: string | Date;
  /** Calendar break flag (M4). A break week yields an empty, zero-owes dashboard. */
  readonly isNonInstructional: (weekId: string) => boolean;
  /** Resolve a student's monitoring period for the by-period lens (Phase-0: single period). */
  readonly periodByStudent?: (studentId: OpaqueId) => OpaqueId | null;
}

/**
 * Build the active weekly dashboard for the ISO week of `asOf`. Only `active`
 * goals appear — proposed/baseline goals are excluded by construction. On a
 * calendar break week there are no collectable goals, so the dashboard is empty
 * and owes are zero.
 *
 * Owes cadence is per-goal `frequency` (M5 `isDueInWeek`): weekly/daily are due
 * every instructional week, monthly/twice_monthly only on their cadence week — a
 * goal not due this week and with no point this week is omitted (it does not owe).
 * An in-progress point (queued/incomplete/pending) is surfaced by the to-score /
 * validation queues; with only such a point a goal still "owes" a completed
 * score, consistent with the locked three-state model (no in-progress state).
 */
export function buildWeeklyDashboard(input: WeeklyDashboardInput): WeeklyDashboard {
  const week = isoWeekId(input.asOf);
  const emptyHeader: DashboardHeader = { scored: 0, collectable: 0, excused: 0, owe: 0 };
  if (!isCalendarInstructional(week, input.isNonInstructional)) {
    return { week, rows: [], header: emptyHeader };
  }

  const rows: DashboardRow[] = [];
  for (const goal of input.goals) {
    if (goal.status !== "active") {
      continue; // proposed/baseline/mastered/retired never enter the active dashboard
    }
    const weekPoints = input.points.filter(
      (p) => p.goal_id === goal.goal_id && isoWeekId(p.admin_date) === week,
    );
    // Per-goal frequency drives owes (M5): a goal not due this week and with no
    // point this week is simply not on the board — it does not owe. (weekly/daily
    // are due every instructional week, so the Phase-0 behaviour is unchanged.)
    const due = isDueInWeek(goal.frequency, week, input.isNonInstructional);
    if (!due && weekPoints.length === 0) {
      continue;
    }
    const scored = weekPoints.some((p) => p.state === "scored");
    const noData = weekPoints.find((p) => p.state === "no_data");

    let state: DashboardState;
    let excused = false;
    let noDataReason: NoDataReason | undefined;
    if (scored) {
      state = "has_point";
    } else if (noData !== undefined) {
      state = "documented_no_data";
      noDataReason = noData.no_data_reason;
      excused = noDataReason !== undefined && EXCUSED_REASONS.has(noDataReason);
    } else {
      state = "owes";
    }

    const periodId = input.periodByStudent?.(goal.student_id) ?? null;
    rows.push({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      periodId,
      state,
      excused,
      // Conditional spread: omit the key entirely when absent (exactOptionalPropertyTypes).
      ...(noDataReason !== undefined ? { noDataReason } : {}),
    });
  }

  const excusedCount = rows.filter((r) => r.excused).length;
  const header: DashboardHeader = {
    scored: rows.filter((r) => r.state === "has_point").length,
    // "collectable" excludes excused goals — you could not collect those this week.
    collectable: rows.length - excusedCount,
    excused: excusedCount,
    owe: rows.filter((r) => r.state === "owes").length,
  };
  return { week, rows, header };
}

/**
 * Render the locked header string (design §A.2). The scored count always shows;
 * the excused / owe segments are omitted when zero (prototype behaviour — a
 * fully-scored week reads "4 of 4 collectable scored", not "· 0 excused · 0 owe").
 */
export function renderHeader(h: DashboardHeader): string {
  let out = `${h.scored} of ${h.collectable} collectable scored`;
  if (h.excused > 0) {
    out += ` · ${h.excused} excused`;
  }
  if (h.owe > 0) {
    out += ` · ${h.owe} owe`;
  }
  return out;
}

// ── Grouping lenses (§E.4) ───────────────────────────────────────────────────

/** The three grouping lenses, in toggle order. */
export type DashboardLens = "owes_first" | "by_period" | "by_student";

/** Cycle owes-first → by period → by student → owes-first. */
export function nextLens(lens: DashboardLens): DashboardLens {
  switch (lens) {
    case "owes_first":
      return "by_period";
    case "by_period":
      return "by_student";
    case "by_student":
      return "owes_first";
  }
}

export interface DashboardGroup {
  readonly key: string;
  readonly rows: readonly DashboardRow[];
}

const STATE_RANK: Readonly<Record<DashboardState, number>> = {
  owes: 0,
  documented_no_data: 1,
  has_point: 2,
};

/** Owes-first ordering, with a deterministic goal-id tiebreak (never locale-dependent). */
function owesFirst(rows: readonly DashboardRow[]): DashboardRow[] {
  return [...rows].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || compareCodePoints(a.goalId, b.goalId),
  );
}

function groupByKey(
  rows: readonly DashboardRow[],
  keyOf: (r: DashboardRow) => string,
): DashboardGroup[] {
  const groups = bucketBy(rows, keyOf);
  return [...groups.keys()]
    .sort(compareCodePoints)
    .map((key) => ({ key, rows: owesFirst(groups.get(key) ?? []) }));
}

/**
 * Group the dashboard rows by the chosen lens. owes-first is a single group with
 * owes at the top; by-period and by-student bucket by that key (owes-first within
 * each). Keys and ordering are deterministic.
 */
export function groupDashboard(
  rows: readonly DashboardRow[],
  lens: DashboardLens,
): DashboardGroup[] {
  switch (lens) {
    case "owes_first":
      return [{ key: "all", rows: owesFirst(rows) }];
    case "by_period":
      return groupByKey(rows, (r) => r.periodId ?? "unassigned");
    case "by_student":
      return groupByKey(rows, (r) => r.studentId);
  }
}

// ── Other projections (data-model §6) ────────────────────────────────────────

export interface BaselineViewRow {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  readonly pointCount: number;
  /** Mean of the collected baseline points' computed values, or null if < 3 (not yet usable). */
  readonly estimate: number | null;
  /** Usable only at ≥ 3 comparable points (data-model §2.2); always an ESTIMATE, never a trend. */
  readonly usable: boolean;
  readonly label: "estimate";
}

/**
 * The segregated baseline view: proposed goals + their baseline points only.
 * Kept entirely separate from the active dashboard so baseline data can never be
 * mistaken for monitoring data (data-model §2.2/§10.3).
 */
export function buildBaselineView(
  goals: readonly IEPGoal[],
  baselinePoints: readonly BaselinePoint[],
): BaselineViewRow[] {
  const rows: BaselineViewRow[] = [];
  for (const goal of goals) {
    if (goal.status !== "proposed") {
      continue;
    }
    const pts = baselinePoints.filter((p) => p.goal_id === goal.goal_id);
    // Guard against a bad synthetic point with a zero/negative denominator (no
    // Infinity/NaN in the estimate); usability counts only comparable points.
    const valid = pts.filter((p) => p.denominator_used > 0);
    const usable = valid.length >= 3;
    const estimate = usable
      ? valid.reduce((sum, p) => sum + p.numerator / p.denominator_used, 0) / valid.length
      : null;
    rows.push({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      pointCount: pts.length,
      estimate,
      usable,
      label: "estimate",
    });
  }
  return rows;
}

export interface QueueEntry {
  readonly dataPointId: OpaqueId;
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  readonly adminDate: string;
  readonly state: ProgressDataPoint["state"];
}

function toQueueEntry(p: ProgressDataPoint): QueueEntry {
  return {
    dataPointId: p.data_point_id,
    goalId: p.goal_id,
    studentId: p.student_id,
    adminDate: p.admin_date,
    state: p.state,
  };
}

/** The to-score queue: points captured but not yet scored (started/holding). */
export function buildToScoreQueue(points: readonly ProgressDataPoint[]): QueueEntry[] {
  return points.filter((p) => p.state === "queued" || p.state === "incomplete").map(toQueueEntry);
}

/** The validation queue: para-entered points awaiting teacher validation (data-model §2.4). */
export function buildValidationQueue(points: readonly ProgressDataPoint[]): QueueEntry[] {
  return points
    .filter((p) => p.scorer === "para" && p.validated_by === undefined)
    .map(toQueueEntry);
}
