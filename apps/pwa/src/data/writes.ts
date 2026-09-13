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
  MismatchDisposition,
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

/**
 * The teacher's F-2 acknowledgment of a denominator mismatch (set together on a
 * genuine mismatch: one affirmative tap picks the window disposition). Absent =
 * no mismatch, or the point matches the probe basis.
 */
export interface MismatchElection {
  readonly mismatchWindowDisposition: MismatchDisposition;
}

/** Spread the M5 election params onto a captureScoredPoint call when one was made. */
function electionParams(election: MismatchElection | undefined) {
  return election === undefined
    ? {}
    : { mismatchAcknowledged: true, mismatchWindowDisposition: election.mismatchWindowDisposition };
}

export interface ScoreInput extends CaptureContext {
  readonly numerator: number;
  readonly denominatorUsed: number;
  /** The assigned probe's expected total; a mismatch is flagged (never blocked). */
  readonly expectedDenominator?: number;
  /** The teacher's F-2 election, present iff Save was gated behind the mismatch ack. */
  readonly election?: MismatchElection;
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
    ...electionParams(input.election),
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
    readonly election?: MismatchElection;
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
    ...electionParams(fill.election),
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
export interface EditOptions {
  /**
   * The assigned probe's expected total. Backfilled onto the point as
   * `denominator_original` when it is missing, so applyEdit can (re)evaluate the
   * denominator mismatch — a [Fix] on a point captured WITHOUT an expected total
   * (e.g. a seeded point) would otherwise never flag an off-basis change and would
   * silently drop the teacher's election. Never overwrites an existing original.
   */
  readonly expectedDenominator?: number;
  /** The teacher's F-2 election, present iff Save was gated behind the mismatch ack. */
  readonly election?: MismatchElection;
}

export function editMutator(
  point: ProgressDataPoint,
  changes: Parameters<typeof applyEdit>[1],
  when: Timestamp,
  opts: EditOptions = {},
): DocMutator {
  // Ensure the point carries its probe basis so the ENGINE (applyEdit) evaluates
  // the mismatch — the UI does not decide it. denominator_original is retained,
  // never overwritten (schema §2.4).
  const withBasis =
    point.denominator_original === undefined && opts.expectedDenominator !== undefined
      ? { ...point, denominator_original: opts.expectedDenominator }
      : point;
  const edited = applyEdit(withBasis, changes, TEACHER, when);
  // If the [Fix] leaves the point mismatched, carry the teacher's F-2 election
  // onto it (applyEdit does not accept it — the disposition is a teacher input,
  // and applyEdit already clears a stale one on a mismatch-resolving edit).
  const withElection =
    edited.denominator_mismatch === true && opts.election !== undefined
      ? {
          ...edited,
          mismatch_acknowledged: true,
          mismatch_window_disposition: opts.election.mismatchWindowDisposition,
        }
      : edited;
  return (doc) => upsertPoint(doc, withElection);
}
