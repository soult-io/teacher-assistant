// TEACH-46 — baseline point capture + audited Fix / Remove / Keep
// (ky-sped-lbd-sdi-sme ruling 2026-10-09, conditions C1–C8).
//
//   - A point is created only on a PROPOSED goal, by the teacher, with a whole
//     number correct (0 allowed) of a total ≥ 1, never more than the total.
//   - Fix changes n, d and the admin date; Remove takes a reason from a CLOSED
//     list. Both return a NEW point with a Revision {who, when, old, new}
//     appended. Nothing is ever hard-deleted: a removed point is kept, shown in
//     History, and excluded from the estimate (isCountedBaselinePoint).
//   - A total that differs from the probe's is kept with the original and a
//     mismatch flag; it does not count until the teacher taps "Keep" (C8).
//   - After ARC adoption a point may still be FIXED, but the goal's
//     baseline_value never recomputes (it must match the IEP). The point is
//     flagged corrected_after_adoption instead. There is no re-lock (BLOCKED).
//
// Revisions carry numbers, dates and closed enums only — never free text.

import {
  BASELINE_REMOVE_REASONS,
  type BaselinePoint,
  type BaselineRemoveReason,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type ProbeDefinition,
  type Revision,
  type Scorer,
  type Timestamp,
} from "@teacher-assistant/schema";
import { type BaselineMethod, baselineValueOf } from "./baseline.js";
import { computedRatio, isDenominatorMismatch } from "./value.js";

export type BaselineEditBlock =
  | "teacher_only"
  | "not_proposed"
  | "invalid_score"
  | "invalid_date"
  | "invalid_reason"
  | "already_removed"
  | "wrong_goal"
  | "not_mismatched";

/** Thrown when a baseline capture or edit breaks a TEACH-46 rule. */
export class BaselineEditError extends Error {
  constructor(readonly reason: BaselineEditBlock) {
    super(`baseline point edit refused: ${reason}`);
    this.name = "BaselineEditError";
  }
}

export interface BaselineEditOptions {
  /** Only the teacher edits baseline data; the para never baselines (C5). */
  readonly who: Extract<Scorer, "teacher">;
  readonly when: Timestamp;
}

/** Why a typed score cannot be saved, or null when it can. */
export type BaselineScoreProblem = "numerator_missing" | "total_missing" | "over_total";

/** A typed count: a whole number ≥ 0 written as plain digits, else undefined (no decimals, no signs). */
export function parseBaselineCount(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** Check a score: whole numbers, 0 ≤ n ≤ d, d ≥ 1 (C3). */
export function checkBaselineScore(
  numerator: number | undefined,
  denominator: number | undefined,
): BaselineScoreProblem | null {
  if (numerator === undefined || !Number.isInteger(numerator) || numerator < 0) {
    return "numerator_missing";
  }
  if (denominator === undefined || !Number.isInteger(denominator) || denominator < 1) {
    return "total_missing";
  }
  return numerator > denominator ? "over_total" : null;
}

/** Whether the goal is scored as a percent — the only kind the "# correct of N" row serves (C7). */
export function takesBaselineScore(goal: IEPGoal): boolean {
  return goal.denominator_model === "percent_correct_over_total";
}

/**
 * The "of N" prefill (C7): the probe's expected total on a fixed-total goal.
 * Undefined (the box starts empty and is required) on a variable-total goal or
 * when no probe total is known. Never a hardcoded number.
 */
export function baselineTotalPrefill(
  goal: IEPGoal,
  probe: ProbeDefinition | undefined,
): number | undefined {
  if (!takesBaselineScore(goal) || goal.denominator_basis === "variable") {
    return undefined;
  }
  return probe?.goal_id === goal.goal_id ? probe.expected_denominator : undefined;
}

function assertTeacher(who: string): void {
  if (who !== "teacher") {
    throw new BaselineEditError("teacher_only");
  }
}

/** An admin date is a plain YYYY-MM-DD calendar date — the only string a fix may carry. */
function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new BaselineEditError("invalid_date");
  }
}

function assertScore(numerator: number, denominator: number): void {
  if (checkBaselineScore(numerator, denominator) !== null) {
    throw new BaselineEditError("invalid_score");
  }
}

export interface NewBaselinePointInput {
  readonly goal: IEPGoal;
  /** The goal's assigned probe — its expected total drives the C8 mismatch flag. */
  readonly probe: ProbeDefinition | undefined;
  readonly adminDate: IsoDate;
  readonly numerator: number;
  readonly denominator: number;
  readonly who: Extract<Scorer, "teacher">;
  readonly entryTs: Timestamp;
}

