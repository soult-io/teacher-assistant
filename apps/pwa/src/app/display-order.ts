// Display ordering — the ONE shared view-layer comparator set every screen sorts
// with (TEACH-25 UX ruling). Tiebreaks use teacher-meaningful keys (initials,
// period, goal text) before any opaque id, so the same data shows in the same
// order after a reseed or reload. Opaque ids stay only as the LAST tiebreak, for
// true duplicates. Never localeCompare, which is lint-banned: text is
// trimmed + toLowerCase()d and compared by code point, and the raw text breaks a
// case-only tie so the order is total.

import { compareCodePoints } from "@teacher-assistant/domain-core";
import type { OpaqueId } from "@teacher-assistant/schema";

/** Case-insensitive display compare (trim + toLowerCase, code point), raw text breaks ties. */
export function compareDisplayText(a: string, b: string): number {
  return (
    compareCodePoints(a.trim().toLowerCase(), b.trim().toLowerCase()) || compareCodePoints(a, b)
  );
}

/** compareDisplayText with a missing value (null) sorted last. */
export function compareOptionalText(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  }
  return compareDisplayText(a, b);
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

/** The teacher-meaningful keys of a student's goal row, as shown on screen. */
export interface StudentGoalSortKey {
  readonly initials: string;
  readonly periodLabel: string | null;
  readonly studentId: string;
  readonly goalText: string;
}

/** How a screen resolves a student's on-screen initials and period label. */
export interface StudentResolvers {
  readonly initialsOf: (studentId: OpaqueId) => string;
  readonly periodLabelOf: (studentId: OpaqueId) => string | null;
}

/** The sort key of a student's goal as the screen shows it — the one key builder. */
export function studentGoalKey(
  studentId: OpaqueId,
  goalText: string,
  r: StudentResolvers,
): StudentGoalSortKey {
  return {
    initials: r.initialsOf(studentId),
    periodLabel: r.periodLabelOf(studentId),
    studentId,
    goalText,
  };
}

/**
 * The student-goal row order shared by every list of goal rows: initials, then
 * period label (none last), then studentId (two students with the same initials
 * and period stay apart), then goal text — so a student's goals read A–Z.
 */
export function compareStudentGoal(a: StudentGoalSortKey, b: StudentGoalSortKey): number {
  return (
    compareDisplayText(a.initials, b.initials) ||
    compareOptionalText(a.periodLabel, b.periodLabel) ||
    compareCodePoints(a.studentId, b.studentId) ||
    compareDisplayText(a.goalText, b.goalText)
  );
}
