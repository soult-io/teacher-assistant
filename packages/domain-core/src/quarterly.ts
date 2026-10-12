// M6a — F4 quarterly summary (data-model §6.1, design §F.F4). The
// most-recent-5 SCORED points by admin-date: ⊘ excluded from the average but the
// no-data count SPANNED is shown; < 5 scored → average what exists + label n
// (never pad with zeros); the window CLAMPS at a criterion / denominator-model
// change (before the disposition) and a mismatched point is excluded + surfaced
// unless the teacher elects it "counted" (F-2, flagged off-basis). A DIFFERENT IC
// destination than the weekly value — never overwrites it.

import type { IEPGoal, IsoDate, ProgressDataPoint, Revision } from "@teacher-assistant/schema";
import { compareArcOldestFirst } from "./comparators.js";
import { isoWeekId } from "./instructional-weeks.js";
import { inComputedMath, isCountedOffBasis, isUnresolvedMismatch } from "./mismatch.js";
import { computeValue } from "./value.js";

/** The F4 most-recent-N window size — one reporting period (data-model §6.1). */
export const QUARTERLY_WINDOW = 5;

export interface QuarterlySummary {
  /** Scored points averaged (≤ 5; fewer if fewer exist — never zero-padded). */
  readonly n: number;
  /** Average value per the goal's method (% for the % model); null if no scored points. */
  readonly average: number | null;
  /** Admin-date range the averaged points span, or null if none. */
  readonly dateRange: { readonly start: IsoDate; readonly end: IsoDate } | null;
  /** Distinct no-data WEEKS spanned by the window — shown so the gap is explained. */
  readonly noDataCountSpanned: number;
  /** True if the window blends off-basis points (some excluded, or some teacher-counted). */
  readonly mixedDenominator: boolean;
  /** Mismatched points NOT averaged (resolved-excluded + pending). */
  readonly excludedMismatches: number;
  /** Mismatched points the teacher elected "counted" — IN the average, flagged off-basis. */
  readonly countedOffBasis: number;
  /** Mismatched points with no disposition yet — out of the average, surfaced unresolved. */
  readonly unresolvedMismatches: number;
  /** True when the window was clamped at a criterion-level / denominator-model change (§F.F4). */
  readonly clampedAtChange: boolean;
  readonly label: "quarterly progress summary";
}

export interface QuarterlyOptions {
  /**
   * The admin date of the most recent criterion-level or denominator-model change
   * for this goal (derive with clampAfterFromRevisions). The window clamps to
   * points on or after it, so the average never crosses that boundary. Omit when
   * no such change exists.
   */
  readonly clampAfter?: IsoDate;
}

/** Keys whose change invalidates averaging across the boundary (§F.F4 / §G). */
const CLAMP_KEYS = ["criterion_level", "denominator_model"] as const;

function revisionTouchesClampKey(rev: Revision): boolean {
  const keysOf = (o: unknown): string[] =>
    typeof o === "object" && o !== null ? Object.keys(o) : [];
  const changed = new Set([...keysOf(rev.old), ...keysOf(rev.new)]);
  return CLAMP_KEYS.some((k) => changed.has(k));
}

/**
 * Derive the F4 clamp boundary from a goal's edit history: the admin date of the
 * most recent revision that changed the criterion level or denominator model, so
 * the quarterly average never blends points from before that change with points
 * after it (the report-card-indefensible figure §F.F4 forbids). Returns undefined
 * when the goal has no such change (the MVP case).
 */
export function clampAfterFromRevisions(goal: IEPGoal): IsoDate | undefined {
  let latest: number | undefined;
  for (const rev of goal.revisions) {
    if (revisionTouchesClampKey(rev) && (latest === undefined || rev.when > latest)) {
      latest = rev.when;
    }
  }
  if (latest === undefined) {
    return undefined;
  }
  return new Date(latest).toISOString().slice(0, 10) as IsoDate;
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
    // The shared oldest-first order (admin date, then entry time, then id) — so when
    // two points share an admin date, window membership follows entry time, never
    // an arbitrary id (TEACH-27).
    .sort(compareArcOldestFirst);

  // Averageable = not-mismatched OR teacher-elected "counted" (clamp already applied).
  const comparable = scored.filter(inComputedMath);
  // Mismatched points NOT averaged (resolved-excluded + pending) — the complement
  // of inComputedMath (a clean point is always in the math).
  const notAveraged = scored.filter((p) => !inComputedMath(p));

  // Most-recent-5 comparable points by admin-date (the tail of the ascending list).
  const window = comparable.slice(Math.max(0, comparable.length - QUARTERLY_WINDOW));
  const n = window.length;

  if (n === 0) {
    // No averageable points; still warn if any mismatch was excluded/pending.
    return {
      n: 0,
      average: null,
      dateRange: null,
      noDataCountSpanned: 0,
      mixedDenominator: notAveraged.length > 0,
      excludedMismatches: notAveraged.length,
      countedOffBasis: 0,
      unresolvedMismatches: scored.filter(isUnresolvedMismatch).length,
      clampedAtChange: clampAfter !== undefined,
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
  const excludedMismatches = notAveraged.filter((p) => p.admin_date >= start).length;
  // Off-basis points teacher-counted INTO the averaged window (flag the average).
  const countedOffBasis = window.filter(isCountedOffBasis).length;
  const unresolvedMismatches = scored.filter(
    (p) => isUnresolvedMismatch(p) && p.admin_date >= start,
  ).length;

  return {
    n,
    average,
    dateRange: { start, end },
    noDataCountSpanned: noDataWeeks.size,
    mixedDenominator: excludedMismatches > 0 || countedOffBasis > 0,
    excludedMismatches,
    countedOffBasis,
    unresolvedMismatches,
    clampedAtChange: clampAfter !== undefined,
    label: "quarterly progress summary",
  };
}
