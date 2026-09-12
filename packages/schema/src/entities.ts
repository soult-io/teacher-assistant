// Entity field definitions (data-model.md §1–§7). Faithful to the data-model
// spec authored by the data-model-integration agent; this package does not
// reopen settled calls. Semantic/lifecycle validation (gates, owes math,
// exporter guards) lands in later modules (M3/M5–M8) — here we define the shapes
// and the closed vocabularies they draw from.
//
// Fields the data-model leaves genuinely unspecified are marked `[→ DMI]` inline
// and typed at the loosest safe shape rather than invented; the PR lists them.

import type {
  AccomMod,
  AccommodationSubtype,
  ArcDateFlag,
  BaselineSource,
  ColorToken,
  BlockType,
  DataPointState,
  DenominatorModel,
  Frequency,
  GoalStatus,
  MethodGeneral,
  ModifiedNoteTag,
  MypCriterion,
  MypProgressValue,
  NoDataReason,
  ParaCapability,
  ParaObservation,
  PeriodFormat,
  RetestState,
  Scorer,
  Setting,
} from "./enums.js";
import type { OpaqueId, Timestamp } from "./ids.js";

/** ISO calendar date, `YYYY-MM-DD` (admin dates, arc/iep dates). Distinct from the epoch Timestamp. */
export type IsoDate = string & { readonly __brand: "IsoDate" };

// `ColorToken` is now the closed six-hue enum (design §E.2) — see enums.ts.

/** Audit revision entry (data-model §2.4 `{who, when, old→new}`). */
export interface Revision {
  readonly who: string;
  readonly when: Timestamp;
  readonly old: unknown;
  readonly new: unknown;
}

// ── §1 Identity & roster ─────────────────────────────────────────────────────

/** §1.1 TeacherProfile [CLEARTEXT]. Key material is device-only, never a field. */
export interface TeacherProfile {
  readonly teacher_id: OpaqueId;
  readonly display_prefs?: Readonly<Record<string, unknown>>;
}

/** §1.2 Student [ENCRYPTED]. No name/photo/DOB/id/district number — ever. */
export interface Student {
  readonly student_id: OpaqueId;
  /** 2–3 letters, the human identifier. Encrypted. */
  readonly initials: string;
  readonly color_token: ColorToken;
  /** ≥1 period; a student may sit in more than one. Membership edges live here (encrypted), not in a cleartext join table (§1.3, cross-dep #1). */
  readonly period_memberships: readonly OpaqueId[];
  /** Soft-retire; no hard delete (audit). */
  readonly active: boolean;
}

/** §1.3 ClassPeriod [CLEARTEXT] — structural container, carries no student. */
export interface ClassPeriod {
  readonly period_id: OpaqueId;
  /** Room/section label, no student (e.g. "3rd Period Math 81 Resource"). */
  readonly label: string;
  readonly format: PeriodFormat;
  /** Ordered per-format block skeleton (§7.3). */
  readonly day_template: readonly Block[];
  readonly has_para: boolean;
  /** Set iff has_para. */
  readonly para_id?: OpaqueId;
}

/** §1.4 Para [CLEARTEXT scope; sees only scoped ciphertext]. */
export interface Para {
  readonly para_id: OpaqueId;
  /** LOCKED = 3rd period only; scope = full assigned-period roster. */
  readonly assigned_period_ids: readonly OpaqueId[];
  /** Teacher-controlled; default off, on for 3rd. */
  readonly access_enabled: boolean;
  readonly capabilities: readonly ParaCapability[];
}

// ── §2 IEP track (Engine A → Infinite Campus) ────────────────────────────────

/** Consistency requirement (data-model §2.1). Mandatory before a goal goes active. */
export interface CriterionConsistency {
  readonly n_probes: number;
  readonly phrase: string;
}

