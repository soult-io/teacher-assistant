// M6a — IEP % → Infinite Campus export (Engine A, data-model §9.1, design §F.F4 /
// FERPA Item-3a). Client-side generated, copy-to-IC, MANUAL — never auto-pushed,
// and the server never assembles it (it cannot read plaintext).
//
// STRUCTURAL export guard (HARD, FERPA): the exporter iterates ONLY goals that are
// active AND baselined AND have a consistency criterion. A proposed/baseline goal
// is UNREACHABLE — there is no per-goal override, so it cannot reach IC by any
// path. Two engines stay separate; no %↔rubric coercion.

import type {
  IEPGoal,
  IsoDate,
  NoDataReason,
  OpaqueId,
  ProgressDataPoint,
} from "@teacher-assistant/schema";
import { compareCodePoints } from "./comparators.js";
import { isoWeekId } from "./instructional-weeks.js";
import { computeQuarterlySummary, type QuarterlySummary } from "./quarterly.js";
import { percentCorrect } from "./value.js";

/** One IC weekly monitoring row — a scored value, or a ⊘ row that explains the gap (never a fabricated 0). */
export interface IcWeeklyRow {
  readonly isoWeek: string;
  readonly weekOf: IsoDate;
  readonly numerator: number | null;
  readonly denominator: number | null;
  /** Percent for a scored row; null for a ⊘ row. */
  readonly percent: number | null;
  readonly state: "scored" | "no_data";
  readonly noDataReason?: NoDataReason;
}

/** A per-goal IC export card (the three blocks; the draft statement is M8). */
export interface IcGoalExport {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  /** (a) One value per instructional week, in week order. */
  readonly weekly: readonly IcWeeklyRow[];
  /** (b) The F4 quarterly 5-point summary. */
  readonly quarterly: QuarterlySummary;
  /** (c) Draft progress statement — filled by M8; null here. */
  readonly draftStatement: null;
}

/**
 * The structural export guard: a goal is IC-exportable ONLY if it is active AND
 * baselined AND carries a consistency criterion. A proposed/baseline goal (or one
 * missing a baseline) returns false and is therefore unreachable by buildIcExport.
 */
export function isIcExportable(goal: IEPGoal): boolean {
  return (
    goal.status === "active" &&
    goal.baseline_value !== undefined &&
    goal.baseline_source !== undefined &&
    goal.criterion_consistency.n_probes >= 2
  );
}

/** Pick the single representative point for a week: a scored point wins over a ⊘; latest admin-date otherwise. */
function pickWeekPoint(weekPoints: ProgressDataPoint[]): ProgressDataPoint | undefined {
  const ordered = [...weekPoints].sort((a, b) => compareCodePoints(b.admin_date, a.admin_date));
  return ordered.find((p) => p.state === "scored") ?? ordered[0];
}

/** The IC row for one week's representative point (a scored % value, or a ⊘ gap row). MVP is %-only. */
function toWeeklyRow(week: string, p: ProgressDataPoint): IcWeeklyRow {
  if (p.state === "scored") {
    const num = p.numerator ?? 0;
    const den = p.denominator_used ?? 0;
    return {
      isoWeek: week,
      weekOf: p.admin_date,
      numerator: num,
      denominator: den,
      percent: percentCorrect(num, den),
      state: "scored",
    };
  }
  return {
    isoWeek: week,
    weekOf: p.admin_date,
    numerator: null,
    denominator: null,
    percent: null,
    state: "no_data",
    ...(p.no_data_reason !== undefined ? { noDataReason: p.no_data_reason } : {}),
  };
}

function weeklyRows(points: readonly ProgressDataPoint[]): IcWeeklyRow[] {
  const byWeek = new Map<string, ProgressDataPoint[]>();
  for (const p of points) {
    // in-progress points (queued/incomplete/pending) are not IC monitoring values
    if (p.state === "scored" || p.state === "no_data") {
      const week = isoWeekId(p.admin_date);
      const bucket = byWeek.get(week) ?? [];
      bucket.push(p);
      byWeek.set(week, bucket);
    }
  }
  const rows: IcWeeklyRow[] = [];
  for (const week of [...byWeek.keys()].sort(compareCodePoints)) {
    const p = pickWeekPoint(byWeek.get(week) ?? []);
    if (p !== undefined) {
      rows.push(toWeeklyRow(week, p));
    }
  }
  return rows;
}

/**
 * Build the IC export cards for the exportable goals only. Proposed/baseline goals
 * are filtered out by the structural guard and produce NO output — there is no
 * code path that emits an IC block for them. (Quarterly-window clamping across a
 * criterion/denominator change is a `computeQuarterlySummary` option wired in when
 * goal-edit history is available.)
 */
export function buildIcExport(
  goals: readonly IEPGoal[],
  points: readonly ProgressDataPoint[],
): IcGoalExport[] {
  return goals.filter(isIcExportable).map((goal) => {
    const mine = points.filter((p) => p.goal_id === goal.goal_id);
    return {
      goalId: goal.goal_id,
      studentId: goal.student_id,
      weekly: weeklyRows(mine),
      quarterly: computeQuarterlySummary(goal, mine),
      draftStatement: null,
    };
  });
}
