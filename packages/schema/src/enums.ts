// Closed enumerations (data-model §1–§7). These are LOCKED vocabularies: several
// (the para observation chips §2.7, the para capability set §1.4) are FERPA hard
// gates — any addition must re-clear the privacy gate before it ships. They are
// expressed as `as const` tuples so the union type and the runtime membership
// list can never drift apart.

/** Helper: the element union of a readonly string tuple. */
type Member<T extends readonly string[]> = T[number];

// ── Identity / roster ──────────────────────────────────────────────────────

/**
 * Fixed per-student identity colour tokens (data-model §1.2, design §E.2) — the
 * six locked hues. The palette excludes the status hues (green/amber/red). A
 * token is assigned per student; it carries no PII on its own.
 */
export const COLOR_TOKENS = ["--s-ab", "--s-cd", "--s-ef", "--s-gh", "--s-jm", "--s-rt"] as const;
export type ColorToken = Member<typeof COLOR_TOKENS>;

/** Class-period instructional format (data-model §1.3). Drives the day template. */
export const PERIOD_FORMATS = ["blended_resource", "sdi_only_strategies", "co_teach"] as const;
export type PeriodFormat = Member<typeof PERIOD_FORMATS>;

/**
 * The para capability set (data-model §1.4) — FIXED. It CANNOT include
 * edit_goal, view_goal_definition, mark_mastered, push_ic, export, or
 * view_other_period; those are structurally impossible on the para path.
 */
export const PARA_CAPABILITIES = [
  "administer_probe",
  "enter_data_point",
  "record_no_data",
] as const;
export type ParaCapability = Member<typeof PARA_CAPABILITIES>;

// ── IEP track (Engine A) ─────────────────────────────────────────────────────

/** Goal lifecycle (data-model §2.5). The app never auto-transitions active→mastered. */
export const GOAL_STATUSES = ["proposed", "active", "mastered", "retired"] as const;
export type GoalStatus = Member<typeof GOAL_STATUSES>;

/** Progress-monitoring method, general class (data-model §2.1). */
export const METHODS_GENERAL = ["cbm", "direct", "indirect", "authentic"] as const;
export type MethodGeneral = Member<typeof METHODS_GENERAL>;

/** Scoring model (data-model §2.1). MVP builds %-only UI; never %-coerce the others. */
export const DENOMINATOR_MODELS = [
  "percent_correct_over_total",
  "rubric_score",
  "frequency_count",
  "duration_latency",
] as const;
export type DenominatorModel = Member<typeof DENOMINATOR_MODELS>;

/** Monitoring cadence (data-model §2.1). Drives per-goal owes. */
export const FREQUENCIES = ["daily", "weekly", "twice_monthly", "monthly"] as const;
export type Frequency = Member<typeof FREQUENCIES>;

/** Accommodation / modification posture (data-model §2.1). Never silent-defaulted. */
export const ACCOM_MODS = ["accommodation", "modification", "none"] as const;
export type AccomMod = Member<typeof ACCOM_MODS>;

/** Valid probe settings / the para setting picklist (data-model §2.1). */
export const SETTINGS = ["math_resource", "gen_ed", "home_scored"] as const;
export type Setting = Member<typeof SETTINGS>;

/** Who produced a value (data-model §2.2/§2.4). The para does not baseline. */
export const SCORERS = ["teacher", "para"] as const;
export type Scorer = Member<typeof SCORERS>;

export const BASELINE_SOURCES = ["eval", "computed_from_baseline_points"] as const;
export type BaselineSource = Member<typeof BASELINE_SOURCES>;

export const ARC_DATE_FLAGS = ["tentative", "confirmed"] as const;
export type ArcDateFlag = Member<typeof ARC_DATE_FLAGS>;

/** Monitoring point state (data-model §2.4/§2.6). */
export const DATA_POINT_STATES = ["scored", "no_data", "incomplete", "queued", "pending"] as const;
export type DataPointState = Member<typeof DATA_POINT_STATES>;

