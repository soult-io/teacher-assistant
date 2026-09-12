// M13 — the para capture + teacher-validation flow (field-split §1.4/§3,
// DECISIONS D-ARCH-FERPA-M13 conditions #3/#4/#6/#8, design §A.5/§F.F1/§F.F1-update).
//
// The para enters a data point over a HARD-constrained write: structured enums and
// integers only — NO free-text field of any kind exists on this surface (the type
// literally cannot hold one → a single free-text field is an automatic FERPA BLOCK).
// Everything the para writes lands state=pending and becomes an ARC-auditable record
// ONLY after teacher validation. accommodation_subtypes is a BLANK observation
// multi-select the para fills from what was witnessed — it has NO data edge from the
// goal's (teacher-MK) accom_mod, which would back-channel the prescribed accommodation.

import type {
  AccommodationSubtype,
  IsoDate,
  OpaqueId,
  ParaObservation,
  ProgressDataPoint,
  Setting,
  Timestamp,
} from "@teacher-assistant/schema";
import { ACCOMMODATION_SUBTYPES, PARA_OBSERVATIONS, SETTINGS } from "@teacher-assistant/schema";
import { compareCodePoints } from "./comparators.js";
import { computedRatio, isDenominatorMismatch } from "./value.js";

/**
 * The ⊘ reasons the para may record (field-split §1.4): Absent / Behavior / No-time
 * ONLY. `testing` is a teacher call (§A.5) and `no_school` is a calendar action —
 * neither is reachable from the para surface.
 */
export const PARA_NO_DATA_REASONS = ["absent", "behavior", "no_time"] as const;
export type ParaNoDataReason = (typeof PARA_NO_DATA_REASONS)[number];

/** The witnessed-session scored entry (→ state=pending until validated). */
export interface ParaScoredInput {
  readonly kind: "scored";
  /** # correct — the witnessed fact. */
  readonly numerator: number;
  /** THIS probe's ACTUAL total (witnessed). The para cannot redefine denominator_model. */
  readonly denominatorUsed: number;
  readonly paraObservations?: readonly ParaObservation[];
  /** BLANK by default; the para fills from what was witnessed. NO edge from accom_mod. */
  readonly accommodationSubtypes?: readonly AccommodationSubtype[];
}

/** The documented-no-data entry. */
export interface ParaNoDataInput {
  readonly kind: "no_data";
  readonly noDataReason: ParaNoDataReason;
  readonly paraObservations?: readonly ParaObservation[];
  readonly accommodationSubtypes?: readonly AccommodationSubtype[];
}

export type ParaEntryInput = ParaScoredInput | ParaNoDataInput;

/** The pre-filled, opaque/structured context for a para entry (no PII, no free text). */
export interface ParaCaptureContext {
  readonly dataPointId: OpaqueId;
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  /** Opaque ref to the administered probe; the condition TEXT stays teacher-MK. */
  readonly probeConditionId: OpaqueId;
  /** = ProbeDefinition.expected_denominator; shown read-only, never overwritten. */
  readonly expectedDenominator: number;
  readonly adminDate: IsoDate;
  readonly setting: Setting;
  readonly entryTs: Timestamp;
  /**
   * Bounded admin-date picker (field-split §1.4): inclusive [earliest, latest]. This
   * pure module enforces window membership only; pinning `latest` to today (no future)
   * is the CALLER's contract — domain-core holds no clock.
   */
  readonly adminDateBounds: { readonly earliest: IsoDate; readonly latest: IsoDate };
}

export type ParaCaptureReject =
  | "admin_date_out_of_bounds"
  | "numerator_out_of_range"
  | "denominator_nonpositive"
  | "invalid_observation_chip"
  | "invalid_accommodation_subtype"
  | "invalid_no_data_reason"
  | "setting_not_allowed";

export type ParaCaptureResult =
  | { readonly ok: true; readonly point: ProgressDataPoint }
  | { readonly ok: false; readonly reason: ParaCaptureReject };

const OBS_SET: ReadonlySet<string> = new Set(PARA_OBSERVATIONS);
const SUBTYPE_SET: ReadonlySet<string> = new Set(ACCOMMODATION_SUBTYPES);
const SETTING_SET: ReadonlySet<string> = new Set(SETTINGS);
const REASON_SET: ReadonlySet<string> = new Set(PARA_NO_DATA_REASONS);

function chipsValid(
  observations: readonly ParaObservation[] | undefined,
  subtypes: readonly AccommodationSubtype[] | undefined,
): ParaCaptureReject | null {
  if (observations?.some((o) => !OBS_SET.has(o))) {
    return "invalid_observation_chip";
  }
  if (subtypes?.some((s) => !SUBTYPE_SET.has(s))) {
    return "invalid_accommodation_subtype";
  }
  return null;
}

/** Optional chip fields, spread only when present (exactOptionalPropertyTypes-safe). */
function chipFields(
  input: ParaEntryInput,
): Partial<Pick<ProgressDataPoint, "para_observations" | "accommodation_subtypes">> {
  return {
    ...(input.paraObservations !== undefined ? { para_observations: input.paraObservations } : {}),
    // The para's OWN witnessed selections — never sourced from the goal's accom_mod.
    ...(input.accommodationSubtypes !== undefined
      ? { accommodation_subtypes: input.accommodationSubtypes }
      : {}),
  };
}

