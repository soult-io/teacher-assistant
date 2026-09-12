// M5 — goal-tracker + progress monitoring. Locked rules (design §A/§B, PRD §5),
// proven on SYNTHETIC goals/points only.

import {
  asTimestamp,
  type DenominatorModel,
  type Frequency,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type NoDataReason,
  type ProbeDefinition,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  acknowledgeMastery,
  applyEdit,
  bookmarkForLater,
  buildGoalDetail,
  canBeginMonitoring,
  captureScoredPoint,
  computeValue,
  ConstructIntegrityError,
  consistencyWindow,
  isDueInWeek,
  observeMastery,
  probeMatchesGoal,
  recordNoData,
} from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;
const noBreaks = () => false;

function makeGoal(
  over?: Partial<{
    status: GoalStatus;
    frequency: Frequency;
    criterion: number;
    nProbes: number;
    withBaseline: boolean;
    circumstance: string;
    model: DenominatorModel;
  }>,
): IEPGoal {
  const withBaseline = over?.withBaseline ?? true;
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "synthetic",
    behavior: "solves two-step equations",
    circumstance: over?.circumstance ?? "given a 10-item probe",
    criterion_level: over?.criterion ?? 80,
    criterion_consistency: { n_probes: over?.nProbes ?? 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "probe",
    frequency: over?.frequency ?? "weekly",
    denominator_model: over?.model ?? "percent_correct_over_total",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: over?.status ?? "active",
    created_ts: asTimestamp(0),
    revisions: [],
    ...(withBaseline ? { baseline_value: 40, baseline_source: "eval" as const } : {}),
  };
}

describe("value computation (PRD §5, no %-coercion)", () => {
  it("% model computes #correct/total for 3/5/12-item probes", () => {
    expect(computeValue("percent_correct_over_total", 8, 10).value).toBe(80);
    expect(computeValue("percent_correct_over_total", 3, 5).value).toBe(60);
    expect(computeValue("percent_correct_over_total", 9, 12).value).toBeCloseTo(75);
    expect(computeValue("percent_correct_over_total", 8, 10).isPercent).toBe(true);
  });
  it("non-% models pass through raw (never coerced to %)", () => {
    const rubric = computeValue("rubric_score", 3, 4);
    expect(rubric.value).toBe(3);
    expect(rubric.isPercent).toBe(false);
  });
});

