// M10-U5 — Goal Detail support surfacing tests (spec architecture/m10-u5-spec.md
// §Tests 7–8). Test 7 is the runtime realization of the U1 §A.4 no-data-edge
// guard: attaching/detaching a support changes NONE of the monitoring outputs.

import {
  asTimestamp,
  type IEPGoal,
  type IsoDate,
  type Material,
  type MaterialGoalSupport,
  newOpaqueId,
  type OpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { computeAutoStatement } from "./auto-statement.js";
import { captureScoredPoint } from "./data-point.js";
import { buildGoalDetail } from "./goal-detail.js";
import { buildGoalDetailWithSupports, buildGoalSupports } from "./goal-supports.js";
import { buildIcExport } from "./ic-export.js";

const iso = (s: string): IsoDate => s as IsoDate;

function makeGoal(over?: Partial<IEPGoal>): IEPGoal {
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "synthetic",
    behavior: "solves two-step equations",
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
    baseline_value: 40,
    baseline_source: "eval",
    ...over,
  };
}

function scored(goal: IEPGoal, adminDate: string, numerator: number): ProgressDataPoint {
  return captureScoredPoint({
    goalId: goal.goal_id,
    studentId: goal.student_id,
    adminDate: iso(adminDate),
    entryTs: asTimestamp(0),
    numerator,
    denominatorUsed: 10,
    setting: "math_resource",
    scorer: "teacher",
  });
}

/** A PII-free material fixture (no student/goal field by construction — U1). */
function makeMaterial(over?: Partial<Material>): Material {
  return {
    material_id: newOpaqueId(),
    title: "Fraction tiles",
    content: { kind: "text", body: "manipulative reference" },
    standard_codes: ["KY.8.EE.6"],
    segment_ids: [newOpaqueId()],
    support_types: ["cra_manipulative"],
    access_band: "foundational_bridge",
    lesson_blocks: ["we_do"],
    udl_principles: ["representation"],
    cra_stages: ["concrete"],
    accom_mod: "accommodation",
    origin: "teacher_authored",
    active: true,
    created_ts: asTimestamp(100),
    revisions: [],
    ...over,
  };
}

function goalLink(
  material: Material,
  goalId: OpaqueId,
  accomMod: MaterialGoalSupport["accom_mod"],
): MaterialGoalSupport {
  return {
    support_id: newOpaqueId(),
    material_id: material.material_id,
    goal_id: goalId,
    accom_mod: accomMod,
  };
}

describe("M10-U5 test 7 — surface-only: no data edge from an attach/detach", () => {
  it("monitoring outputs are byte-identical whether or not a support is attached", () => {
    const goal = makeGoal();
    const points = [
      scored(goal, "2026-09-01", 6),
      scored(goal, "2026-09-08", 9),
      scored(goal, "2026-09-15", 9),
    ];

    // The monitoring core (buildGoalDetail) does not even RECEIVE supports — it is
    // structurally incapable of a data edge. Snapshot the monitoring outputs.
    const noBreaks = { isNonInstructional: () => false };
    const detailBefore = JSON.stringify(buildGoalDetail(goal, points));
    const icBefore = JSON.stringify(buildIcExport([goal], points));
    const statementBefore = JSON.stringify(computeAutoStatement(goal, "AB", points, noBreaks));

    // Attach a support, then detach it (simulate the full lifecycle around the goal).
    const material = makeMaterial();
    const link = goalLink(material, goal.goal_id, "accommodation");
    const withSupport = buildGoalDetailWithSupports(goal, points, [link], [material]);
    expect(withSupport.supports).toHaveLength(1);

    const detached = buildGoalDetailWithSupports(goal, points, [], [material]);
    expect(detached.supports).toHaveLength(0);

    // The monitoring outputs are byte-identical before, during, and after.
    expect(JSON.stringify(buildGoalDetail(goal, points))).toBe(detailBefore);
    expect(JSON.stringify(buildIcExport([goal], points))).toBe(icBefore);
    expect(JSON.stringify(computeAutoStatement(goal, "AB", points, noBreaks))).toBe(
      statementBefore,
    );

    // And the extended projection's own monitoring fields equal the core's — the
    // supports live in a strictly additive field that touches nothing else.
    const { supports: _s, ...monitoringWith } = withSupport;
    expect(JSON.stringify(monitoringWith)).toBe(detailBefore);
  });
});

describe("M10-U5 test 8 — Goal Detail lists attached materials + link accom_mod (pure read)", () => {
  it("lists supports for the goal with the link's operative accom_mod", () => {
    const goalId = newOpaqueId();
    const m1 = makeMaterial({ title: "Tiles", created_ts: asTimestamp(200) });
    const m2 = makeMaterial({ title: "Grid", created_ts: asTimestamp(100) });
    const links = [goalLink(m1, goalId, "accommodation"), goalLink(m2, goalId, "modification")];

    const supports = buildGoalSupports(goalId, links, [m1, m2]);
    expect(supports).toHaveLength(2);
    // The operative, compliance-bearing label is the LINK's accom_mod, not the
    // material's advisory default.
    const byId = new Map(supports.map((s) => [s.material.material_id, s.accom_mod]));
    expect(byId.get(m1.material_id)).toBe("accommodation");
    expect(byId.get(m2.material_id)).toBe("modification");
    // Stable order (newest material first by created_ts): m1 (200) before m2 (100).
    expect(supports[0]?.material.material_id).toBe(m1.material_id);
    expect(supports[1]?.material.material_id).toBe(m2.material_id);
  });

  it("excludes links for other goals", () => {
    const goalId = newOpaqueId();
    const otherGoal = newOpaqueId();
    const m1 = makeMaterial();
    const m2 = makeMaterial();
    const links = [goalLink(m1, goalId, "accommodation"), goalLink(m2, otherGoal, "modification")];

    const supports = buildGoalSupports(goalId, links, [m1, m2]);
    expect(supports).toHaveLength(1);
    expect(supports[0]?.material.material_id).toBe(m1.material_id);
  });

  it("excludes retired materials (and materials the caller did not supply)", () => {
    const goalId = newOpaqueId();
    const active = makeMaterial();
    const retired = makeMaterial({ active: false });
    const ghost = makeMaterial();
    const links = [
      goalLink(active, goalId, "accommodation"),
      goalLink(retired, goalId, "modification"),
      goalLink(ghost, goalId, "accommodation"),
    ];

    // `ghost` is not in the supplied materials list — it drops out too.
    const supports = buildGoalSupports(goalId, links, [active, retired]);
    expect(supports).toHaveLength(1);
    expect(supports[0]?.material.material_id).toBe(active.material_id);
  });

  it("is a pure read — it does not mutate the inputs", () => {
    const goalId = newOpaqueId();
    const m1 = makeMaterial();
    const links = [goalLink(m1, goalId, "accommodation")];
    const linksSnapshot = JSON.stringify(links);
    const materialsSnapshot = JSON.stringify([m1]);

    buildGoalSupports(goalId, links, [m1]);

    expect(JSON.stringify(links)).toBe(linksSnapshot);
    expect(JSON.stringify([m1])).toBe(materialsSnapshot);
  });
});
