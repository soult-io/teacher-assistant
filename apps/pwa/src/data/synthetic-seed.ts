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
  type NoDataReason,
  type OpaqueId,
  type ProbeDefinition,
  type ProgressDataPoint,
  type Student,
  type Timestamp,
} from "@teacher-assistant/schema";
import { isoDateOf } from "./date.js";
import type { DecryptedRecords } from "./repository.js";

const DAY_MS = 86_400_000;

/** ISO admin date `k` weeks before `now` — the trend/history spans prior weeks. */
function weeksBefore(now: Date, k: number): IsoDate {
  return isoDateOf(new Date(now.getTime() - k * 7 * DAY_MS));
}

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

function noDataPoint(
  goal: IEPGoal,
  adminDate: IsoDate,
  reason: NoDataReason = "absent", // excused — pauses the run, no fidelity ding
): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: adminDate,
    entry_ts: asTimestamp(0),
    state: "no_data",
    no_data_reason: reason,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

/**
 * A teacher-COUNTED off-basis point (F-2): the total differs from the assigned
 * probe (denominator_used ≠ denominator_original), the teacher acknowledged it and
 * elected "counted" — so it plots ON the trend line carrying a non-strippable
 * off-basis flag (never silently normalized).
 */
function countedOffBasisPoint(
  goal: IEPGoal,
  adminDate: IsoDate,
  numerator: number,
  denominatorUsed: number,
): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: adminDate,
    entry_ts: asTimestamp(0),
    state: "scored",
    numerator,
    denominator_used: denominatorUsed,
    denominator_original: 5,
    denominator_mismatch: true,
    mismatch_acknowledged: true,
    mismatch_window_disposition: "counted",
    computed_value: numerator / denominatorUsed,
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

  // Baseline + horizon so the goals feed the M6a quarterly + M8 auto-statement
  // (isIcExportable needs a baseline + source; the statement projects to iep_end).
  // Kept SEPARATE from arc_date (design R3-4). Well in the future so the horizon
  // is valid for the on-trend projection.
  const iepEnd = isoDateOf(new Date(now.getTime() + 70 * DAY_MS));
  const baselined = (value: number) =>
    ({
      baseline_value: value,
      baseline_source: "eval" as const,
      iep_end_date: iepEnd,
    }) satisfies Partial<IEPGoal>;

  const abTwoStep: IEPGoal = {
    ...baseGoal(ab.student_id, "Two-step equations", createdTs),
    ...baselined(35),
    status: "active",
  };
  const cdFractions: IEPGoal = {
    ...baseGoal(cd.student_id, "Multiply fractions", createdTs),
    ...baselined(45),
    status: "active",
  };
  const abIntegers: IEPGoal = {
    ...baseGoal(ab.student_id, "Add integers", createdTs),
    ...baselined(40),
    status: "active",
  };
  const efSciNotation: IEPGoal = {
    ...baseGoal(ef.student_id, "Scientific notation", createdTs),
    ...baselined(50),
    status: "active",
  };
  const cdNumberLine: IEPGoal = {
    ...baseGoal(cd.student_id, "Number line", createdTs),
    ...baselined(40),
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

  // Current-week points (drive THIS week's dashboard header — unchanged from U2/U3):
  // 2 scored, 1 excused ⊘, 1 pending-para (owes), cdFractions owes (no point).
  // Prior-week HISTORY points (weeksBefore) build the Goal Detail trend/consistency/
  // quarterly/auto-statement WITHOUT touching the current-week projection (the
  // dashboard filters points to the asOf ISO week). Each goal exercises one scenario:
  const points: ProgressDataPoint[] = [
    // ── abIntegers (AB): ≥8 CLEAN scored points, rising → a real ON-TREND draft
    //    statement (clears the ≥8-point / ≥4-week gate). Trailing run < 4 (a wk-1
    //    dip), so the consistency window is "not yet" — not a mastery candidate.
    scoredPoint(abIntegers, weeksBefore(now, 7), 2), // 40%
    scoredPoint(abIntegers, weeksBefore(now, 6), 2), // 40%
    scoredPoint(abIntegers, weeksBefore(now, 5), 3), // 60%
    scoredPoint(abIntegers, weeksBefore(now, 4), 3), // 60%
    scoredPoint(abIntegers, weeksBefore(now, 3), 4), // 80%
    scoredPoint(abIntegers, weeksBefore(now, 2), 4), // 80%
    scoredPoint(abIntegers, weeksBefore(now, 1), 3), // 60% (dip → breaks the run)
    scoredPoint(abIntegers, adminDate, 4), // 80% (current week) — 8 points total

    // ── cdFractions (CD): a MASTERY-ELIGIBLE run (last 4 ≥ criterion) but only 5
    //    scored points → its draft statement is INDETERMINATE. The two gates
    //    diverge: window MET, yet too few points for a defensible trend claim.
    scoredPoint(cdFractions, weeksBefore(now, 5), 3), // 60%
    scoredPoint(cdFractions, weeksBefore(now, 4), 4), // 80%
    scoredPoint(cdFractions, weeksBefore(now, 3), 4), // 80%
    scoredPoint(cdFractions, weeksBefore(now, 2), 4), // 80%
    scoredPoint(cdFractions, weeksBefore(now, 1), 4), // 80% — 4 consecutive ≥80
    // cdFractions has no point this week → still owes

    // ── efSciNotation (EF): a COUNTED off-basis point (total 6 ≠ assigned 5) that
    //    plots WITH its off-basis flag; < 8 points → INDETERMINATE statement.
    scoredPoint(efSciNotation, weeksBefore(now, 3), 3), // 60% clean
    countedOffBasisPoint(efSciNotation, weeksBefore(now, 2), 4, 6), // 67% off-basis, counted
    scoredPoint(efSciNotation, weeksBefore(now, 1), 3), // 60% clean
    scoredPoint(efSciNotation, adminDate, 3), // 60% (current week)

    // ── cdNumberLine (CD): a ⊘ GAP mid-series (never a plotted 0); the most-recent
    //    scored window SPANS a no-data week → the F4 "no-data weeks spanned" label.
    scoredPoint(cdNumberLine, weeksBefore(now, 4), 3), // 60%
    noDataPoint(cdNumberLine, weeksBefore(now, 3), "absent"), // ⊘ gap between scored points
    scoredPoint(cdNumberLine, weeksBefore(now, 2), 4), // 80%
    scoredPoint(cdNumberLine, weeksBefore(now, 1), 4), // 80%
    noDataPoint(cdNumberLine, adminDate), // excused ⊘ (current week)

    // ── abTwoStep (AB): a short history behind an owes/pending-para row — reachable
    //    from the dashboard via the ↗ trend button; < 8 points → INDETERMINATE.
    scoredPoint(abTwoStep, weeksBefore(now, 2), 2), // 40%
    scoredPoint(abTwoStep, weeksBefore(now, 1), 3), // 60%
    pendingParaPoint(abTwoStep, adminDate, 3), // owes + pending-para note (current week)
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

  // No mastery observation seeded — a mastery-eligible run (cdFractions) surfaces
  // the teacher's Acknowledge action on Goal Detail; acknowledging writes one.
  return { students, goals, points, periods, probes, observations: [] };
}