describe("data-point capture + audited edits (§A.1, §B)", () => {
  const goal = makeGoal();
  it("admin date and entry timestamp are separate audit fields", () => {
    const p = captureScoredPoint({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      adminDate: iso("2026-09-07"),
      entryTs: asTimestamp(999),
      numerator: 8,
      denominatorUsed: 10,
      setting: "math_resource",
      scorer: "teacher",
    });
    expect(p.admin_date).toBe("2026-09-07");
    expect(p.entry_ts).toBe(999);
    expect(p.state).toBe("scored");
    expect(p.computed_value).toBeCloseTo(0.8);
  });

  it("flags a denominator mismatch and retains the original (never hard-blocks)", () => {
    const p = captureScoredPoint({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      adminDate: iso("2026-09-07"),
      entryTs: asTimestamp(0),
      numerator: 4,
      denominatorUsed: 5,
      expectedDenominator: 10,
      setting: "math_resource",
      scorer: "teacher",
    });
    expect(p.denominator_mismatch).toBe(true);
    expect(p.denominator_original).toBe(10);
  });

  it("no-data requires a reason and is not a score of 0", () => {
    const p = recordNoData({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      adminDate: iso("2026-09-07"),
      entryTs: asTimestamp(0),
      reason: "absent",
      setting: "math_resource",
      scorer: "teacher",
    });
    expect(p.state).toBe("no_data");
    expect(p.no_data_reason).toBe("absent");
    expect(p.numerator).toBeUndefined();
    expect(() =>
      recordNoData({
        goalId: goal.goal_id,
        studentId: goal.student_id,
        adminDate: iso("2026-09-07"),
        entryTs: asTimestamp(0),
        reason: undefined as unknown as NoDataReason,
        setting: "math_resource",
        scorer: "teacher",
      }),
    ).toThrow();
  });

  it("score-later bookmark is a queued placeholder", () => {
    const p = bookmarkForLater({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      adminDate: iso("2026-09-07"),
      entryTs: asTimestamp(0),
      setting: "math_resource",
      scorer: "teacher",
    });
    expect(p.state).toBe("queued");
  });

  it("[Fix] retains the prior value as a versioned revision (never silent)", () => {
    const p = captureScoredPoint({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      adminDate: iso("2026-09-07"),
      entryTs: asTimestamp(0),
      numerator: 7,
      denominatorUsed: 10,
      setting: "math_resource",
      scorer: "teacher",
    });
    const fixed = applyEdit(p, { numerator: 9 }, "teacher", asTimestamp(100));
    expect(fixed.numerator).toBe(9);
    expect(fixed.computed_value).toBeCloseTo(0.9); // derived value recomputed
    expect(fixed.revisions).toHaveLength(1);
    expect(fixed.revisions[0]?.old).toEqual({ numerator: 7 });
    expect(fixed.revisions[0]?.new).toEqual({ numerator: 9 });
    expect(p.numerator).toBe(7); // original object untouched
  });

  it("a corrective [Fix] to the original total clears the denominator mismatch", () => {
    const flagged = captureScoredPoint({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      adminDate: iso("2026-09-07"),
      entryTs: asTimestamp(0),
      numerator: 4,
      denominatorUsed: 5,
      expectedDenominator: 10,
      setting: "math_resource",
      scorer: "teacher",
    });
    expect(flagged.denominator_mismatch).toBe(true);
    const resolved = applyEdit(
      flagged,
      { numerator: 8, denominator_used: 10 },
      "teacher",
      asTimestamp(100),
    );
    expect(resolved.denominator_mismatch).toBe(false); // re-enters the window
    expect(resolved.denominator_original).toBe(10); // original never overwritten
    expect(resolved.computed_value).toBeCloseTo(0.8);
  });
});

