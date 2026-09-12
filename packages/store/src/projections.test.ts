// M3 projections — proven on SYNTHETIC goals/points only (no TRACK UI yet; that
// is Phase 1). Acceptance (phase0-spec §6): the header renders
// "n of m collectable scored · k excused · j owe"; the group toggle cycles
// owes-first → period → student; baseline goals never appear in active owes math.

import {
  asTimestamp,
  type BaselinePoint,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  type NoDataReason,
  newOpaqueId,
  type OpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  buildBaselineView,
  buildToScoreQueue,
  buildValidationQueue,
  buildWeeklyDashboard,
  groupDashboard,
  nextLens,
  renderHeader,
} from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;

function makeGoal(over: { status: GoalStatus; student: OpaqueId; id?: OpaqueId }): IEPGoal {
  return {
    goal_id: over.id ?? newOpaqueId(),
    student_id: over.student,
    goal_text: "synthetic goal text",
    behavior: "solves two-step problems",
    circumstance: "given a 10-item probe",
    criterion_level: 80,
    criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "10-item probe",
    frequency: "weekly",
    denominator_model: "percent_correct_over_total",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: over.status,
    created_ts: asTimestamp(0),
    revisions: [],
  };
}

function scoredPoint(goal: IEPGoal, date: string): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso(date),
    entry_ts: asTimestamp(0),
    state: "scored",
    numerator: 8,
    denominator_used: 10,
    computed_value: 0.8,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

function noDataPoint(goal: IEPGoal, date: string, reason: NoDataReason): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso(date),
    entry_ts: asTimestamp(0),
    state: "no_data",
    no_data_reason: reason,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

function baselinePoint(goal: IEPGoal, numerator: number): BaselinePoint {
  return {
    baseline_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso("2026-09-08"),
    entry_ts: asTimestamp(0),
    numerator,
    denominator_used: 10,
    probe_condition_id: newOpaqueId(),
    scorer: "teacher",
  };
}

const noBreaks = () => false;
const WEEK_DATE = "2026-09-08"; // ISO week W37

describe("weekly dashboard — states, header, baseline exclusion", () => {
  const s1 = newOpaqueId();
  const s2 = newOpaqueId();
  const s3 = newOpaqueId();
  const s4 = newOpaqueId();
  const s5 = newOpaqueId();
  const g1 = makeGoal({ status: "active", student: s1 }); // scored
  const g2 = makeGoal({ status: "active", student: s2 }); // excused ⊘
  const g3 = makeGoal({ status: "active", student: s3 }); // owes
  const g4 = makeGoal({ status: "active", student: s4 }); // documented no_time (not excused)
  const gProposed = makeGoal({ status: "proposed", student: s5 });

  const goals = [g1, g2, g3, g4, gProposed];
  const points = [
    scoredPoint(g1, WEEK_DATE),
    noDataPoint(g2, WEEK_DATE, "absent"),
    noDataPoint(g4, WEEK_DATE, "no_time"),
  ];
  const baselinePoints = [
    baselinePoint(gProposed, 3),
    baselinePoint(gProposed, 4),
    baselinePoint(gProposed, 5),
  ];

  const dash = buildWeeklyDashboard({
    goals,
    points,
    asOf: WEEK_DATE,
    isNonInstructional: noBreaks,
  });

  it("renders the locked header string", () => {
    // collectable excludes the excused goal: scored(g1) + owes(g3) + documented-no_time(g4) = 3.
    expect(dash.header).toEqual({ scored: 1, collectable: 3, excused: 1, owe: 1 });
    expect(renderHeader(dash.header)).toBe("1 of 3 collectable scored · 1 excused · 1 owe");
  });

  it("assigns the three states correctly", () => {
    const byGoal = new Map(dash.rows.map((r) => [r.goalId, r]));
    expect(byGoal.get(g1.goal_id)?.state).toBe("has_point");
    expect(byGoal.get(g2.goal_id)?.state).toBe("documented_no_data");
    expect(byGoal.get(g2.goal_id)?.excused).toBe(true);
    expect(byGoal.get(g3.goal_id)?.state).toBe("owes");
    expect(byGoal.get(g4.goal_id)?.state).toBe("documented_no_data");
    expect(byGoal.get(g4.goal_id)?.excused).toBe(false); // no_time is documented, NOT excused
  });

  it("never surfaces a proposed/baseline goal into the active dashboard or owes math", () => {
    expect(dash.rows.some((r) => r.goalId === gProposed.goal_id)).toBe(false);
    // The proposed goal lives only in the segregated baseline view.
    const baseline = buildBaselineView(goals, baselinePoints);
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.goalId).toBe(gProposed.goal_id);
    expect(baseline[0]?.usable).toBe(true); // ≥3 points
    expect(baseline[0]?.estimate).toBeCloseTo(0.4); // mean of 3/10,4/10,5/10
    expect(baseline[0]?.label).toBe("estimate");
  });
});

