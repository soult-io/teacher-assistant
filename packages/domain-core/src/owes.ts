// M5 — per-goal frequency drives "owes" (design §B). Closes the Phase-0 weekly
// default: a twice-monthly/monthly goal must NOT read as owing every week. Due-ness
// is calendar-based (independent of the goal's point history) so a brand-new goal
// is still due. A break week is never due (the WEEK axis, via M4).

import type { Frequency } from "@teacher-assistant/schema";
import { isCalendarInstructional, isoWeekId, isoWeekStart } from "./instructional-weeks.js";

/** Period key for a monthly cadence: the Monday's calendar year+month. */
function monthlyKey(monday: Date): string {
  return `${monday.getUTCFullYear()}-${monday.getUTCMonth()}`;
}

/** Period key for a twice-monthly cadence: the month plus which half (days 1–15 / 16–end). */
function halfMonthKey(monday: Date): string {
  return `${monthlyKey(monday)}-${monday.getUTCDate() <= 15 ? 0 : 1}`;
}

/** True if `weekId` is the FIRST instructional week of its cadence period. */
function isFirstInstructionalOfPeriod(
  weekId: string,
  isNonInstructional: (weekId: string) => boolean,
  keyOf: (monday: Date) => string,
): boolean {
  const myKey = keyOf(isoWeekStart(weekId));
  const cursor = isoWeekStart(weekId);
  // Walk back within the same period; any earlier instructional week means this one isn't first.
  for (;;) {
    cursor.setUTCDate(cursor.getUTCDate() - 7);
    if (keyOf(cursor) !== myKey) {
      return true; // left the period without finding an earlier instructional week
    }
    if (isCalendarInstructional(isoWeekId(cursor), isNonInstructional)) {
      return false;
    }
  }
}

/**
 * Whether a goal of this `frequency` is due (owes a point) in the given ISO week.
 * weekly/daily → every instructional week; monthly → the first instructional week
 * of the month; twice_monthly → the first instructional week of each half-month.
 * A calendar break week is never due.
 */
export function isDueInWeek(
  frequency: Frequency,
  weekId: string,
  isNonInstructional: (weekId: string) => boolean,
): boolean {
  if (!isCalendarInstructional(weekId, isNonInstructional)) {
    return false;
  }
  switch (frequency) {
    case "weekly":
    case "daily":
      return true;
    case "monthly":
      return isFirstInstructionalOfPeriod(weekId, isNonInstructional, monthlyKey);
    case "twice_monthly":
      return isFirstInstructionalOfPeriod(weekId, isNonInstructional, halfMonthKey);
  }
}
