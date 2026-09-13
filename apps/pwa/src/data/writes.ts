// Write actions (U3) — the ONLY path the UI writes a monitoring point, and it
// goes entirely through the M5 capture engine (@teacher-assistant/domain-core):
// captureScoredPoint / recordNoData / bookmarkForLater / applyEdit. This module
// holds NO domain rules — it maps a UI intent to an M5 call and upserts the
// resulting point into the encrypted CRDT doc. Each returns a DocMutator the
// session captures (encrypted + persisted as ciphertext, offline-first).
//
// The admin date (probe administration) drives week membership; the entry
// timestamp is a separate audit field (both passed in by the caller). Edits are
// versioned via applyEdit (who/when/old→new), never silent overwrites.

import {
  applyEdit,
  bookmarkForLater,
  captureScoredPoint,
  recordNoData,
} from "@teacher-assistant/domain-core";
import type {
  IsoDate,
  NoDataReason,
  OpaqueId,
  ProgressDataPoint,
  Setting,
  Timestamp,
} from "@teacher-assistant/schema";
import type { DocMutator } from "./session.js";
import { deletePoint, upsertPoint } from "./repository.js";

/** The teacher is the scorer and the edit author (a role, never a student name — identity-clean). */
const TEACHER = "teacher" as const;

/** The capture setting for this session — Resource, locked in the UI ("this session"). */
export const DEFAULT_SETTING: Setting = "math_resource";

export interface CaptureContext {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  /** Probe administration date — drives week membership (not the entry time). */
  readonly adminDate: IsoDate;
  /** Separate audit timestamp for when the value was entered. */
  readonly entryTs: Timestamp;
  readonly setting: Setting;
}

export interface ScoreInput extends CaptureContext {
  readonly numerator: number;
  readonly denominatorUsed: number;
  /** The assigned probe's expected total; a mismatch is flagged (never blocked). */
  readonly expectedDenominator?: number;
}

/** Capture a scored point (M5) and upsert it. */
export function scoreMutator(input: ScoreInput): DocMutator {
  const point = captureScoredPoint({
    goalId: input.goalId,
    studentId: input.studentId,
    adminDate: input.adminDate,
    entryTs: input.entryTs,
    numerator: input.numerator,
    denominatorUsed: input.denominatorUsed,
    setting: input.setting,
    scorer: TEACHER,
    ...(input.expectedDenominator !== undefined
      ? { expectedDenominator: input.expectedDenominator }
      : {}),
  });
  return (doc) => upsertPoint(doc, point);
}

/** Record a no-data ⊘ point (M5) — reason required; never a score of 0. */
export function noDataMutator(context: CaptureContext, reason: NoDataReason): DocMutator {
  const point = recordNoData({
    goalId: context.goalId,
    studentId: context.studentId,
    adminDate: context.adminDate,
    entryTs: context.entryTs,
    reason,
    setting: context.setting,
    scorer: TEACHER,
  });
  return (doc) => upsertPoint(doc, point);
}

/** Write a score-later bookmark (M5 queued placeholder) — the To-Score queue opens it later. */
export function bookmarkMutator(context: CaptureContext): DocMutator {
  const point = bookmarkForLater({
    goalId: context.goalId,
    studentId: context.studentId,
    adminDate: context.adminDate,
    entryTs: context.entryTs,
    setting: context.setting,
    scorer: TEACHER,
  });
  return (doc) => upsertPoint(doc, point);
}

/** Remove a score-later placeholder (un-flag a queued point). */
export function unbookmarkMutator(dataPointId: OpaqueId): DocMutator {
  return (doc) => deletePoint(doc, dataPointId);
}

/**
 * Complete a queued (bookmarked) placeholder by scoring it. The placeholder holds
 * no value, so this is a fresh M5 capture (captureScoredPoint) — which evaluates
 * the denominator mismatch against the assigned probe, exactly like a direct
 * score — that REPLACES the placeholder: the queued point is deleted in the same
 * transaction, so the goal ends the week with one scored point (never two) and
 * the queue clears. It keeps the collected admin date (week membership).
 */
export function completeQueuedMutator(
  queued: ProgressDataPoint,
  fill: {
    readonly numerator: number;
    readonly denominatorUsed: number;
    readonly expectedDenominator?: number;
  },
  entryTs: Timestamp,
): DocMutator {
  const scored = captureScoredPoint({
    goalId: queued.goal_id,
    studentId: queued.student_id,
    adminDate: queued.admin_date,
    entryTs,
    numerator: fill.numerator,
    denominatorUsed: fill.denominatorUsed,
    setting: queued.setting,
    scorer: TEACHER,
    ...(fill.expectedDenominator !== undefined
      ? { expectedDenominator: fill.expectedDenominator }
      : {}),
  });
  return (doc) => {
    deletePoint(doc, queued.data_point_id);
    upsertPoint(doc, scored);
  };
}

/**
 * Apply an audited edit to an existing SCORED point ([Fix]) — retains the prior
 * value as a Revision (never a silent overwrite), same id. applyEdit re-derives
 * computed_value and re-evaluates the denominator mismatch against the retained
 * denominator_original, so a corrective [Fix] restoring the probe's total clears
 * the flag.
 */
export function editMutator(
  point: ProgressDataPoint,
  changes: Parameters<typeof applyEdit>[1],
  when: Timestamp,
): DocMutator {
  const edited = applyEdit(point, changes, TEACHER, when);
  return (doc) => upsertPoint(doc, edited);
}