describe("break week generates zero owes (M4 integration)", () => {
  it("a calendar break week yields an empty dashboard with zero owes", () => {
    const s = newOpaqueId();
    const g = makeGoal({ status: "active", student: s });
    const dash = buildWeeklyDashboard({
      goals: [g],
      points: [],
      asOf: WEEK_DATE,
      isNonInstructional: (w) => w === "2026-W37", // the current week is a break
    });
    expect(dash.rows).toEqual([]);
    expect(dash.header).toEqual({ scored: 0, collectable: 0, excused: 0, owe: 0 });
  });
});

describe("grouping lenses (§E.4)", () => {
  it("cycles owes-first → by period → by student → owes-first", () => {
    expect(nextLens("owes_first")).toBe("by_period");
    expect(nextLens("by_period")).toBe("by_student");
    expect(nextLens("by_student")).toBe("owes_first");
  });

  it("owes-first puts owing goals at the top; by-period buckets by period", () => {
    const sA = newOpaqueId();
    const sB = newOpaqueId();
    const gScored = makeGoal({ status: "active", student: sA });
    const gOwes = makeGoal({ status: "active", student: sB });
    const pA = newOpaqueId();
    const pB = newOpaqueId();
    const dash = buildWeeklyDashboard({
      goals: [gScored, gOwes],
      points: [scoredPoint(gScored, WEEK_DATE)],
      asOf: WEEK_DATE,
      isNonInstructional: noBreaks,
      periodByStudent: (sid) => (sid === sA ? pA : pB),
    });

    const owesFirst = groupDashboard(dash.rows, "owes_first");
    expect(owesFirst).toHaveLength(1);
    expect(owesFirst[0]?.rows[0]?.state).toBe("owes"); // owing goal first

    const byPeriod = groupDashboard(dash.rows, "by_period");
    expect(byPeriod.map((g) => g.key).sort()).toEqual([pA, pB].sort());
    for (const group of byPeriod) {
      expect(group.rows).toHaveLength(1);
    }
  });
});

describe("to-score + validation queues", () => {
  it("to-score holds started/holding points; validation holds unvalidated para points", () => {
    const s = newOpaqueId();
    const g = makeGoal({ status: "active", student: s });
    const queued: ProgressDataPoint = { ...scoredPoint(g, WEEK_DATE), state: "queued" };
    const paraPending: ProgressDataPoint = {
      ...scoredPoint(g, WEEK_DATE),
      data_point_id: newOpaqueId(),
      state: "pending",
      scorer: "para",
    };
    const points = [queued, paraPending, scoredPoint(g, WEEK_DATE)];
    expect(buildToScoreQueue(points).map((e) => e.state)).toEqual(["queued"]);
    const validation = buildValidationQueue(points);
    expect(validation).toHaveLength(1);
    expect(validation[0]?.dataPointId).toBe(paraPending.data_point_id);
  });
});
