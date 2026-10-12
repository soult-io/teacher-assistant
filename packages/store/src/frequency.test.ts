// M5 integration — per-goal frequency drives owes on the weekly dashboard
// (closes the Phase-0 weekly default). A monthly goal must not read as owing in
// every week; a weekly goal still owes each instructional week.

import {
  asTimestamp,
  type Frequency,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { buildWeeklyDashboard } from "./index.js";

const noBreaks = () => false;

function goal(frequency: Frequency): IEPGoal {
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
    frequency,
    denominator_model: "percent_correct_over_total",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: "active",
    created_ts: asTimestamp(0),
    revisions: [],
    baseline_value: 40,
    baseline_source: "eval",
  };
}

describe("frequency-driven owes on the dashboard", () => {
  it("a monthly goal owes in the first Sept week but is absent from a later Sept week", () => {
    const monthly = goal("monthly");

    const firstWeek = buildWeeklyDashboard({
      goals: [monthly],
      points: [],
      asOf: "2026-09-07", // W37 — first instructional week of Sept
      isNonInstructional: noBreaks,
    });
    expect(firstWeek.header.owe).toBe(1);

    const laterWeek = buildWeeklyDashboard({
      goals: [monthly],
      points: [],
      asOf: "2026-09-14", // W38 — not its cadence week
      isNonInstructional: noBreaks,
    });
    expect(laterWeek.rows).toEqual([]);
    expect(laterWeek.header.owe).toBe(0);
  });

  it("a weekly goal still owes each instructional week", () => {
    const weekly = goal("weekly");
    const w38 = buildWeeklyDashboard({
      goals: [weekly],
      points: [],
      asOf: "2026-09-14",
      isNonInstructional: noBreaks,
    });
    expect(w38.header.owe).toBe(1);
  });

  it("a scored point in a monthly goal's OFF-cadence week still surfaces (has-point, not owing)", () => {
    const monthly = goal("monthly");
    const point: ProgressDataPoint = {
      data_point_id: newOpaqueId(),
      goal_id: monthly.goal_id,
      student_id: monthly.student_id,
      admin_date: "2026-09-14" as IsoDate, // W38 — not the cadence week
      entry_ts: asTimestamp(0),
      state: "scored",
      numerator: 8,
      denominator_used: 10,
      computed_value: 0.8,
      setting: "math_resource",
      scorer: "teacher",
      revisions: [],
    };
    const dash = buildWeeklyDashboard({
      goals: [monthly],
      points: [point],
      asOf: "2026-09-14",
      isNonInstructional: noBreaks,
    });
    expect(dash.rows).toHaveLength(1);
    expect(dash.rows[0]?.state).toBe("has_point");
    expect(dash.header.owe).toBe(0);
  });
});