/** Create a baseline point on a proposed goal. A differing total is flagged, not blocked (C8). */
export function createBaselinePoint(input: NewBaselinePointInput): BaselinePoint {
  assertTeacher(input.who);
  if (input.goal.status !== "proposed") {
    throw new BaselineEditError("not_proposed");
  }
  assertScore(input.numerator, input.denominator);
  assertDate(input.adminDate);
  const expected = baselineTotalPrefill(input.goal, input.probe);
  return {
    baseline_point_id: newOpaqueId(),
    goal_id: input.goal.goal_id,
    student_id: input.goal.student_id,
    admin_date: input.adminDate,
    entry_ts: input.entryTs,
    numerator: input.numerator,
    denominator_used: input.denominator,
    computed_value: computedRatio(input.numerator, input.denominator),
    probe_condition_id: input.goal.probe_definition_id ?? input.goal.goal_id,
    scorer: "teacher",
    status: "recorded",
    revisions: [],
    ...(expected !== undefined
      ? {
          denominator_original: expected,
          denominator_mismatch: isDenominatorMismatch(expected, input.denominator),
        }
      : {}),
  };
}

/** What a Fix may change (C3). */
export interface BaselineFix {
  readonly numerator?: number;
  readonly denominator_used?: number;
  readonly admin_date?: IsoDate;
}

function assertEditable(point: BaselinePoint, goal: IEPGoal, who: string): void {
  assertTeacher(who);
  if (point.goal_id !== goal.goal_id) {
    throw new BaselineEditError("wrong_goal");
  }
  if (point.status === "removed") {
    throw new BaselineEditError("already_removed");
  }
}

/**
 * Fix a baseline point (C3): append a Revision and resync computed_value and the
 * mismatch flag. A new total that still differs from the probe's must be kept
 * again. On an adopted goal the goal is untouched; a changed value on a point that
 * fed the locked baseline flags it corrected_after_adoption (ruling B). Returns the
 * point unchanged when nothing differs.
 */
export function fixBaselinePoint(
  point: BaselinePoint,
  goal: IEPGoal,
  fix: BaselineFix,
  options: BaselineEditOptions,
): BaselinePoint {
  assertEditable(point, goal, options.who);
  const numerator = fix.numerator ?? point.numerator;
  const denominator = fix.denominator_used ?? point.denominator_used;
  const adminDate = fix.admin_date ?? point.admin_date;
  assertScore(numerator, denominator);
  assertDate(adminDate);
  const dateChanged = adminDate !== point.admin_date;
  const valueChanged = numerator !== point.numerator || denominator !== point.denominator_used;
  if (!valueChanged && !dateChanged) {
    return point;
  }
  // Both numbers on both sides, so History can always say "was a/b, now c/d".
  const revision: Revision = {
    who: options.who,
    when: options.when,
    old: {
      numerator: point.numerator,
      denominator_used: point.denominator_used,
      ...(dateChanged ? { admin_date: point.admin_date } : {}),
    },
    new: {
      numerator,
      denominator_used: denominator,
      ...(dateChanged ? { admin_date: adminDate } : {}),
    },
  };
  const { mismatch_kept: kept, ...rest } = point;
  const mismatch =
    point.denominator_original !== undefined
      ? isDenominatorMismatch(point.denominator_original, denominator)
      : undefined;
  // A Keep applied to the old total; a changed, still-mismatched total needs a fresh Keep.
  const keepStill = mismatch === true && denominator === point.denominator_used && kept === true;
  return {
    ...rest,
    numerator,
    denominator_used: denominator,
    admin_date: adminDate,
    computed_value: computedRatio(numerator, denominator),
    ...(mismatch !== undefined ? { denominator_mismatch: mismatch } : {}),
    ...(keepStill ? { mismatch_kept: true } : {}),
    ...(point.corrected_after_adoption === true || (valueChanged && wasAdoptedFrom(goal, point))
      ? { corrected_after_adoption: true }
      : {}),
    revisions: [...point.revisions, revision],
  };
}

/** Runtime guard for the closed remove-reason list (C2) — the type alone does not stop synced data. */
export function isBaselineRemoveReason(value: unknown): value is BaselineRemoveReason {
  return (BASELINE_REMOVE_REASONS as readonly unknown[]).includes(value);
}

/**
 * Remove a baseline point (C2/C4): status → removed with the reason, time and
 * author, plus a Revision. The point is KEPT — never deleted — and stops
 * counting. Proposed goals only: after adoption a point may be fixed, not removed.
 */
export function removeBaselinePoint(
  point: BaselinePoint,
  goal: IEPGoal,
  reason: BaselineRemoveReason,
  options: BaselineEditOptions,
): BaselinePoint {
  assertEditable(point, goal, options.who);
  if (!isBaselineRemoveReason(reason)) {
    throw new BaselineEditError("invalid_reason");
  }
  if (goal.status !== "proposed") {
    throw new BaselineEditError("not_proposed");
  }
  const revision: Revision = {
    who: options.who,
    when: options.when,
    // The values at removal, so History's "(was a/b)" survives a later merge.
    old: {
      status: "recorded",
      numerator: point.numerator,
      denominator_used: point.denominator_used,
    },
    new: { status: "removed", removed_reason: reason },
  };
  return {
    ...point,
    status: "removed",
    removed_reason: reason,
    removed_ts: options.when,
    removed_by: options.who,
    revisions: [...point.revisions, revision],
  };
}

