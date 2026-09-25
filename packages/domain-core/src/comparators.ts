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
