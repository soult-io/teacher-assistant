// M5 — data-point capture + audited edits (design §A.1/§A.2, §B). The admin date
// (probe administration date) drives week membership; the entry timestamp is a
// SEPARATE audit field. No-data ⊘ is a distinct state with a REQUIRED reason, not
// a score of 0. Edits are versioned CRDT records (who/when/old→new), never silent
// overwrites; the original probe denominator is retained on a mismatch.

import {
  type IEPGoal,
  type IsoDate,
  type MismatchDisposition,
  newOpaqueId,
  type NoDataReason,
  type OpaqueId,
  type ProbeDefinition,
  type ProgressDataPoint,
  type Revision,
  type Scorer,
  type Setting,
  type Timestamp,
} from "@teacher-assistant/schema";
import { probeMatchesGoal } from "./goal-validation.js";
import { computedRatio, isDenominatorMismatch } from "./value.js";

/** Thrown when a probe that does not match the goal is used to record progress (construct-integrity). */
export class ConstructIntegrityError extends Error {
  constructor(goalId: OpaqueId) {
    // Opaque id only — identity-clean.
    super(`probe does not match goal ${goalId}; it cannot be recorded as progress`);
    this.name = "ConstructIntegrityError";
  }
}

export interface ScoredPointInput {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  /** Probe ADMINISTRATION date — drives week membership. */
  readonly adminDate: IsoDate;
  /** Separate audit timestamp (who/when the value was entered). */
  readonly entryTs: Timestamp;
  readonly numerator: number;
  readonly denominatorUsed: number;
  /** The probe's expected total; a mismatch is flagged + the original retained (never hard-blocked). */
  readonly expectedDenominator?: number;
  /**
   * F-2 (§B): the teacher's affirmative acknowledgment + window disposition for a
   * denominator mismatch. Applied ONLY when the point is actually mismatched;
   * omitting the disposition leaves it pending (out of all computed math). Passing
   * a disposition without an actual mismatch is ignored.
   */
  readonly mismatchAcknowledged?: boolean;
  readonly mismatchWindowDisposition?: MismatchDisposition;
  readonly probeConditionId?: OpaqueId;
  /**
   * The goal + probe this point is recorded against. When present, the
   * construct-integrity guard is ENFORCED: a probe that does not match the goal's
   * circumstance throws ConstructIntegrityError (it is never logged as progress),
   * and the point's probe_condition_id is taken from the probe.
   */
  readonly construct?: { readonly goal: IEPGoal; readonly probe: ProbeDefinition };
  readonly setting: Setting;
  readonly scorer: Scorer;
}

/** Capture a scored data point. Flags (does not block) a denominator mismatch and retains the original. */
export function captureScoredPoint(input: ScoredPointInput): ProgressDataPoint {
  // Construct-integrity enforcement (design §B): a non-matching probe is refused.
  if (
    input.construct !== undefined &&
    !probeMatchesGoal(input.construct.goal, input.construct.probe)
  ) {
    throw new ConstructIntegrityError(input.goalId);
  }
  const probeConditionId = input.construct?.probe.probe_definition_id ?? input.probeConditionId;
  const mismatch =
    input.expectedDenominator !== undefined &&
    isDenominatorMismatch(input.expectedDenominator, input.denominatorUsed);
  return {
    data_point_id: newOpaqueId(),
    goal_id: input.goalId,
    student_id: input.studentId,
    admin_date: input.adminDate,
    entry_ts: input.entryTs,
    state: "scored",
    numerator: input.numerator,
    denominator_used: input.denominatorUsed,
    computed_value: computedRatio(input.numerator, input.denominatorUsed),
    setting: input.setting,
    scorer: input.scorer,
    revisions: [],
    ...(input.expectedDenominator !== undefined
      ? { denominator_original: input.expectedDenominator, denominator_mismatch: mismatch }
      : {}),
    // F-2: the teacher's election is stored ONLY on a genuine mismatch with a
    // chosen disposition; otherwise it stays pending (fields absent).
    ...(mismatch && input.mismatchWindowDisposition !== undefined
      ? {
          mismatch_acknowledged: input.mismatchAcknowledged ?? true,
          mismatch_window_disposition: input.mismatchWindowDisposition,
        }
      : {}),
    ...(probeConditionId !== undefined ? { probe_condition_id: probeConditionId } : {}),
  };
}

