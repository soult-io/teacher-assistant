// M10-U3 — multi-facet tag query tests (spec architecture/m10-u3-spec.md §Tests 1–8).
// Failing-first: they encode the spec before queryMaterials satisfies it.
//
// Pure query projection over already-decrypted PII-free Material records; no
// store, no crypto. Combination semantics: ACROSS facets = AND, WITHIN a facet =
// OR. Result order is identical to the U2 library projection.

import { type Material, type OpaqueId, asTimestamp, newOpaqueId } from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { buildMaterialLibrary } from "./material-library.js";
import { queryMaterials } from "./material-query.js";

/** A minimal valid active material; overrides set the facet under test. */
function material(overrides: Partial<Material> = {}): Material {
  return {
    material_id: newOpaqueId(),
    title: "material",
    content: { kind: "text", body: "body" },
    standard_codes: ["KY.8.EE.6"],
    segment_ids: [],
    support_types: ["worked_example_full"],
    access_band: "on_grade",
    lesson_blocks: ["i_do"],
    udl_principles: ["representation"],
    cra_stages: ["abstract"],
    accom_mod: "none",
    origin: "teacher_authored",
    active: true,
    created_ts: asTimestamp(1_000),
    revisions: [],
    ...overrides,
  };
}

function ids(materials: readonly Material[]): readonly OpaqueId[] {
  return materials.map((m) => m.material_id);
}

describe("M10-U3 test 1 — single-facet filters each select exactly the matching materials", () => {
  it("standard_codes", () => {
    const hit = material({ standard_codes: ["KY.8.EE.6", "KY.8.F.2"] });
    const miss = material({ standard_codes: ["KY.8.G.9"] });
    expect(ids(queryMaterials([hit, miss], { standard_codes: ["KY.8.EE.6"] }))).toEqual([
      hit.material_id,
    ]);
  });

  it("segment_ids", () => {
    const seg = newOpaqueId();
    const hit = material({ segment_ids: [seg] });
    const miss = material({ segment_ids: [newOpaqueId()] });
    expect(ids(queryMaterials([hit, miss], { segment_ids: [seg] }))).toEqual([hit.material_id]);
  });

  it("support_types", () => {
    const hit = material({ support_types: ["guided_notes"] });
    const miss = material({ support_types: ["worked_example_full"] });
    expect(ids(queryMaterials([hit, miss], { support_types: ["guided_notes"] }))).toEqual([
      hit.material_id,
    ]);
  });

  it("access_band", () => {
    const hit = material({ access_band: "foundational_bridge", accom_mod: "accommodation" });
    const miss = material({ access_band: "on_grade" });
    expect(ids(queryMaterials([hit, miss], { access_band: ["foundational_bridge"] }))).toEqual([
      hit.material_id,
    ]);
  });

  it("lesson_blocks", () => {
    const hit = material({ lesson_blocks: ["assessment"] });
    const miss = material({ lesson_blocks: ["i_do"] });
    expect(ids(queryMaterials([hit, miss], { lesson_blocks: ["assessment"] }))).toEqual([
      hit.material_id,
    ]);
  });

  it("udl_principles", () => {
    const hit = material({ udl_principles: ["engagement"] });
    const miss = material({ udl_principles: ["representation"] });
    expect(ids(queryMaterials([hit, miss], { udl_principles: ["engagement"] }))).toEqual([
      hit.material_id,
    ]);
  });

  it("cra_stages", () => {
    const hit = material({ cra_stages: ["concrete"] });
    const miss = material({ cra_stages: ["abstract"] });
    expect(ids(queryMaterials([hit, miss], { cra_stages: ["concrete"] }))).toEqual([
      hit.material_id,
    ]);
  });

  it("accom_mod", () => {
    const hit = material({ access_band: "foundational_bridge", accom_mod: "accommodation" });
    const miss = material({ access_band: "on_grade", accom_mod: "none" });
    expect(ids(queryMaterials([hit, miss], { accom_mod: ["accommodation"] }))).toEqual([
      hit.material_id,
    ]);
  });

  it("myp_criteria", () => {
    const hit = material({
      support_types: ["modified_assessment"],
      accom_mod: "modification",
      myp_criteria: ["A"],
    });
    const miss = material();
    expect(ids(queryMaterials([hit, miss], { myp_criteria: ["A"] }))).toEqual([hit.material_id]);
  });

  it("origin", () => {
    const hit = material({ origin: "purchased" });
    const miss = material({ origin: "teacher_authored" });
    expect(ids(queryMaterials([hit, miss], { origin: ["purchased"] }))).toEqual([hit.material_id]);
  });
});

