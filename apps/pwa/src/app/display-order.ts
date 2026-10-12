// Display ordering — the ONE shared view-layer comparator set every screen sorts
// with (TEACH-25 UX ruling). Tiebreaks use teacher-meaningful keys (initials,
// period, goal text) before any opaque id, so the same data shows in the same
// order after a reseed or reload. Opaque ids stay only as the LAST tiebreak, for
// true duplicates. Never localeCompare, which is lint-banned: text is
// trimmed + toLowerCase()d and compared by code point, and the raw text breaks a
// case-only tie so the order is total.

import {
  compareCodePoints,
  compareDisplayText,
  compareGoalLabel,
} from "@teacher-assistant/domain-core";
import type { OpaqueId } from "@teacher-assistant/schema";

// The text comparators live in domain-core (the IC export engine sorts goal labels
// with the same number-aware compare); re-exported so screens import one module.
export { compareDisplayText, compareNumberAware } from "@teacher-assistant/domain-core";

/** compareDisplayText with a missing value (null) sorted last. */
export function compareOptionalText(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  }
  return compareDisplayText(a, b);
}

/** The teacher-meaningful keys of a student's goal row, as shown on screen. */
export interface StudentGoalSortKey {
  readonly initials: string;
  readonly periodLabel: string | null;
  readonly studentId: string;
  /** The IEP goal label ("2", "1a"), or null when the goal has none (TEACH-41). */
  readonly goalLabel: string | null;
  readonly goalText: string;
}

/** How a screen resolves a student's on-screen initials and period label. */
export interface StudentResolvers {
  readonly initialsOf: (studentId: OpaqueId) => string;
  readonly periodLabelOf: (studentId: OpaqueId) => string | null;
}

/** The goal fields the student-goal order reads. */
export interface GoalSortFields {
  readonly goalLabel: string | null;
  readonly goalText: string;
}

/** The sort key of a student's goal as the screen shows it — the one key builder. */
export function studentGoalKey(
  studentId: OpaqueId,
  goal: GoalSortFields,
  r: StudentResolvers,
): StudentGoalSortKey {
  return {
    initials: r.initialsOf(studentId),
    periodLabel: r.periodLabelOf(studentId),
    studentId,
    goalLabel: goal.goalLabel,
    goalText: goal.goalText,
  };
}

/**
 * The student-goal row order shared by every list of goal rows: initials, then
 * period label (none last), then studentId (two students with the same initials
 * and period stay apart), then the IEP goal label (number-aware, 1 < 1a < 2 < 10;
 * unlabeled goals last — TEACH-41), then goal text — so a student's goals read in
 * IEP order, and unlabeled ones A–Z after them.
 */
export function compareStudentGoal(a: StudentGoalSortKey, b: StudentGoalSortKey): number {
  return (
    compareDisplayText(a.initials, b.initials) ||
    compareOptionalText(a.periodLabel, b.periodLabel) ||
    compareCodePoints(a.studentId, b.studentId) ||
    compareGoalLabel(a.goalLabel ?? undefined, b.goalLabel ?? undefined) ||
    compareDisplayText(a.goalText, b.goalText)
  );
}
