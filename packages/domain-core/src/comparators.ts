// Deterministic comparators for output ordering. NEVER String.prototype.localeCompare
// (locale-dependent, host-varying — banned by the vendored GritQL biome plugin).

import type { ProgressDataPoint } from "@teacher-assistant/schema";

/**
 * Deterministic code-point string comparator. Use for any output ordering
 * (diff-friendly tables, admin-date sorts, dedup tiebreaks). ISO dates and opaque
 * ids are ASCII, so this is also their correct chronological/stable order.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

type ArcOrdered = Pick<ProgressDataPoint, "admin_date" | "entry_ts" | "data_point_id">;

/**
 * The ARC-history order (TEACH-25): admin date newest first, then entry time
 * newest first, then the point id. The chart plots in the exact reverse
 * (`compareArcOldestFirst`), so same-day points read in matching order in both.
 */
export function compareArcNewestFirst(a: ArcOrdered, b: ArcOrdered): number {
  return (
    compareCodePoints(b.admin_date, a.admin_date) ||
    b.entry_ts - a.entry_ts ||
    compareCodePoints(a.data_point_id, b.data_point_id)
  );
}

/**
 * Oldest-first order: the exact reverse of compareArcNewestFirst (so a full
 * date + entry-time tie comes out with the point id DESCENDING). This is the ONE
 * order every grading and summary site uses (TEACH-27): the chart, the consistency
 * window, the F4 last-5 window, the statement's trend/prior windows and the IC
 * weekly value — so a same-day tie is settled by entry time, never by an id.
 */
export function compareArcOldestFirst(a: ArcOrdered, b: ArcOrdered): number {
  return compareArcNewestFirst(b, a);
}

/** Case-insensitive display compare (trim + toLowerCase, code point), raw text breaks ties. */
export function compareDisplayText(a: string, b: string): number {
  return (
    compareCodePoints(a.trim().toLowerCase(), b.trim().toLowerCase()) || compareCodePoints(a, b)
  );
}

/** Compare two ASCII digit runs by numeric value without Number (no precision loss). */
function compareDigitRuns(a: string, b: string): number {
  const x = a.replace(/^0+/, "");
  const y = b.replace(/^0+/, "");
  return x.length - y.length || compareCodePoints(x, y);
}

/** Normalized text split into digit and non-digit runs. */
function runsOf(s: string): string[] {
  return (
    s
      .trim()
      .toLowerCase()
      .match(/\d+|\D+/g) ?? []
  );
}

/**
 * Number-aware display compare for labels like "Period 2" / "Period 10": the
 * normalized text is split into digit and non-digit runs; digit runs compare
 * numerically, the rest case-insensitively by code point. Equal-valued labels
 * ("P02" vs "P2", "p2" vs "P2") fall back to compareDisplayText, so it is total.
 */
export function compareNumberAware(a: string, b: string): number {
  const ra = runsOf(a);
  const rb = runsOf(b);
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i += 1) {
    const x = ra[i] ?? "";
    const y = rb[i] ?? "";
    const cmp = /^\d/.test(x) && /^\d/.test(y) ? compareDigitRuns(x, y) : compareCodePoints(x, y);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return ra.length - rb.length || compareDisplayText(a, b);
}

/**
 * IEP goal-label order (TEACH-41): number-aware, so 1 < 1a < 2 < 10; a goal with
 * no label sorts LAST. Two unlabeled goals compare equal — the caller breaks the
 * tie (goal text, then goal id).
 */
export function compareGoalLabel(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined) {
    return (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0);
  }
  return compareNumberAware(a, b);
}