describe("M10-U3 test 2 — WITHIN a facet is OR", () => {
  it("support_types [a, b] returns materials with a OR b", () => {
    const a = material({ support_types: ["guided_notes"] });
    const b = material({ support_types: ["graphic_organizer"] });
    const neither = material({ support_types: ["worked_example_full"] });
    const out = queryMaterials([a, b, neither], {
      support_types: ["guided_notes", "graphic_organizer"],
    });
    expect(new Set(ids(out))).toEqual(new Set([a.material_id, b.material_id]));
    expect(out).toHaveLength(2);
  });
});

describe("M10-U3 test 3 — ACROSS facets is AND", () => {
  it("{access_band, support_types} returns only materials matching BOTH", () => {
    const both = material({
      access_band: "foundational_bridge",
      accom_mod: "accommodation",
      support_types: ["guided_notes"],
    });
    const bandOnly = material({
      access_band: "foundational_bridge",
      accom_mod: "accommodation",
      support_types: ["worked_example_full"],
    });
    const supportOnly = material({ access_band: "on_grade", support_types: ["guided_notes"] });
    const out = queryMaterials([both, bandOnly, supportOnly], {
      access_band: ["foundational_bridge"],
      support_types: ["guided_notes"],
    });
    expect(ids(out)).toEqual([both.material_id]);
  });
});

describe("M10-U3 test 4 — text substring match on title, case-insensitive", () => {
  it("matches a case-insensitive substring of the title", () => {
    const hit = material({ title: "Slope-Intercept Worked Example" });
    const miss = material({ title: "Pythagorean theorem notes" });
    expect(ids(queryMaterials([hit, miss], { text: "slope" }))).toEqual([hit.material_id]);
    expect(ids(queryMaterials([hit, miss], { text: "WORKED" }))).toEqual([hit.material_id]);
    expect(queryMaterials([hit, miss], { text: "calculus" })).toEqual([]);
  });
});

describe("M10-U3 test 5 — include_retired", () => {
  it("defaults to false (retired excluded) and includes retired when true", () => {
    const active = material({ active: true });
    const retired = material({ active: false });
    expect(ids(queryMaterials([active, retired], {}))).toEqual([active.material_id]);
    expect(new Set(ids(queryMaterials([active, retired], { include_retired: true })))).toEqual(
      new Set([active.material_id, retired.material_id]),
    );
  });
});

describe("M10-U3 test 6 — empty filter returns all active materials", () => {
  it("equals the U2 default library list", () => {
    const list = [
      material({ created_ts: asTimestamp(1_000) }),
      material({ created_ts: asTimestamp(2_000), active: false }),
      material({ created_ts: asTimestamp(3_000) }),
    ];
    expect(queryMaterials(list, {})).toEqual(buildMaterialLibrary(list));
  });
});

describe("M10-U3 test 7 — stable ordering identical to the U2 projection", () => {
  it("orders newest-first by created_ts, ties by material_id, same as buildMaterialLibrary", () => {
    const ts = asTimestamp(5_000);
    const older = material({ created_ts: asTimestamp(1_000) });
    const newer = material({ created_ts: asTimestamp(9_000) });
    const tieA = material({ material_id: "00000000-aaaa" as OpaqueId, created_ts: ts });
    const tieB = material({ material_id: "ffffffff-bbbb" as OpaqueId, created_ts: ts });
    const list = [tieB, older, newer, tieA];
    expect(ids(queryMaterials(list, {}))).toEqual(ids(buildMaterialLibrary(list)));
    expect(ids(queryMaterials(list, {}))).toEqual([
      newer.material_id,
      tieA.material_id,
      tieB.material_id,
      older.material_id,
    ]);
  });
});

describe("M10-U3 test 8 — purity", () => {
  it("does not mutate or reorder the input array", () => {
    const older = material({ created_ts: asTimestamp(1_000) });
    const newer = material({ created_ts: asTimestamp(2_000) });
    const input: Material[] = [older, newer];
    const snapshot = [...input];
    queryMaterials(input, { support_types: ["worked_example_full"] });
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(older);
  });
});
