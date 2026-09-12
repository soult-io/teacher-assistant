// M4 — the instructional-weeks primitive (architecture §3, data-model §5). ONE
// pure, PII-free implementation that every consumer imports (owes math, the
// ≥8-pt/4-week trend gate, the ~6-week baseline lead, the F4 window).
//
// Two axes that must NEVER be conflated:
//   - WEEK axis (here): instructional weeks = ISO weeks that are neither calendar
//     non-instructional (Fall/Thanksgiving/Winter/Spring, flagged at the calendar
//     level) nor ⊘-only for the goal in question. Break weeks generate no owes by
//     construction. Feeds the 4-week gate, the 6-week baseline lead, owes math.
//   - PROBE axis (elsewhere): consecutive SCORED points in admin-date order. Feeds
//     the consistency window, the ≥8-point sufficiency gate, the F4 most-recent-5.
//
// Inputs are primitives only (dates, ISO-week strings, flags) — no student data
// ever reaches this module.

/** Parse an ISO `YYYY-MM-DD` date (or pass a Date) to a UTC Date at midnight. */
function toUtcDate(date: string | Date): Date {
  if (date instanceof Date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

/** ISO-8601 week id for a date, e.g. "2026-W37" (ISO year may differ from calendar year). */
export function isoWeekId(date: string | Date): string {
  const d = toUtcDate(date);
  // Shift to the Thursday of the current ISO week; the ISO year is that Thursday's year.
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** The UTC Date of the Monday that starts an ISO week id. */
export function isoWeekStart(weekId: string): Date {
  const [yearPart, weekPart] = weekId.split("-W");
  const isoYear = Number(yearPart);
  const week = Number(weekPart);
  // Jan 4th is always in ISO week 1; find its Monday, then add (week-1) weeks.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  week1Monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return week1Monday;
}

/** Ordered, de-duplicated ISO week ids covering [start, end] inclusive. */
export function enumerateIsoWeeks(start: string | Date, end: string | Date): string[] {
  const startMonday = isoWeekStart(isoWeekId(start));
  const endDate = toUtcDate(end);
  const weeks: string[] = [];
  const cursor = new Date(startMonday);
  while (cursor.getTime() <= endDate.getTime()) {
    weeks.push(isoWeekId(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}

/** Whether a week counts for owes/collectable: it is instructional unless the calendar flags it a break. */
export function isCalendarInstructional(
  weekId: string,
  isNonInstructional: (weekId: string) => boolean,
): boolean {
  return !isNonInstructional(weekId);
}

export interface InstructionalWeeksInput {
  /** The goal's first admin date (ISO) — the start of the span. Null → no weeks. */
  readonly firstAdminDate: string | Date | null;
  /** Evaluation date ("now"), ISO. */
  readonly asOf: string | Date;
  /** Calendar break flag, keyed by ISO week id. */
  readonly isNonInstructional: (weekId: string) => boolean;
  /** Weeks whose ONLY records for THIS goal are excused ⊘ (absent/testing/no_school). */
  readonly excusedOnlyWeeks?: ReadonlySet<string>;
}

/**
 * The ordered instructional weeks for a goal over [firstAdminDate, asOf]: ISO
 * weeks that are neither a calendar break nor ⊘-only for this goal. This is the
 * WEEK axis — it counts weeks, never probes.
 */
export function instructionalWeeks(input: InstructionalWeeksInput): string[] {
  if (input.firstAdminDate === null) {
    return [];
  }
  const excused = input.excusedOnlyWeeks ?? new Set<string>();
  return enumerateIsoWeeks(input.firstAdminDate, input.asOf).filter(
    (w) => isCalendarInstructional(w, input.isNonInstructional) && !excused.has(w),
  );
}

/** The number of instructional weeks (e.g. for the R3-3 ≥4-instructional-week gate). */
export function instructionalWeekCount(input: InstructionalWeeksInput): number {
  return instructionalWeeks(input).length;
}

/**
 * The ISO week that is `nInstructionalWeeks` instructional weeks before (and
 * including the span ending at) `arcDateWeekId` — the baseline-window start
 * (`arc_date − ~6 instructional weeks`, data-model §2.1). Break weeks in between
 * are skipped, so moving arc_date across a break recomputes the window correctly.
 */
export function baselineWindowStart(
  arcDate: string | Date,
  nInstructionalWeeks: number,
  isNonInstructional: (weekId: string) => boolean,
): string {
  // Bound the walk-back so a pathological all-break calendar cannot loop forever
  // (a real synthetic calendar has finite breaks). ~20 years of weeks is far more
  // than any baseline lead; if we somehow exhaust it we return the earliest week
  // reached rather than hang.
  const maxWeeks = Math.max(nInstructionalWeeks, 1) * 8 + 1040;
  let counted = 0;
  let scanned = 0;
  const cursor = isoWeekStart(isoWeekId(arcDate));
  let weekId = isoWeekId(cursor);
  // Walk backwards, counting only instructional weeks, until we've spanned n of them.
  while (counted < nInstructionalWeeks && scanned < maxWeeks) {
    if (isCalendarInstructional(weekId, isNonInstructional)) {
      counted += 1;
    }
    if (counted >= nInstructionalWeeks) {
      break;
    }
    cursor.setUTCDate(cursor.getUTCDate() - 7);
    weekId = isoWeekId(cursor);
    scanned += 1;
  }
  return weekId;
}
