// Synthetic caseload (SYNTHETIC DATA ONLY — no real student record until Neil's
// go + the FCPS-AUP/IDEA-consent check, ui-build-spec §1). Mirrors the
// prototype's cast (AB/CD/EF/GH/JM/RT) so the built dashboard reads like the
// validated design. It exercises all three dashboard states plus a proposed goal
// that must be EXCLUDED from the active weekly dashboard (M3 invariant).
//
// Admin dates are set to "today" at seed time, so the seeded points fall in the
// same ISO week the dashboard evaluates (asOf = now) and render as a live mix.
// Ids are freshly minted opaque UUIDs (never derived from initials) each seed.

import {
  asTimestamp,
  type ClassPeriod,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type OpaqueId,
  type ProbeDefinition,
  type ProgressDataPoint,
  type Student,
  type Timestamp,
} from "@teacher-assistant/schema";
import { isoDateOf } from "./date.js";
import type { DecryptedRecords } from "./repository.js";

interface StudentSeed {
  readonly initials: string;
  readonly color: Student["color_token"];
}

const CAST: readonly StudentSeed[] = [
  { initials: "AB", color: "--s-ab" },
  { initials: "CD", color: "--s-cd" },
  { initials: "EF", color: "--s-ef" },
  { initials: "GH", color: "--s-gh" },
];

function baseGoal(
  studentId: OpaqueId,
  text: string,
  createdTs: Timestamp,
): Omit<IEPGoal, "status"> {
  return {
    goal_id: newOpaqueId(),
    student_id: studentId,
    goal_text: text,
    behavior: "solves the target skill",
    circumstance: "given a 5-item probe",
    criterion_level: 80,
    criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "5-item probe",
    frequency: "weekly",
    denominator_model: "percent_correct_over_total",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    created_ts: createdTs,
    revisions: [],
  };
}

function scoredPoint(goal: IEPGoal, adminDate: IsoDate, numerator: number): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: adminDate,
    entry_ts: asTimestamp(0),
    state: "scored",
    numerator,
    denominator_used: 5,
    // Record the probe basis (expected total 5) like a real captureScoredPoint
    // does — on-basis here, and so a later [Fix] to a different total can flag the
    // mismatch. Never a mismatch as seeded (used === original).
    denominator_original: 5,
    computed_value: numerator / 5,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

function noDataPoint(goal: IEPGoal, adminDate: IsoDate): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: adminDate,
    entry_ts: asTimestamp(0),
    state: "no_data",
    no_data_reason: "absent", // excused — pauses the run, no fidelity ding
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

/**
 * A para-entered point awaiting teacher validation (scorer=para, no validated_by).
 * It does not score the goal — the goal still owes a validated point — but the
 * dashboard surfaces the pending-para note (buildValidationQueue) on its row.
 */
function pendingParaPoint(goal: IEPGoal, adminDate: IsoDate, numerator: number): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: adminDate,
    entry_ts: asTimestamp(0),
    state: "pending",
    numerator,
    denominator_used: 5,
    computed_value: numerator / 5,
    setting: "math_resource",
    scorer: "para",
    revisions: [],
  };
}

/** The goal's assigned probe: expected total + condition (drives the M5 mismatch flag). */
function probeFor(goal: IEPGoal): ProbeDefinition {
  return {
    probe_definition_id: newOpaqueId(),
    goal_id: goal.goal_id,
    expected_denominator: 5,
    condition: "given a 5-item probe",
    label: "5-item probe",
  };
}

/** A synthetic class period (cleartext structural container; carries no student). */
function classPeriod(label: string, hasPara: boolean): ClassPeriod {
  return {
    period_id: newOpaqueId(),
    label,
    format: "blended_resource",
    day_template: [],
    has_para: hasPara,
    // "Set iff has_para" (schema §1.3); opaque, no student payload.
    ...(hasPara ? { para_id: newOpaqueId() } : {}),
  };
}

/**
 * Build a fresh synthetic record set. The dashboard for `now` shows: 2 scored,
 * 1 excused (⊘ absent), 2 owes, and the proposed goal excluded — a live read
 * across all three states.
 */
export function buildSyntheticSeed(now: Date = new Date()): DecryptedRecords {
  const adminDate = isoDateOf(now);
  const createdTs = asTimestamp(now.getTime());

  // Two periods so the by-period lens has real buckets; P2 has the para.
  const p2 = classPeriod("P2", true);
  const p4 = classPeriod("P4", false);
  const periods: ClassPeriod[] = [p2, p4];
  const memberships: readonly (readonly OpaqueId[])[] = [
    [p2.period_id], // AB
    [p2.period_id], // CD
    [p4.period_id], // EF
    [p4.period_id], // GH
  ];

  const students: Student[] = CAST.map((s, i) => ({
    student_id: newOpaqueId(),
    initials: s.initials,
    color_token: s.color,
    period_memberships: memberships[i] ?? [],
    active: true,
  }));
  const [ab, cd, ef, gh] = students;
  // The cast is a fixed literal, so all four are present; guard for the types.
  if (ab === undefined || cd === undefined || ef === undefined || gh === undefined) {
    throw new Error("synthetic seed: cast is incomplete");
  }

  const abTwoStep: IEPGoal = {
    ...baseGoal(ab.student_id, "Two-step equations", createdTs),
    status: "active",
  };
  const cdFractions: IEPGoal = {
    ...baseGoal(cd.student_id, "Multiply fractions", createdTs),
    status: "active",
  };
  const abIntegers: IEPGoal = {
    ...baseGoal(ab.student_id, "Add integers", createdTs),
    status: "active",
  };
  const efSciNotation: IEPGoal = {
    ...baseGoal(ef.student_id, "Scientific notation", createdTs),
    status: "active",
  };
  const cdNumberLine: IEPGoal = {
    ...baseGoal(cd.student_id, "Number line", createdTs),
    status: "active",
  };
  // Proposed (baselining) — must NEVER reach the active weekly dashboard.
  const ghProposed: IEPGoal = {
    ...baseGoal(gh.student_id, "Add integers", createdTs),
    status: "proposed",
  };

  const goals: IEPGoal[] = [
    abTwoStep,
    cdFractions,
    abIntegers,
    efSciNotation,
    cdNumberLine,
    ghProposed,
  ];

  const points: ProgressDataPoint[] = [
    scoredPoint(abIntegers, adminDate, 4), // 80%
    scoredPoint(efSciNotation, adminDate, 3), // 60%
    noDataPoint(cdNumberLine, adminDate), // excused ⊘
    pendingParaPoint(abTwoStep, adminDate, 3), // owes + pending-para note
    // cdFractions has no point this week → owes
  ];

  // One assigned probe per active goal (expected total 5) — the sheet defaults to
  // it and flags a mismatch when the entered total differs.
  const probes: ProbeDefinition[] = [
    abTwoStep,
    cdFractions,
    abIntegers,
    efSciNotation,
    cdNumberLine,
  ].map(probeFor);

  return { students, goals, points, periods, probes };
}