/**
 * F-2 teacher election on a denominator-mismatched scored point (design §B). Two
 * values only; the pending/unresolved state is the NULL case (the field absent),
 * never a third enum value. State machine: pending → counted | excluded.
 *   - "counted"  = in the consistency/quarterly math + trend, carried with a
 *                  non-strippable off-basis flag in every rendering.
 *   - "excluded" = out of the computed math, but retained + visible in audit/history.
 * The M8 auto-statement HARD-excludes every mismatched point regardless of this
 * election (a statement cannot flip on an off-basis point).
 */
export const MISMATCH_DISPOSITIONS = ["counted", "excluded"] as const;
export type MismatchDisposition = Member<typeof MISMATCH_DISPOSITIONS>;

/**
 * No-data reason (data-model §2.4, §A.2). `no_time` is a fidelity gap (accrues
 * the No-time counter, NOT excused); absent/testing/no_school are excused and
 * pause (never break) the consistency run. The para path may write only a
 * restricted subset (§4) — enforced on the write projection, not here.
 */
export const NO_DATA_REASONS = ["no_time", "absent", "testing", "behavior", "no_school"] as const;
export type NoDataReason = Member<typeof NO_DATA_REASONS>;

/**
 * Para observation chips — LOCKED closed enum (data-model §2.7). Multi-select,
 * no "Other", no free text, no diagnosis labels. FERPA hard gate: any addition
 * must re-clear the privacy gate.
 */
export const PARA_OBSERVATIONS = [
  "Independent",
  "Accommodation",
  "Within2Prompts",
  "ThreePlusPrompts",
  "Frustrated",
  "OffTask",
  "TaskRefusal",
  "OnTaskNeededMoreTime",
  "UsedLearnedStrategy",
  "SelfCorrected",
] as const;
export type ParaObservation = Member<typeof PARA_OBSERVATIONS>;

/** Accommodation sub-enum (data-model §2.7) — also the teacher accommodation vocab. */
export const ACCOMMODATION_SUBTYPES = [
  "Calculator",
  "MultiplicationGrid",
  "WorkedExample",
  "Manipulatives",
  "KeywordList",
  "SymbolChart",
] as const;
export type AccommodationSubtype = Member<typeof ACCOMMODATION_SUBTYPES>;

// ── MYP track (Engine B) ─────────────────────────────────────────────────────

/** Formative progress value (data-model §3.1). NO 0, NO %. M = missing opportunity. */
export const MYP_PROGRESS_VALUES = ["3", "2", "1", "M"] as const;
export type MypProgressValue = Member<typeof MYP_PROGRESS_VALUES>;

/** MYP math criteria (data-model §3.2/§3.4). */
export const MYP_CRITERIA = ["A", "B", "C", "D"] as const;
export type MypCriterion = Member<typeof MYP_CRITERIA>;

/** Achievement retest state machine, per (criterion, standard) (data-model §3.2). */
export const RETEST_STATES = ["none", "required", "offered", "complete"] as const;
export type RetestState = Member<typeof RETEST_STATES>;

/**
 * Modified-assessment tags (data-model §3.2) — STRUCTURED, never free text (a
 * free-text "modified" note is a re-ID/disability leak). Closed vocabulary.
 */
export const MODIFIED_NOTE_TAGS = [
  "read_aloud",
  "scribe",
  "extended_time",
  "chunked",
  "fewer_items_same_strand",
  "manipulatives",
  "simplified_prompt_language",
  "calculator",
] as const;
export type ModifiedNoteTag = Member<typeof MODIFIED_NOTE_TAGS>;

/** ATL skill cluster (data-model §3.4 reference table). */
export const ATL_CLUSTERS = [
  "Communication",
  "Social",
  "Self-management",
  "Research",
  "Thinking",
] as const;
export type AtlCluster = Member<typeof ATL_CLUSTERS>;

// ── Planning ─────────────────────────────────────────────────────────────────

/** Intra-day block type (data-model §7.3). Color by type is a design concern. */
export const BLOCK_TYPES = [
  "warmup",
  "core",
  "brain_break",
  "sdi_stations",
  "review_core",
  "fluency",
] as const;
export type BlockType = Member<typeof BLOCK_TYPES>;
