// M7 — ARC / IEP dates + the baseline window (data-model §2.1, design §F.F3).
// Two per-student dates are kept SEPARATE: arc_date drives the baseline window
// (arc_date − ~6 INSTRUCTIONAL weeks, via the M4 primitive — never calendar
// weeks); iep_end_date drives the M8 projection horizon and is never touched here.
// Editing arc_date recomputes the window and RETAINS collected baseline points
// (they are separate entities — nothing here discards them).

import type { IEPGoal, IsoDate, OpaqueId } from "@teacher-assistant/schema";
import { baselineWindowStart, isoWeekId, isoWeekStart } from "./instructional-weeks.js";

/** Default baseline lead (data-model §2.1: arc_date − ~6 instructional weeks). */
export const DEFAULT_BASELINE_LEAD_WEEKS = 6;

function toIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10) as IsoDate;
}

/**
 * The Monday (ISO date) that starts the baseline window for an arc date — the
 * single point of truth for the week-id→date conversion this module is built on.
 *
 * The ARC week is EXCLUDED (ky-sped-lbd-sdi-sme ruling B): the meeting week is not
 * a collection week — the baseline must already be in hand to present at the ARC —
 * so the window opens a FULL `leadWeeks` instructional weeks BEFORE the ARC week.
 * We do this locally by starting the M4 walk-back from the week BEFORE the ARC
 * week; M4's `baselineWindowStart` (which counts its start week as the first) is
 * left unchanged for any other consumer.
 */
function windowStartFor(
  arcDate: IsoDate,
  leadWeeks: number,
  isNonInstructional: (weekId: string) => boolean,
): IsoDate {
  const weekBeforeArc = isoWeekStart(isoWeekId(arcDate));
  weekBeforeArc.setUTCDate(weekBeforeArc.getUTCDate() - 7);
  return toIsoDate(isoWeekStart(baselineWindowStart(weekBeforeArc, leadWeeks, isNonInstructional)));
}

/**
 * The baseline-window start for a goal: arc_date minus `leadWeeks` INSTRUCTIONAL
 * weeks (breaks skipped, via M4). Returns undefined when the goal has no arc_date.
 */
export function computeBaselineWindowStart(
  goal: IEPGoal,
  isNonInstructional: (weekId: string) => boolean,
  leadWeeks: number = DEFAULT_BASELINE_LEAD_WEEKS,
): IsoDate | undefined {
  if (goal.arc_date === undefined) {
    return undefined;
  }
  return windowStartFor(goal.arc_date, leadWeeks, isNonInstructional);
}

/** An arc_date move that materially changes the baseline window (urgency signal). */
export type ArcDateAlert = "compressed" | "extended" | null;

export interface ArcDateEdit {
  /** The goal with arc_date + recomputed baseline_window_start; all points retained. */
  readonly goal: IEPGoal;
  /** Non-null when the move compressed (earlier arc_date) or extended (later) the window. */
  readonly alert: ArcDateAlert;
}

/**
 * Edit a goal's arc_date: recompute the baseline window in instructional-week
 * terms and flag whether the move compressed or extended it. iep_end_date is left
 * untouched (kept separate). Baseline points are not a parameter here, so they are
 * inherently retained — a date shift never discards collected data.
 */
export function editArcDate(
  goal: IEPGoal,
  newArcDate: IsoDate,
  isNonInstructional: (weekId: string) => boolean,
  leadWeeks: number = DEFAULT_BASELINE_LEAD_WEEKS,
): ArcDateEdit {
  const windowStart = windowStartFor(newArcDate, leadWeeks, isNonInstructional);
  let alert: ArcDateAlert = null;
  if (goal.arc_date !== undefined && newArcDate !== goal.arc_date) {
    alert = newArcDate < goal.arc_date ? "compressed" : "extended";
  }
  return {
    goal: { ...goal, arc_date: newArcDate, baseline_window_start: windowStart },
    alert,
  };
}

/** Mark a goal's arc_date confirmed (informational only — does not change the window). */
export function markArcDateConfirmed(goal: IEPGoal): IEPGoal {
  return { ...goal, arc_date_flag: "confirmed" };
}

/** An identity-clean baseline reminder: opaque goal id + initials + the window date ONLY — no goal text/scores. */
export interface BaselineReminder {
  readonly goalId: OpaqueId;
  /** The single permitted human handle (data-model §10.2); never goal text or a score. */
  readonly initials: string;
  readonly windowStart: IsoDate | null;
}

/** Build a baseline-window reminder carrying no student payload beyond initials. */
export function baselineReminder(
  goal: IEPGoal,
  initials: string,
  isNonInstructional: (weekId: string) => boolean,
  leadWeeks: number = DEFAULT_BASELINE_LEAD_WEEKS,
): BaselineReminder {
  return {
    goalId: goal.goal_id,
    initials,
    windowStart: computeBaselineWindowStart(goal, isNonInstructional, leadWeeks) ?? null,
  };
}
