// M6a — F4 quarterly summary (data-model §6.1, design §F.F4). The
// most-recent-5 SCORED points by admin-date: ⊘ excluded from the average but the
// no-data count SPANNED is shown; < 5 scored → average what exists + label n
// (never pad with zeros); the window CLAMPS at a criterion / denominator-model
// change and a mismatched point is excluded + surfaced. A DIFFERENT IC
// destination than the weekly value — never overwrites it.

import type { IEPGoal, IsoDate, ProgressDataPoint } from "@teacher-assistant/schema";
import { compareCodePoints } from "./comparators.js";
import { isoWeekId } from "./instructional-weeks.js";
import { computeValue } from "./value.js";

const WINDOW = 5;

export interface QuarterlySummary {
  /** Scored points averaged (≤ 5; fewer if fewer exist — never zero-padded). */
  readonly n: number;
  /** Average value per the goal's method (% for the % model); null if no scored points. */
  readonly average: number | null;
  /** Admin-date range the averaged points span, or null if none. */
  readonly dateRange: { readonly start: IsoDate; readonly end: IsoDate } | null;
  /** ⊘ (no-data) points spanned by the window — shown so the gap is explained. */
  readonly noDataCountSpanned: number;
  /** True if mismatched points were excluded (the window isn't single-denominator). */
  readonly mixedDenominator: boolean;
  readonly excludedMismatches: number;
  readonly label: "quarterly progress summary";
}

export interface QuarterlyOptions {
  /**
   * The admin date of the most recent criterion-level or denominator-model change
   * for this goal (from the goal's edit history). The window clamps to points on
   * or after it, so the average never crosses that boundary. Omit when no such
   * change exists (the MVP case).
   */
  readonly clampAfter?: IsoDate;
}

/**
 * Compute the F4 quarterly summary for a goal. Averages the most-recent-5 SCORED,
 * non-mismatched points (clamped at `clampAfter`), counts the ⊘ spanned, and never
 * pads with zeros.
 */
export function computeQuarterlySummary(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
  options: QuarterlyOptions = {},
): QuarterlySummary {
  const mine = points.filter((p) => p.goal_id === goal.goal_id);
  const clampAfter = options.clampAfter;

  const scored = mine
    .filter((p) => p.state === "scored" && (clampAfter === undefined || p.admin_date >= clampAfter))
    // Admin-date order, with a data_point_id tiebreak so window membership is
    // deterministic when two points share an admin date.
    .sort(
      (a, b) =>
        compareCodePoints(a.admin_date, b.admin_date) ||
        compareCodePoints(a.data_point_id, b.data_point_id),
    );

  const mismatched = scored.filter((p) => p.denominator_mismatch === true);
  const comparable = scored.filter((p) => p.denominator_mismatch !== true);

  // Most-recent-5 comparable points by admin-date (the tail of the ascending list).
  const window = comparable.slice(Math.max(0, comparable.length - WINDOW));
  const n = window.length;

  if (n === 0) {
    // No averageable points; still warn if any mismatch was excluded.
    return {
      n: 0,
      average: null,
      dateRange: null,
      noDataCountSpanned: 0,
      mixedDenominator: mismatched.length > 0,
      excludedMismatches: mismatched.length,
      label: "quarterly progress summary",
    };
  }

  const values = window.map(
    (p) => computeValue(goal.denominator_model, p.numerator ?? 0, p.denominator_used ?? 0).value,
  );
  const average = values.reduce((sum, v) => sum + v, 0) / n;
  const start = window[0]?.admin_date as IsoDate;
  const end = window[n - 1]?.admin_date as IsoDate;

  // Distinct no-data WEEKS spanned (data-model §6.1 counts weeks, not points).
  const noDataWeeks = new Set<string>();
  for (const p of mine) {
    if (p.state === "no_data" && p.admin_date >= start && p.admin_date <= end) {
      noDataWeeks.add(isoWeekId(p.admin_date));
    }
  }

  // Scope the mismatch warning to the averaged window's recent region (≥ its start),
  // so a stale OLD mismatched point doesn't over-warn; a recent one still does.
  const excludedMismatches = mismatched.filter((p) => p.admin_date >= start).length;

  return {
    n,
    average,
    dateRange: { start, end },
    noDataCountSpanned: noDataWeeks.size,
    mixedDenominator: excludedMismatches > 0,
    excludedMismatches,
    label: "quarterly progress summary",
  };
}
