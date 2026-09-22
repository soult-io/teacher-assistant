// M10-U2 — material library-list projection tests (spec §Tests 6–7).
// Pure projection over already-decrypted Material records; no store, no crypto.

import { type Material, asTimestamp, newOpaqueId } from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { buildMaterialLibrary } from "./material-library.js";

/** A minimal valid active material at a given created_ts (facets present for U3 filtering). */
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

describe("M10-U2 test 7 — library list: active-only, stable order, facets attached, pure", () => {
  it("returns only active materials", () => {
    const activeA = material({ active: true });
    const retired = material({ active: false });
    const activeB = material({ active: true });
    const list = buildMaterialLibrary([activeA, retired, activeB]);
    expect(list.map((m) => m.material_id)).toEqual(
      expect.arrayContaining([activeA.material_id, activeB.material_id]),
    );
    expect(list).toHaveLength(2);
    expect(list.some((m) => m.material_id === retired.material_id)).toBe(false);
  });

  it("orders newest-first by created_ts, tie-broken by material_id (deterministic)", () => {
    const older = material({ created_ts: asTimestamp(1_000) });
    const newer = material({ created_ts: asTimestamp(3_000) });
    const mid = material({ created_ts: asTimestamp(2_000) });
    const list = buildMaterialLibrary([older, newer, mid]);
    expect(list.map((m) => m.created_ts)).toEqual([
      asTimestamp(3_000),
      asTimestamp(2_000),
      asTimestamp(1_000),
    ]);
  });

  it("breaks created_ts ties by material_id in code-point order", () => {
    const ts = asTimestamp(5_000);
    const a = material({ material_id: "00000000-aaaa" as Material["material_id"], created_ts: ts });
    const b = material({ material_id: "ffffffff-bbbb" as Material["material_id"], created_ts: ts });
    const list = buildMaterialLibrary([b, a]);
    expect(list.map((m) => m.material_id)).toEqual([a.material_id, b.material_id]);
  });

  it("carries each material's facets through (so U3 can filter without a store change)", () => {
    const m = material({
      support_types: ["guided_notes", "graphic_organizer"],
      access_band: "foundational_bridge",
      accom_mod: "accommodation",
    });
    const [entry] = buildMaterialLibrary([m]);
    expect(entry?.support_types).toEqual(["guided_notes", "graphic_organizer"]);
    expect(entry?.access_band).toBe("foundational_bridge");
    expect(entry?.accom_mod).toBe("accommodation");
    expect(entry?.standard_codes).toEqual(["KY.8.EE.6"]);
  });

  it("is pure — does not mutate or reorder the input array", () => {
    const older = material({ created_ts: asTimestamp(1_000) });
    const newer = material({ created_ts: asTimestamp(2_000) });
    const input: Material[] = [older, newer];
    const snapshot = [...input];
    buildMaterialLibrary(input);
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(older);
  });

  it("returns an empty list for no materials or all-retired materials", () => {
    expect(buildMaterialLibrary([])).toEqual([]);
    expect(buildMaterialLibrary([material({ active: false })])).toEqual([]);
  });
});
