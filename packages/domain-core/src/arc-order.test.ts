// TEACH-25 — ARC history order: admin date newest first, then entry time newest
// first, then the point id; the chart (trend + ⊘ markers) plots the exact reverse,
// so same-day points read in matching order and never follow record order.
import {
  asTimestamp,
  type IEPGoal,
  type IsoDate,
  type NoDataReason,
  type OpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { buildGoalDetail, compareArcNewestFirst } from "./index.js";

const goal: IEPGoal = {
  goal_id: "goal-1" as OpaqueId,
  student_id: "student-1" as OpaqueId,
  goal_text: "Add integers",
  behavior: "b",
  circumstance: "given a 10-item probe",
  criterion_level: 80,
  criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
  method_general: "cbm",
  method_tool: "probe",
  frequency: "weekly",
  denominator_model: "percent_correct_over_total",
  accom_mod: "none",
  setting_default: "math_resource",
  valid_settings: ["math_resource"],
  status: "active",
  created_ts: asTimestamp(0),
  revisions: [],
};

function point(
  id: string,
  date: string,
  entryTs: number,
  over: Partial<ProgressDataPoint> = {},
): ProgressDataPoint {
  return {
    data_point_id: id as OpaqueId,
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: date as IsoDate,
    entry_ts: asTimestamp(entryTs),
    state: "scored",
    numerator: 5,
    denominator_used: 10,
    computed_value: 0.5,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
    ...over,
  };
}

function noData(id: string, date: string, entryTs: number, reason: NoDataReason) {
  const {
    numerator: _n,
    denominator_used: _d,
    computed_value: _c,
    ...base
  } = point(id, date, entryTs);
  return { ...base, state: "no_data", no_data_reason: reason } satisfies ProgressDataPoint;
}

const POINTS = [
  point("c", "2026-09-07", 0),
  point("b", "2026-09-14", 100),
  point("z", "2026-09-14", 200),
  point("a", "2026-09-14", 100),
  point("d", "2026-09-21", 0),
];

describe("compareArcNewestFirst", () => {
  it("orders admin date desc, then entry time desc, then point id asc", () => {
    const ids = [...POINTS].sort(compareArcNewestFirst).map((p) => p.data_point_id);
    expect(ids).toEqual(["d", "z", "a", "b", "c"]);
  });

  it("does not depend on the input order", () => {
    const forward = [...POINTS].sort(compareArcNewestFirst);
    const backward = [...POINTS].reverse().sort(compareArcNewestFirst);
    expect(backward).toEqual(forward);
  });

  it("falls back to the point id while entry_ts is 0 (seed until TEACH-23)", () => {
    const ids = [point("y", "2026-09-14", 0), point("x", "2026-09-14", 0)]
      .sort(compareArcNewestFirst)
      .map((p) => p.data_point_id);
    expect(ids).toEqual(["x", "y"]);
  });
});

describe("buildGoalDetail plot order", () => {
  it("plots trend points as the exact reverse of the ARC history order", () => {
    const history = [...POINTS].sort(compareArcNewestFirst).map((p) => p.data_point_id);
    for (const input of [POINTS, [...POINTS].reverse()]) {
      const plotted = buildGoalDetail(goal, input).trend.map((t) => t.dataPointId);
      expect(plotted).toEqual([...history].reverse());
    }
  });

  it("orders same-day ⊘ markers by entry time, not record order", () => {
    const markers = (pts: readonly ProgressDataPoint[]) =>
      buildGoalDetail(goal, pts).noDataMarkers.map((m) => m.reason);
    const pts = [
      noData("m2", "2026-09-14", 200, "absent"),
      noData("m1", "2026-09-14", 100, "no_time"),
      noData("m0", "2026-09-07", 900, "testing"),
    ];
    expect(markers(pts)).toEqual(["testing", "no_time", "absent"]);
    expect(markers([...pts].reverse())).toEqual(["testing", "no_time", "absent"]);
  });
});