/**
 * Build a para pending data point over the HARD-constrained write. Returns a
 * rejection (never throws for a bad para input) when a bound is violated; the UI
 * surfaces the reason. The result is always scorer=para, never validated, state
 * pending (scored kind) or no_data — it is NOT a record until teacher validation.
 */
export function buildParaPendingPoint(
  ctx: ParaCaptureContext,
  input: ParaEntryInput,
): ParaCaptureResult {
  if (ctx.adminDate < ctx.adminDateBounds.earliest || ctx.adminDate > ctx.adminDateBounds.latest) {
    return { ok: false, reason: "admin_date_out_of_bounds" };
  }
  if (!SETTING_SET.has(ctx.setting)) {
    return { ok: false, reason: "setting_not_allowed" };
  }
  const chipReject = chipsValid(input.paraObservations, input.accommodationSubtypes);
  if (chipReject !== null) {
    return { ok: false, reason: chipReject };
  }

  const base = {
    data_point_id: ctx.dataPointId,
    goal_id: ctx.goalId,
    student_id: ctx.studentId,
    admin_date: ctx.adminDate,
    entry_ts: ctx.entryTs,
    probe_condition_id: ctx.probeConditionId,
    setting: ctx.setting,
    scorer: "para" as const,
    revisions: [],
    ...chipFields(input),
  };

  if (input.kind === "no_data") {
    if (!REASON_SET.has(input.noDataReason)) {
      return { ok: false, reason: "invalid_no_data_reason" };
    }
    return {
      ok: true,
      point: { ...base, state: "no_data", no_data_reason: input.noDataReason },
    };
  }

  // Counts are non-negative integers; Number.isInteger also rejects NaN/±Infinity/
  // fractionals, which would otherwise slip past the `<`/`>` bounds (IEEE NaN
  // comparisons are all false) and land a NaN computed_value that corrupts M8.
  if (!Number.isInteger(ctx.expectedDenominator) || ctx.expectedDenominator <= 0) {
    return { ok: false, reason: "denominator_nonpositive" };
  }
  if (!Number.isInteger(input.denominatorUsed) || input.denominatorUsed <= 0) {
    return { ok: false, reason: "denominator_nonpositive" };
  }
  if (
    !Number.isInteger(input.numerator) ||
    input.numerator < 0 ||
    input.numerator > input.denominatorUsed
  ) {
    return { ok: false, reason: "numerator_out_of_range" };
  }
  return {
    ok: true,
    point: {
      ...base,
      state: "pending",
      numerator: input.numerator,
      denominator_used: input.denominatorUsed,
      // Read-only original; mismatch + ratio via the single value.ts definitions.
      denominator_original: ctx.expectedDenominator,
      denominator_mismatch: isDenominatorMismatch(ctx.expectedDenominator, input.denominatorUsed),
      computed_value: computedRatio(input.numerator, input.denominatorUsed),
    },
  };
}

export interface ValidateOptions {
  /** Validation is a TEACHER action only. */
  readonly who: "teacher";
  readonly when: Timestamp;
}

/** A tombstone marking the para pending entry as consumed (written back to the para doc). */
export interface ParaPendingTombstone {
  readonly dataPointId: OpaqueId;
  readonly consumedTs: Timestamp;
}

export interface ValidatedParaPoint {
  /** The canonical record — written ONLY into the teacher-MK monitoring doc. */
  readonly validated: ProgressDataPoint;
  /** The para pending entry is consumed; this is the only thing written to the para doc. */
  readonly tombstone: ParaPendingTombstone;
}

/** Thrown when validation is attempted on a point that is not a para pending entry. */
export class ParaValidationError extends Error {
  constructor(reason: string) {
    super(`para point cannot be validated: ${reason}`);
    this.name = "ParaValidationError";
  }
}

/**
 * Teacher validation: promote a para pending point to the canonical record that
 * lands in the teacher-MK monitoring doc (a scored pending → `scored`; a documented
 * ⊘ stays `no_data`), stamped validated_by/validated_ts. Returns a tombstone for the
 * para pending entry. Trend/history/mastery/exports are NEVER produced here and are
 * never written back to the para doc (condition #8).
 */
export function validateParaPoint(
  pending: ProgressDataPoint,
  options: ValidateOptions,
): ValidatedParaPoint {
  if (pending.scorer !== "para") {
    throw new ParaValidationError("not a para-entered point");
  }
  if (pending.validated_by !== undefined) {
    throw new ParaValidationError("already validated");
  }
  const validated: ProgressDataPoint = {
    ...pending,
    state: pending.state === "pending" ? "scored" : pending.state,
    validated_by: options.who,
    validated_ts: options.when,
  };
  return { validated, tombstone: { dataPointId: pending.data_point_id, consumedTs: options.when } };
}

/** Deterministic order for a validation batch (admin-date, then opaque id). */
export function orderPendingForValidation(
  points: readonly ProgressDataPoint[],
): ProgressDataPoint[] {
  return [...points].sort(
    (a, b) =>
      compareCodePoints(a.admin_date, b.admin_date) ||
      compareCodePoints(a.data_point_id, b.data_point_id),
  );
}