/** "Keep {M}" (C8): the teacher confirms a total that differs from the probe's; it now counts. */
export function keepBaselineTotal(
  point: BaselinePoint,
  goal: IEPGoal,
  options: BaselineEditOptions,
): BaselinePoint {
  assertEditable(point, goal, options.who);
  if (point.denominator_mismatch !== true || point.mismatch_kept === true) {
    throw new BaselineEditError("not_mismatched");
  }
  const revision: Revision = {
    who: options.who,
    when: options.when,
    old: { mismatch_kept: false },
    new: { mismatch_kept: true },
  };
  return { ...point, mismatch_kept: true, revisions: [...point.revisions, revision] };
}

/**
 * Whether the point fed the goal's locked baseline_value: the goal is past
 * adoption and the point is one of the adopted ids (C6). An adoption from before
 * C6 stored no ids, so every point counts as adopted.
 */
function wasAdoptedFrom(goal: IEPGoal, point: BaselinePoint): boolean {
  if (goal.status === "proposed") {
    return false;
  }
  const { ids } = adoptionRecord(goal);
  return ids === undefined || ids.includes(point.baseline_point_id);
}

/** One History row (ruling D): a fix or a removal, with the values before and after. */
export type BaselineHistoryEntry =
  | {
      readonly kind: "fixed";
      readonly when: Timestamp;
      readonly was: readonly [number, number];
      readonly now: readonly [number, number];
    }
  | {
      readonly kind: "removed";
      readonly when: Timestamp;
      readonly reason: BaselineRemoveReason;
      readonly was: readonly [number, number];
    };

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function pairOf(value: unknown): readonly [number, number] | undefined {
  const n = fieldOf(value, "numerator");
  const d = fieldOf(value, "denominator_used");
  return typeof n === "number" && typeof d === "number" ? [n, d] : undefined;
}

/** A point's History rows, oldest first. "Keep" decisions are audited but not listed. */
export function baselineHistory(point: BaselinePoint): BaselineHistoryEntry[] {
  return point.revisions.flatMap((rev): BaselineHistoryEntry[] => {
    const was = pairOf(rev.old);
    const now = pairOf(rev.new);
    if (was !== undefined && now !== undefined) {
      return [{ kind: "fixed", when: rev.when, was, now }];
    }
    const reason = fieldOf(rev.new, "removed_reason");
    if (isBaselineRemoveReason(reason)) {
      // An older removal Revision may lack the values; fall back to the point's.
      return [
        {
          kind: "removed",
          when: rev.when,
          reason,
          was: was ?? [point.numerator, point.denominator_used],
        },
      ];
    }
    return [];
  });
}

/** The numbers for the "Fixed after ARC" note: the locked IEP value and the would-be estimate. */
export interface BaselineCorrectionAfterArc {
  readonly iepValue: number;
  readonly estimate: number;
}

/** The adoption Revision's C6 record — which points and method produced baseline_value. */
function adoptionRecord(goal: IEPGoal): {
  readonly ids: readonly string[] | undefined;
  readonly method: BaselineMethod;
} {
  const adoption = [...goal.revisions]
    .reverse()
    .find((rev) => fieldOf(rev.new, "baseline_source") === "computed_from_baseline_points");
  const ids = fieldOf(adoption?.new, "baseline_point_ids");
  const method = fieldOf(adoption?.new, "baseline_method");
  return {
    ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : undefined,
    method: method === "median" ? "median" : "mean",
  };
}

/**
 * When a point on an adopted goal was fixed, the IEP baseline (unchanged) and
 * what the estimate would now be over the same adopted points and method.
 * Null when no point on the goal was corrected after adoption.
 */
export function baselineCorrectionAfterArc(
  goal: IEPGoal,
  points: readonly BaselinePoint[],
): BaselineCorrectionAfterArc | null {
  const own = points.filter((p) => p.goal_id === goal.goal_id);
  if (goal.baseline_value === undefined || !own.some((p) => p.corrected_after_adoption === true)) {
    return null;
  }
  const { ids, method } = adoptionRecord(goal);
  // An adoption made before C6 stored no ids: fall back to every point not removed.
  const adopted = own.filter((p) =>
    ids !== undefined ? ids.includes(p.baseline_point_id) : p.status !== "removed",
  );
  const estimate = baselineValueOf(adopted, method);
  return estimate === null ? null : { iepValue: goal.baseline_value, estimate };
}
