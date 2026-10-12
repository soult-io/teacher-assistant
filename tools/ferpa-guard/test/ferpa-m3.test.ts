// FERPA-guard — the M3 HARD STOP (phase0-spec §6, data-model §10.3): a
// proposed/baseline goal is NEVER surfaced into the active weekly dashboard or
// its owes math. This is the structural guard that a baseline goal cannot leak
// into the IC-bound monitoring view. Proven behaviourally against the real
// projection engine.

import {
  asTimestamp,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type OpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { buildWeeklyDashboard } from "@teacher-assistant/store";
import { describe, expect, it } from "vitest";

const WEEK_DATE = "2026-09-08";

function goal(status: GoalStatus, student: OpaqueId): IEPGoal {
  return {
    goal_id: newOpaqueId(),
    student_id: student,
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
    status,
    created_ts: asTimestamp(0),
    revisions: [],
  };
}

function scored(g: IEPGoal): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: g.goal_id,
    student_id: g.student_id,
    admin_date: WEEK_DATE as IsoDate,
    entry_ts: asTimestamp(0),
    state: "scored",
    numerator: 9,
    denominator_used: 10,
    computed_value: 0.9,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

describe("HARD STOP (M3) — proposed/baseline goals never reach the active dashboard", () => {
  it("a proposed goal WITH points in the week is excluded from rows, header, and owes", () => {
    const active = goal("active", newOpaqueId());
    const proposed = goal("proposed", newOpaqueId());
    // Even though the proposed goal has a scored point this week, it must not appear.
    const dash = buildWeeklyDashboard({
      goals: [active, proposed],
      points: [scored(proposed)],
      asOf: WEEK_DATE,
      isNonInstructional: () => false,
    });

    expect(dash.rows.some((r) => r.goalId === proposed.goal_id)).toBe(false);
    // Only the active goal is counted; it owes (no point). The proposed goal's
    // point does not inflate "scored" or any other counter.
    expect(dash.rows).toHaveLength(1);
    expect(dash.rows[0]?.goalId).toBe(active.goal_id);
    expect(dash.header).toEqual({ scored: 0, collectable: 1, excused: 0, owe: 1 });
  });
});
