// U5 create-goal assembly (design §F.F5). PURE: it maps the collected form values
// to a new IEPGoal + its assigned ProbeDefinition (+ a Student when the initials are
// new). It holds NO create RULES — the baseline-mandatory gate is the engine's
// `canBeginMonitoring`, checked by the screen against the assembled goal. Two paths:
// ADOPT (a baseline is already in hand → active) and DRAFT (a proposed goal to
// baseline → status proposed, no baseline yet, no owes, never feeds IC).

import {
  type AccomMod,
  asTimestamp,
  type ColorToken,
  type DenominatorBasis,
  type Frequency,
  type IEPGoal,
  newOpaqueId,
  type OpaqueId,
  type ProbeDefinition,
  type Setting,
  type Student,
  type Timestamp,
} from "@teacher-assistant/schema";

export type GoalPath = "adopt" | "draft";

/** The raw form values the create screen collects (strings from inputs; parsed here). */
export interface NewGoalForm {
  readonly path: GoalPath;
  readonly initials: string;
  readonly behavior: string;
  readonly circumstance: string;
  /** Criterion mastery level (%) and consistency (n consecutive probes). */
  readonly level: string;
  readonly consistency: string;
  readonly methodTool: string;
  readonly frequency: Frequency;
  readonly denominatorBasis: DenominatorBasis;
  /** Total items per probe — the fixed basis. Ignored (suggested only) when basis = variable. */
  readonly total: string;
  readonly setting: Setting;
  readonly accomMod: AccomMod;
  /** Already-collected baseline % — ADOPT path only. */
  readonly baseline: string;
}

export interface AssembledGoal {
  readonly goal: IEPGoal;
  readonly probe: ProbeDefinition;
  /** Present when the initials did not match an existing student (a new roster entry). */
  readonly student?: Student;
}

function toInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a baseline % — undefined for a blank OR non-numeric entry (never a stray 0%). */
function parseBaseline(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** A suggested/typical probe total; a variable-basis goal still carries one for the sheet default. */
const DEFAULT_TOTAL = 5;

/**
 * Assemble the goal + probe (+ new student) from the form. `studentId` is the
 * resolved student (existing or freshly minted); when `newStudent` is provided it
 * is returned so the caller persists it. The criterion is provisional for a DRAFT
 * (finalized at ARC adoption) and active-ready for ADOPT.
 */
export function assembleGoal(
  form: NewGoalForm,
  studentId: OpaqueId,
  createdTs: Timestamp,
  newStudent?: Student,
): AssembledGoal {
  const total = Math.max(1, toInt(form.total, DEFAULT_TOTAL));
  const nProbes = toInt(form.consistency, 0);
  const level = toInt(form.level, 0);
  const circumstance = form.circumstance.trim();
  const goalId = newOpaqueId();
  const probeId = newOpaqueId();
  // ADOPT baseline: a real number, else undefined — a blank OR non-numeric entry must
  // NOT read as a 0% baseline (that would satisfy the baseline-mandatory gate falsely).
  const baselineValue = form.path === "adopt" ? parseBaseline(form.baseline) : undefined;

  const goal: IEPGoal = {
    goal_id: goalId,
    student_id: studentId,
    // Link the assigned probe so baseline points can share one comparable condition.
    probe_definition_id: probeId,
    goal_text: `${form.initials.trim()} will ${form.behavior.trim()}, ${circumstance}`,
    behavior: form.behavior.trim(),
    circumstance,
    criterion_level: level,
    criterion_consistency: { n_probes: nProbes, phrase: `${nProbes} consecutive probes` },
    method_general: "cbm",
    method_tool: form.methodTool.trim(),
    frequency: form.frequency,
    denominator_model: "percent_correct_over_total",
    denominator_basis: form.denominatorBasis,
    accom_mod: form.accomMod,
    setting_default: form.setting,
    valid_settings: [form.setting],
    status: form.path === "adopt" ? "active" : "proposed",
    created_ts: createdTs,
    revisions: [],
    // ADOPT: the baseline is already in hand → lock it so the goal can begin
    // monitoring. Only a real numeric entry counts (parseBaseline); a blank or
    // non-numeric field stays undefined so the baseline-mandatory gate blocks.
    ...(baselineValue !== undefined
      ? { baseline_value: baselineValue, baseline_source: "eval" as const }
      : {}),
  };

  const probe: ProbeDefinition = {
    probe_definition_id: probeId,
    goal_id: goalId,
    expected_denominator: total,
    condition: circumstance,
    label: `${total}-item probe`,
  };

  return { goal, probe, ...(newStudent !== undefined ? { student: newStudent } : {}) };
}

/** Mint a new roster Student for initials that don't match an existing one. */
export function makeStudent(initials: string, color: ColorToken): Student {
  return {
    student_id: newOpaqueId(),
    initials: initials.trim().toUpperCase(),
    color_token: color,
    period_memberships: [],
    active: true,
  };
}

/** A fresh, empty form (DRAFT path by default; nothing pre-selected that would default a choice). */
export function emptyForm(): NewGoalForm {
  return {
    path: "draft",
    initials: "",
    behavior: "",
    circumstance: "",
    level: "",
    consistency: "",
    methodTool: "",
    frequency: "weekly",
    denominatorBasis: "fixed",
    total: "",
    setting: "math_resource",
    accomMod: "none",
    baseline: "",
  };
}

/** The entry timestamp for a create action (kept as a helper so the screen stays pure-ish). */
export function nowTs(): Timestamp {
  return asTimestamp(Date.now());
}
