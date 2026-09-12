// FERPA-guard — HARD STOP #7 (structural IC-export guard, data-model §2.1/§9.1,
// FERPA Item-3a): a proposed/baseline goal is INCAPABLE of reaching the IC
// exporter. Proven behaviourally against the real M6a exporter: even a proposed
// goal that carries scored points produces NO export output, and there is no
// per-goal override that could emit one.

import { buildIcExport, isIcExportable } from "@teacher-assistant/domain-core";
import {
  asTimestamp,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";

function goal(status: GoalStatus, withBaseline = true): IEPGoal {
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
    status,
    created_ts: asTimestamp(0),
    revisions: [],
    ...(withBaseline ? { baseline_value: 40, baseline_source: "eval" as const } : {}),
  };
}

function scored(g: IEPGoal): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: g.goal_id,
    student_id: g.student_id,
    admin_date: "2026-09-08" as IsoDate,
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

describe("HARD STOP #7 — proposed/baseline goals are unreachable by the IC exporter", () => {
  it("a proposed goal with scored points produces no IC export; only active+baselined goals do", () => {
    const proposed = goal("proposed");
    const active = goal("active");
    const exports = buildIcExport([proposed, active], [scored(proposed), scored(active)]);
    // The proposed goal is filtered out structurally — no code path emits it.
    expect(exports.map((e) => e.goalId)).toEqual([active.goal_id]);
    expect(isIcExportable(proposed)).toBe(false);
  });

  it("a goal missing its baseline is unreachable even when active", () => {
    const noBaseline = goal("active", false);
    expect(isIcExportable(noBaseline)).toBe(false);
    expect(buildIcExport([noBaseline], [scored(noBaseline)])).toEqual([]);
  });
});