export interface NoDataInput {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  readonly adminDate: IsoDate;
  readonly entryTs: Timestamp;
  /** REQUIRED (design §A.2) — recording a ⊘ without a reason throws. */
  readonly reason: NoDataReason;
  readonly setting: Setting;
  readonly scorer: Scorer;
}

/** Record a no-data ⊘ point. A reason is mandatory; a ⊘ is never a score of 0. */
export function recordNoData(input: NoDataInput): ProgressDataPoint {
  if (input.reason === undefined) {
    throw new Error("a no-data point requires a reason");
  }
  return {
    data_point_id: newOpaqueId(),
    goal_id: input.goalId,
    student_id: input.studentId,
    admin_date: input.adminDate,
    entry_ts: input.entryTs,
    state: "no_data",
    no_data_reason: input.reason,
    setting: input.setting,
    scorer: input.scorer,
    revisions: [],
  };
}

export interface BookmarkInput {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  readonly adminDate: IsoDate;
  readonly entryTs: Timestamp;
  readonly setting: Setting;
  readonly scorer: Scorer;
}

/** One-tap "score later" bookmark (R3-2): a queued placeholder the To-Score queue later opens for full entry. */
export function bookmarkForLater(input: BookmarkInput): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: input.goalId,
    student_id: input.studentId,
    admin_date: input.adminDate,
    entry_ts: input.entryTs,
    state: "queued",
    setting: input.setting,
    scorer: input.scorer,
    revisions: [],
  };
}

/** The mutable fields an edit/[Fix] may change. `computed_value`/`denominator_mismatch` are DERIVED, never set directly. */
export type EditableFields = Partial<
  Pick<ProgressDataPoint, "numerator" | "denominator_used" | "state" | "no_data_reason" | "setting">
>;

/**
 * Apply an audited edit. Returns a NEW point with the changes applied and a
 * Revision (who/when/old→new) appended — never a silent overwrite. The original
 * probe denominator (`denominator_original`) is retained, never overwritten.
 *
 * When the value inputs change, the DERIVED fields are recomputed: `computed_value`
 * is kept in sync, and the denominator mismatch is RE-EVALUATED — so a corrective
 * [Fix] that restores the probe's original total clears the flag and the point
 * re-enters the consistency window (rather than staying excluded forever).
 */
export function applyEdit(
  point: ProgressDataPoint,
  changes: EditableFields,
  who: string,
  when: Timestamp,
): ProgressDataPoint {
  const old: Record<string, unknown> = {};
  for (const key of Object.keys(changes) as (keyof EditableFields)[]) {
    old[key] = point[key];
  }
  const revision: Revision = { who, when, old, new: { ...changes } };
  const merged = { ...point, ...changes };

  // A scored → ⊘ edit must carry NO residual value: a ⊘ is not a score of 0, so
  // drop numerator / denominator / computed value / mismatch flags (design §A.2).
  if (merged.state === "no_data") {
    const {
      numerator: _n,
      denominator_used: _d,
      computed_value: _c,
      denominator_mismatch: _m,
      denominator_original: _o,
      ...cleared
    } = merged;
    return { ...cleared, revisions: [...point.revisions, revision] };
  }

  const derived: { computed_value?: number; denominator_mismatch?: boolean } = {};
  if (
    merged.state === "scored" &&
    (changes.numerator !== undefined || changes.denominator_used !== undefined)
  ) {
    derived.computed_value = computedRatio(merged.numerator ?? 0, merged.denominator_used ?? 0);
    if (merged.denominator_original !== undefined) {
      derived.denominator_mismatch = isDenominatorMismatch(
        merged.denominator_original,
        merged.denominator_used ?? 0,
      );
    }
  }
  return { ...merged, ...derived, revisions: [...point.revisions, revision] };
}
