// The app's non-instructional calendar (design §G R3-1, cross-cutting §98). ONE
// source of truth for which ISO weeks are calendar breaks (Fall / Thanksgiving /
// Winter / Spring), so every consumer agrees on what a "week" is: the M3 owes math,
// the R3-3 ≥4-instructional-week auto-statement gate, and the R3-4 baseline lead.
//
// A break week generates no owes and is EXCLUDED from the NCII instructional-weeks
// tally. Counting a break week as instructional would inflate the week count and
// LOOSEN the ≥4-week gate (the overstatement direction, R3 DM-2) — so this predicate
// is single-sourced and passed explicitly to the screens, never a per-screen
// `() => false` default that could silently widen the gate.
//
// The MVP synthetic caseload configures no breaks yet; a real calendar is a data
// change here, not a code change at the call sites.
export const NON_INSTRUCTIONAL_WEEKS: ReadonlySet<string> = new Set<string>();

/** True when the ISO week id (M4 `isoWeekId`) is a calendar break — no owes, out of the week tally. */
export function isNonInstructionalWeek(weekId: string): boolean {
  return NON_INSTRUCTIONAL_WEEKS.has(weekId);
}
