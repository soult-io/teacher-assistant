import {
  asTimestamp,
  type ClassPeriod,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type ProbeDefinition,
  type ProgressDataPoint,
  type Student,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type DecryptedRecords, isEmpty, readRecords, writeRecords } from "./repository.js";

function sampleRecords(): DecryptedRecords {
  const studentId = newOpaqueId();
  const student: Student = {
    student_id: studentId,
    initials: "AB",
    color_token: "--s-ab",
    period_memberships: [],
    active: true,
  };
  const goal: IEPGoal = {
    goal_id: newOpaqueId(),
    student_id: studentId,
    goal_text: "Two-step equations",
    behavior: "solves two-step problems",
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
    status: "active",
    created_ts: asTimestamp(0),
    revisions: [],
  };
  const point: ProgressDataPoint = {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: studentId,
    admin_date: "2026-09-14" as IsoDate,
    entry_ts: asTimestamp(0),
    state: "scored",
    numerator: 4,
    denominator_used: 5,
    computed_value: 0.8,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
  const period: ClassPeriod = {
    period_id: newOpaqueId(),
    label: "P2",
    format: "blended_resource",
    day_template: [],
    has_para: true,
  };
  const probe: ProbeDefinition = {
    probe_definition_id: newOpaqueId(),
    goal_id: goal.goal_id,
    expected_denominator: 5,
    condition: "given a 5-item probe",
    label: "5-item probe",
  };
  return {
    students: [student],
    goals: [goal],
    points: [point],
    periods: [period],
    probes: [probe],
  };
}

describe("doc repository (round-trips entities through the CRDT)", () => {
  it("reports an empty doc before any write", () => {
    expect(isEmpty(new Y.Doc())).toBe(true);
  });

  it("writes and reads back records unchanged, keyed by opaque id", () => {
    const doc = new Y.Doc();
    const seed = sampleRecords();
    doc.transact(() => writeRecords(doc, seed));

    expect(isEmpty(doc)).toBe(false);
    const read = readRecords(doc);
    expect(read.students).toEqual(seed.students);
    expect(read.goals).toEqual(seed.goals);
    expect(read.points).toEqual(seed.points);
    expect(read.periods).toEqual(seed.periods);
    expect(read.probes).toEqual(seed.probes);
  });

  it("survives a Yjs snapshot round-trip (persistence rehydrate path)", () => {
    const source = new Y.Doc();
    const seed = sampleRecords();
    source.transact(() => writeRecords(source, seed));

    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, Y.encodeStateAsUpdate(source));

    const read = readRecords(rebuilt);
    expect(read.goals[0]?.goal_text).toBe("Two-step equations");
    expect(read.students).toHaveLength(1);
    expect(read.points).toHaveLength(1);
  });
});