/** §2.1 IEPGoal [ENCRYPTED]. The 6 KY components + baseline + method + lifecycle. */
export interface IEPGoal {
  readonly goal_id: OpaqueId;
  readonly student_id: OpaqueId;
  /** Full composed goal; audience = initials only, no other student named. */
  readonly goal_text: string;
  readonly behavior: string;
  readonly circumstance: string;
  /** Mastery %, 70–90 (most 80). */
  readonly criterion_level: number;
  readonly criterion_consistency: CriterionConsistency;
  readonly method_general: MethodGeneral;
  readonly method_tool: string;
  readonly frequency: Frequency;
  readonly denominator_model: DenominatorModel;
  /** Mandatory before `active`, not to exist as `proposed`. */
  readonly baseline_value?: number;
  readonly baseline_source?: BaselineSource;
  readonly accom_mod: AccomMod;
  readonly setting_default: Setting;
  /** Picklist the para may choose from; never free text. */
  readonly valid_settings: readonly Setting[];
  readonly status: GoalStatus;
  readonly arc_date?: IsoDate;
  readonly arc_date_flag?: ArcDateFlag;
  /** Kept SEPARATE from arc_date; drives the projection horizon. */
  readonly iep_end_date?: IsoDate;
  /** Derived: arc_date − ~6 instructional weeks (recomputed on arc_date edit). */
  readonly baseline_window_start?: IsoDate;
  readonly probe_definition_id?: OpaqueId;
  readonly created_ts: Timestamp;
  readonly revisions: readonly Revision[];
}

/** §2.2 BaselinePoint [ENCRYPTED]. Separate table so baseline ≠ monitoring data. */
export interface BaselinePoint {
  readonly baseline_point_id: OpaqueId;
  /** Goal must be status=proposed. */
  readonly goal_id: OpaqueId;
  readonly student_id: OpaqueId;
  readonly admin_date: IsoDate;
  readonly entry_ts: Timestamp;
  readonly numerator: number;
  readonly denominator_used: number;
  readonly computed_value?: number;
  /** Must match goal circumstance. */
  readonly probe_condition_id: OpaqueId;
  /** teacher — the para does not baseline. */
  readonly scorer: Extract<Scorer, "teacher">;
}

/** §2.3 ProbeDefinition [ENCRYPTED] — circumstance text is disability-linked. */
export interface ProbeDefinition {
  readonly probe_definition_id: OpaqueId;
  readonly goal_id: OpaqueId;
  /** Assigned probe total-items; mismatch vs denominator_used flags a point. */
  readonly expected_denominator: number;
  /** Must equal/derive the goal circumstance (construct-integrity guard). */
  readonly condition: string;
  readonly label?: string;
}

/** §2.4 ProgressDataPoint [ENCRYPTED] — the ARC-auditable weekly monitoring atom. */
export interface ProgressDataPoint {
  readonly data_point_id: OpaqueId;
  /** Goal must be active to feed IC. */
  readonly goal_id: OpaqueId;
  readonly student_id: OpaqueId;
  /** Probe ADMINISTRATION date — drives week membership/trend/cadence. */
  readonly admin_date: IsoDate;
  /** SEPARATE audit field (who entered, when). */
  readonly entry_ts: Timestamp;
  readonly state: DataPointState;
  /** Required iff state=scored. */
  readonly numerator?: number;
  /** Required iff state=scored. */
  readonly denominator_used?: number;
  /** Probe's expected denominator, retained on mismatch; NEVER overwritten. */
  readonly denominator_original?: number;
  /** Derived: denominator_used ≠ expected. Warn, do not hard-block. */
  readonly denominator_mismatch?: boolean;
  /** Derived: numerator/denominator_used. Stored AND computed; never % alone. */
  readonly computed_value?: number;
  /** Must match goal circumstance (construct-integrity guard). */
  readonly probe_condition_id?: OpaqueId;
  readonly setting: Setting;
  readonly scorer: Scorer;
  /** teacher — REQUIRED before a scorer=para point becomes record. */
  readonly validated_by?: Extract<Scorer, "teacher">;
  readonly validated_ts?: Timestamp;
  /** Required iff state=no_data. */
  readonly no_data_reason?: NoDataReason;
  /** LOCKED closed multi-select (§2.7) — structured enums only, NO free text. */
  readonly para_observations?: readonly ParaObservation[];
  readonly accommodation_subtypes?: readonly AccommodationSubtype[];
  readonly revisions: readonly Revision[];
}

/** §2.6 MasteryObservation [ENCRYPTED]. App observes; ARC closes the goal. */
export interface MasteryObservation {
  readonly observation_id: OpaqueId;
  readonly goal_id: OpaqueId;
  readonly window_met_date: IsoDate;
  readonly acknowledged_by: Extract<Scorer, "teacher">;
  readonly flagged_for_arc: boolean;
}

// ── §3 MYP track (Engine B → Toddle) — physically separate from Engine A ──────

/**
 * §3.1 standard/criterion reference on a progress record. `[→ DMI]` the concrete
 * ref shape (a KY standard code and/or an MYP criterion) is described only as
 * "ref" in the data-model — typed as an explicit optional pair until DMI fixes it.
 */