describe("consistency window (§A.3) — consecutive scored probes, ⊘ pauses", () => {
  const goal = makeGoal({ criterion: 80, nProbes: 4 });
  function scored(date: string, numerator: number, mismatch = false): ProgressDataPoint {
    return {
      data_point_id: newOpaqueId(),
      goal_id: goal.goal_id,
      student_id: goal.student_id,
      admin_date: iso(date),
      entry_ts: asTimestamp(0),
      state: "scored",
      numerator,
      denominator_used: 10,
      computed_value: numerator / 10,
      setting: "math_resource",
      scorer: "teacher",
      revisions: [],
      ...(mismatch ? { denominator_mismatch: true } : {}),
    };
  }
  function no_data(date: string, reason: NoDataReason): ProgressDataPoint {
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

  it("a ⊘ pauses (does not break) a run of 4 consecutive ≥criterion probes", () => {
    const pts = [
      scored("2026-09-07", 8),
      scored("2026-09-14", 9),
      no_data("2026-09-21", "absent"), // pauses, not a probe
      scored("2026-09-28", 8),
      scored("2026-10-05", 10),
    ];
    const r = consistencyWindow(goal, pts);
    expect(r.run).toBe(4);
    expect(r.met).toBe(true);
    expect(r.windowMetDate).toBe("2026-10-05");
  });

  it("a below-criterion scored probe resets the run", () => {
    const pts = [scored("2026-09-07", 8), scored("2026-09-14", 5), scored("2026-09-21", 9)];
    expect(consistencyWindow(goal, pts).run).toBe(1);
    expect(consistencyWindow(goal, pts).met).toBe(false);
  });

  it("a mismatched point is excluded from the window and counted", () => {
    const pts = [scored("2026-09-07", 8), scored("2026-09-14", 9, true), scored("2026-09-21", 8)];
    const r = consistencyWindow(goal, pts);
    expect(r.excludedMismatches).toBe(1);
    expect(r.run).toBe(2); // the mismatched point neither counts nor breaks
  });

  it("mastery is observed (flag for ARC), never auto-closed", () => {
    const pts = [
      scored("2026-09-07", 8),
      scored("2026-09-14", 9),
      scored("2026-09-21", 8),
      scored("2026-09-28", 10),
    ];
    const candidate = observeMastery(goal, pts);
    if (candidate === null) {
      throw new Error("expected a mastery candidate");
    }
    const obs = acknowledgeMastery(candidate);
    expect(obs.acknowledged_by).toBe("teacher");
    expect(obs.flagged_for_arc).toBe(true);
    // Observing/acknowledging does NOT mutate the goal status.
    expect(goal.status).toBe("active");
    // A single at-threshold week never masters (nProbes=4).
    expect(observeMastery(goal, [scored("2026-09-07", 8)])).toBeNull();
  });
});

describe("per-goal frequency drives owes (§B)", () => {
  it("weekly/daily are due every instructional week; a break week never is", () => {
    expect(isDueInWeek("weekly", "2026-W37", noBreaks)).toBe(true);
    expect(isDueInWeek("daily", "2026-W38", noBreaks)).toBe(true);
    expect(isDueInWeek("weekly", "2026-W37", (w) => w === "2026-W37")).toBe(false);
  });
  it("monthly is due only in the first instructional week of the month", () => {
    expect(isDueInWeek("monthly", "2026-W37", noBreaks)).toBe(true); // first Sept week
    expect(isDueInWeek("monthly", "2026-W38", noBreaks)).toBe(false); // later Sept week → not owing
  });
});

describe("baseline-mandatory + construct-integrity (§B)", () => {
  it("a goal with no baseline cannot begin monitoring", () => {
    const check = canBeginMonitoring(makeGoal({ withBaseline: false }));
    expect(check.ok).toBe(false);
    expect(check.missing).toContain("baseline_value");
  });
  it("a goal with a baseline + components can begin monitoring", () => {
    expect(canBeginMonitoring(makeGoal()).ok).toBe(true);
  });
  it("a probe logs progress only if it matches the goal's circumstance + goal id", () => {
    const goal = makeGoal({ circumstance: "given a 10-item probe" });
    const match: ProbeDefinition = {
      probe_definition_id: newOpaqueId(),
      goal_id: goal.goal_id,
      expected_denominator: 10,
      condition: "Given a 10-item probe",
    };
    const wrongCondition: ProbeDefinition = { ...match, condition: "given a reading passage" };
    const wrongGoal: ProbeDefinition = { ...match, goal_id: newOpaqueId() };
    expect(probeMatchesGoal(goal, match)).toBe(true);
    expect(probeMatchesGoal(goal, wrongCondition)).toBe(false);
    expect(probeMatchesGoal(goal, wrongGoal)).toBe(false);
  });
});

describe("goal detail read model (R3 D2/D3)", () => {
  it("assembles trend, consistency, fidelity counters, audit, and a mastery candidate", () => {
    const goal = makeGoal({ nProbes: 2 });
    const base = {
      goal_id: goal.goal_id,
      student_id: goal.student_id,
      entry_ts: asTimestamp(0),
      setting: "math_resource" as const,
      scorer: "teacher" as const,
      revisions: [],
    };
    const points: ProgressDataPoint[] = [
      {
        ...base,
        data_point_id: newOpaqueId(),
        admin_date: iso("2026-09-07"),
        state: "scored",
        numerator: 8,
        denominator_used: 10,
        computed_value: 0.8,
      },
      {
        ...base,
        data_point_id: newOpaqueId(),
        admin_date: iso("2026-09-14"),
        state: "scored",
        numerator: 9,
        denominator_used: 10,
        computed_value: 0.9,
      },
      {
        ...base,
        data_point_id: newOpaqueId(),
        admin_date: iso("2026-09-21"),
        state: "no_data",
        no_data_reason: "no_time",
      },
    ];
    const detail = buildGoalDetail(goal, points);
    expect(detail.trend.map((t) => t.value)).toEqual([80, 90]);
    expect(detail.noTimeCount).toBe(1);
    expect(detail.consistency.met).toBe(true); // 2 consecutive ≥80
    expect(detail.masteryCandidate).not.toBeNull();
    expect(detail.quarterlySummary).toBeNull();
  });
});

describe("SME PASS-WITH-CHANGES regressions (M5 PR#15)", () => {
  function scored(goal: IEPGoal, date: string, numerator: number): ProgressDataPoint {
    return {
      data_point_id: newOpaqueId(),
      goal_id: goal.goal_id,
      student_id: goal.student_id,
      admin_date: iso(date),
      entry_ts: asTimestamp(0),
      state: "scored",
      numerator,
      denominator_used: 10,
      computed_value: numerator / 10,
      setting: "math_resource",
      scorer: "teacher",
      revisions: [],
    };
  }

  it("#1 a non-% goal never yields a %-coerced window or mastery candidate", () => {
    const rubric = makeGoal({ model: "rubric_score", nProbes: 2 });
    const pts = [scored(rubric, "2026-09-07", 8), scored(rubric, "2026-09-14", 9)];
    const r = consistencyWindow(rubric, pts);
    expect(r.met).toBe(false);
    expect(r.run).toBe(0);
    expect(observeMastery(rubric, pts)).toBeNull();
  });

  it("#2 a goal with n_probes < 2 cannot begin monitoring", () => {
    const check = canBeginMonitoring(makeGoal({ nProbes: 1 }));
    expect(check.ok).toBe(false);
    expect(check.missing).toContain("criterion_consistency");
  });

  it("#3 capture rejects a probe that doesn't match the goal (construct-integrity)", () => {
    const goal = makeGoal({ circumstance: "given a 10-item probe" });
    const mismatched: ProbeDefinition = {
      probe_definition_id: newOpaqueId(),
      goal_id: goal.goal_id,
      expected_denominator: 10,
      condition: "given a reading passage",
    };
    expect(() =>
      captureScoredPoint({
        goalId: goal.goal_id,
        studentId: goal.student_id,
        adminDate: iso("2026-09-07"),
        entryTs: asTimestamp(0),
        numerator: 8,
        denominatorUsed: 10,
        setting: "math_resource",
        scorer: "teacher",
        construct: { goal, probe: mismatched },
      }),
    ).toThrow(ConstructIntegrityError);

    const matching: ProbeDefinition = { ...mismatched, condition: "Given a 10-item probe" };
    const p = captureScoredPoint({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      adminDate: iso("2026-09-07"),
      entryTs: asTimestamp(0),
      numerator: 8,
      denominatorUsed: 10,
      setting: "math_resource",
      scorer: "teacher",
      construct: { goal, probe: matching },
    });
    expect(p.probe_condition_id).toBe(matching.probe_definition_id);
  });

  it("#4 a scored → no_data [Fix] carries no residual score", () => {
    const goal = makeGoal();
    const p = scored(goal, "2026-09-07", 8);
    const cleared = applyEdit(
      p,
      { state: "no_data", no_data_reason: "absent" },
      "teacher",
      asTimestamp(1),
    );
    expect(cleared.state).toBe("no_data");
    expect(cleared.no_data_reason).toBe("absent");
    expect(cleared.numerator).toBeUndefined();
    expect(cleared.denominator_used).toBeUndefined();
    expect(cleared.computed_value).toBeUndefined();
  });

  it("#5 a behavior ⊘ increments behaviorCount only (soft flag, not excused/no_time)", () => {
    const goal = makeGoal();
    const detail = buildGoalDetail(goal, [
      {
        data_point_id: newOpaqueId(),
        goal_id: goal.goal_id,
        student_id: goal.student_id,
        admin_date: iso("2026-09-07"),
        entry_ts: asTimestamp(0),
        state: "no_data",
        no_data_reason: "behavior",
        setting: "math_resource",
        scorer: "teacher",
        revisions: [],
      },
    ]);
    expect(detail.behaviorCount).toBe(1);
    expect(detail.excusedCount).toBe(0);
    expect(detail.noTimeCount).toBe(0);
  });
});
