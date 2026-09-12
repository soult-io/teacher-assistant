// M6a — IEP % → IC export + F4 quarterly summary. Acceptance (PRD §5 export,
// design §F.F4 / FERPA Item-3a). SYNTHETIC data only.

import {
  asTimestamp,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type NoDataReason,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { buildIcExport, computeQuarterlySummary, isIcExportable } from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;

function makeGoal(over?: Partial<{ status: GoalStatus; withBaseline: boolean }>): IEPGoal {
  const withBaseline = over?.withBaseline ?? true;
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "synthetic",
    behavior: "b",
    circumstance: "c",
    criterion_level: 80,
    criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "probe",
    frequency: "weekly",
    denominator_model: "percent_correct_over_total",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: over?.status ?? "active",
    created_ts: asTimestamp(0),
    revisions: [],
    ...(withBaseline ? { baseline_value: 40, baseline_source: "eval" as const } : {}),
  };
}

function scored(
  goal: IEPGoal,
  date: string,
  numerator: number,
  mismatch = false,
): ProgressDataPoint {
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

function noData(goal: IEPGoal, date: string, reason: NoDataReason): ProgressDataPoint {
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

describe("F4 quarterly summary (§6.1)", () => {
  const goal = makeGoal();

  // scored(goal, date, N) = N #correct on a 10-item probe → N*10 percent.
  it("averages the most-recent-5 SCORED points by admin-date", () => {
    const pts = [
      scored(goal, "2026-09-01", 4),
      scored(goal, "2026-09-08", 5),
      scored(goal, "2026-09-15", 6),
      scored(goal, "2026-09-22", 7),
      scored(goal, "2026-09-29", 8),
      scored(goal, "2026-10-06", 9),
      scored(goal, "2026-10-13", 10),
    ];
    const q = computeQuarterlySummary(goal, pts);
    expect(q.n).toBe(5);
    expect(q.average).toBeCloseTo(80); // last 5: 60,70,80,90,100 → 80
    expect(q.dateRange).toEqual({ start: "2026-09-15", end: "2026-10-13" });
    expect(q.label).toBe("quarterly progress summary");
  });

  it("excludes ⊘ from the average but reports the no-data count spanned", () => {
    const pts = [
      scored(goal, "2026-09-01", 6),
      noData(goal, "2026-09-08", "absent"),
      scored(goal, "2026-09-15", 8),
    ];
    const q = computeQuarterlySummary(goal, pts);
    expect(q.n).toBe(2);
    expect(q.average).toBeCloseTo(70); // (60+80)/2
    expect(q.noDataCountSpanned).toBe(1); // the ⊘ falls within [09-01, 09-15]
  });

  it("with <5 scored, averages what exists and labels n (never pads with zeros)", () => {
    const q = computeQuarterlySummary(goal, [scored(goal, "2026-09-01", 7)]);
    expect(q.n).toBe(1);
    expect(q.average).toBeCloseTo(70);
  });

  it("clamps the window at a criterion/denominator-model change", () => {
    const pts = [
      scored(goal, "2026-09-01", 4), // before the change — excluded
      scored(goal, "2026-09-15", 9),
      scored(goal, "2026-09-22", 10),
    ];
    const q = computeQuarterlySummary(goal, pts, { clampAfter: iso("2026-09-10") });
    expect(q.n).toBe(2);
    expect(q.average).toBeCloseTo(95); // (90+100)/2
    expect(q.dateRange?.start).toBe("2026-09-15");
  });

  it("excludes + surfaces a mismatched point (not single-denominator)", () => {
    const pts = [scored(goal, "2026-09-01", 8), scored(goal, "2026-09-08", 6, true)];
    const q = computeQuarterlySummary(goal, pts);
    expect(q.n).toBe(1);
    expect(q.excludedMismatches).toBe(1);
    expect(q.mixedDenominator).toBe(true);
  });
});

describe("IC weekly export block (§9.1a)", () => {
  it("emits one scored value per week + ⊘ rows with reason; in-progress excluded", () => {
    const goal = makeGoal();
    const queued: ProgressDataPoint = { ...scored(goal, "2026-09-22", 5), state: "queued" };
    const [exp] = buildIcExport(
      [goal],
      [scored(goal, "2026-09-08", 7), noData(goal, "2026-09-15", "absent"), queued],
    );
    expect(exp?.weekly).toHaveLength(2); // scored + ⊘, not the queued placeholder
    expect(exp?.weekly[0]).toMatchObject({
      numerator: 7,
      denominator: 10,
      percent: 70,
      state: "scored",
    });
    expect(exp?.weekly[1]).toMatchObject({
      state: "no_data",
      noDataReason: "absent",
      percent: null,
    });
  });
});

describe("STRUCTURAL IC-export guard (FERPA Item-3a)", () => {
  it("only active + baselined + criterion'd goals are exportable", () => {
    expect(isIcExportable(makeGoal({ status: "active" }))).toBe(true);
    expect(isIcExportable(makeGoal({ status: "proposed" }))).toBe(false);
    expect(isIcExportable(makeGoal({ status: "mastered" }))).toBe(false);
    expect(isIcExportable(makeGoal({ status: "retired" }))).toBe(false);
    expect(isIcExportable(makeGoal({ status: "active", withBaseline: false }))).toBe(false);
  });

  it("a proposed goal WITH points is unreachable by the exporter", () => {
    const proposed = makeGoal({ status: "proposed" });
    const active = makeGoal({ status: "active" });
    const exports = buildIcExport(
      [proposed, active],
      [scored(proposed, "2026-09-08", 9), scored(active, "2026-09-08", 8)],
    );
    expect(exports.map((e) => e.goalId)).toEqual([active.goal_id]); // proposed absent
  });
});