export interface StandardOrCriterionRef {
  readonly ky_standard_code?: string;
  readonly myp_criterion?: MypCriterion;
}

/** §3.1 MYPProgressRecord [ENCRYPTED] (formative). */
export interface MYPProgressRecord {
  readonly record_id: OpaqueId;
  readonly student_id: OpaqueId;
  readonly period_id?: OpaqueId;
  readonly standard_or_criterion: StandardOrCriterionRef;
  readonly task_id?: OpaqueId;
  readonly value: MypProgressValue;
  readonly revise_resubmit?: boolean;
  readonly date: IsoDate;
}

/** Logged gate deviation (data-model §3.2). Never presented as rubric-compliant. */
export interface GateOverride {
  readonly overridden: boolean;
  readonly reason: string;
  readonly ts: Timestamp;
}

/** §3.2 MYPAchievementRecord [ENCRYPTED] (summative). ONE criterion per record. */
export interface MYPAchievementRecord {
  readonly record_id: OpaqueId;
  readonly student_id: OpaqueId;
  readonly period_id?: OpaqueId;
  readonly unit_id: OpaqueId;
  readonly criterion: MypCriterion;
  /** From the Year-3 strand taxonomy (§3.4). */
  readonly strands_assessed: readonly string[];
  /** Single integer 0–8; store the raw value, band is display-derived. */
  readonly value: number;
  readonly date: IsoDate;
  /** Derived: ≥3 progress records on that standard exist first (default 3). */
  readonly progress_gate_met?: boolean;
  readonly gate_override?: GateOverride;
  readonly retest_state: RetestState;
  readonly modified_flag?: boolean;
  /** STRUCTURED tags, NOT free text (§3.2). */
  readonly modified_note?: readonly ModifiedNoteTag[];
}

/** Per-IEP / FCPS deadline overlay (data-model §3.3). */
export interface DeadlineAdjustment {
  readonly fcps_policy: boolean;
  readonly per_iep_overlay: boolean;
}

/** §3.3 MYPATLRecord [ENCRYPTED]. */
export interface MYPATLRecord {
  readonly record_id: OpaqueId;
  readonly student_id: OpaqueId;
  readonly period_id?: OpaqueId;
  /** `[→ DMI]` the closed ATLSkill id vocabulary (incl. the 3 mandatory + optional TCMS list) is a reference table DMI owns (§3.3, open Q §12). */
  readonly skill_id: string;
  /** 0–8 on the ATL columns 1/2/3-4/5-6/7-8 (§3.3). 0 = no evidence. */
  readonly value: number;
  /** Derived: true for the 3 mandatory skills. */
  readonly mandatory?: boolean;
  readonly date: IsoDate;
  readonly deadline_adjustment?: DeadlineAdjustment;
}

// ── §7 Curriculum & planning ─────────────────────────────────────────────────

/** §7.3 intra-day block. */
export interface Block {
  readonly block_id: OpaqueId;
  readonly type: BlockType;
  readonly minutes: number;
  readonly content_ref?: OpaqueId;
}

/** §7.3 PlanDay. */
export interface PlanDay {
  readonly day_id: OpaqueId;
  readonly week_id: OpaqueId;
  readonly date: IsoDate;
  readonly period_id: OpaqueId;
  readonly blocks: readonly Block[];
}

/** §7.3 PlanWeek [ENCRYPTED once goals attach; else cleartext — classified fail-closed]. */
export interface PlanWeek {
  readonly week_id: OpaqueId;
  readonly iso_week: string;
  readonly segment_id?: OpaqueId;
  readonly banner_standard?: string;
  readonly period_id: OpaqueId;
}

/** §7.3 BlockGoalAttach [ENCRYPTED] — the student-linked attach edge. */
export interface BlockGoalAttach {
  readonly block_id: OpaqueId;
  readonly goal_id: OpaqueId;
  /** accom_mod label mandatory on every attached SDI/differentiation activity. */
  readonly accom_mod_label: AccomMod;
}

/** §7.2 CalendarDay [CLEARTEXT]. */
export interface CalendarDay {
  readonly date: IsoDate;
  readonly holiday: boolean;
  readonly testing: boolean;
  readonly no_school: boolean;
}

/** §7.2 CalendarWeek [CLEARTEXT] — the break-week flag the instructional-weeks primitive reads (§5). */
export interface CalendarWeek {
  readonly iso_week: string;
  readonly non_instructional: boolean;
}
