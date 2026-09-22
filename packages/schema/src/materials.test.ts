// M10-U1 — Material schema + classification (differentiation toolkit).
//
// Failing-first tests encoding the build spec (architecture/m10-u1-spec.md) and
// the two LOCKED SME rulings it embeds:
//   §A ky-sped-lbd-sdi-sme — AccessBand enum, accom/mod validators, surface-only
//      material_goal_support (no data edge).
//   §B ib-myp-math-sme     — myp_criteria two-way conditional on modified_assessment.
//
// Expected values are derived independently from the spec, never read back from
// the implementation. The FERPA structural assertion (no student field on
// material/material_seed/prompt_template) lives in the ferpa-guard suite
// (tools/ferpa-guard/test/ferpa-m10.test.ts), the static-scan home of that class
// of guard — mirroring the M8b precedent.

import { describe, expect, it } from "vitest";
import {
  ACCESS_BANDS,
  ACCOM_MODS,
  type AccessBand,
  type AccomMod,
  asTimestamp,
  CRA_STAGES,
  isEncryptedRecordType,
  LESSON_BLOCKS,
  type Material,
  type MaterialContent,
  MATERIAL_ORIGINS,
  MATERIAL_SUPPORT_TYPES,
  type MaterialSupportType,
  MYP_CRITERIA,
  type MypCriterion,
  newOpaqueId,
  RECORD_CLASSIFICATION,
  type RecordType,
  UDL_PRINCIPLES,
  validateMaterialConstraints,
} from "./index.js";

// ── A full, valid Material (on_grade / none — the neutral gen-ed artifact) ─────
function validMaterial(over: Partial<Material> = {}): Material {
  const base: Material = {
    material_id: newOpaqueId(),
    title: "8th-grade two-step equations, grade-level reference",
    content: { kind: "text", body: "Solve 2x + 3 = 11." },
    standard_codes: ["KY.8.EE.7"],
    segment_ids: [newOpaqueId()],
    support_types: ["reference_tool"],
    access_band: "on_grade",
    lesson_blocks: ["reference"],
    udl_principles: ["representation"],
    cra_stages: ["abstract"],
    accom_mod: "none",
    origin: "teacher_authored",
    active: true,
    created_ts: asTimestamp(0),
    revisions: [],
  };
  return { ...base, ...over };
}

// ── Test group 1 — enum membership (spec §A/§B vocabularies, locked) ──────────
describe("M10-U1 §1 — enum membership (exact, locked vocabularies)", () => {
  it("AccessBand is the SME-final ladder and REPLACES the placeholder", () => {
    expect([...ACCESS_BANDS]).toEqual([
      "on_grade",
      "grade_level_scaffolded",
      "foundational_bridge",
      "access_foundational",
    ]);
    // The placeholder (on_grade · approaching · access_early_elem) is gone.
    expect(ACCESS_BANDS).not.toContain("approaching");
    expect(ACCESS_BANDS).not.toContain("access_early_elem");
  });

  it("MaterialSupportType is the plan §1 set (11 types)", () => {
    expect([...MATERIAL_SUPPORT_TYPES]).toEqual([
      "worked_example_full",
      "worked_example_faded",
      "guided_notes",
      "graphic_organizer",
      "cra_manipulative",
      "visual_scaffold",
      "vocab_keyword",
      "reference_tool",
      "step_chunked",
      "adapted_practice",
      "modified_assessment",
    ]);
  });

  it("LessonBlock, UdlPrinciple, CraStage, MaterialOrigin match the spec field table", () => {
    expect([...LESSON_BLOCKS]).toEqual(["i_do", "we_do", "you_do", "assessment", "reference"]);
    expect([...UDL_PRINCIPLES]).toEqual(["representation", "action_expression", "engagement"]);
    expect([...CRA_STAGES]).toEqual(["concrete", "representational", "abstract"]);
    expect([...MATERIAL_ORIGINS]).toEqual([
      "teacher_authored",
      "imported_colleague",
      "imported_arc_binder",
      "imported_seed",
      "purchased",
    ]);
  });

  it("reuses the existing ACCOM_MODS and MYP_CRITERIA vocabularies (no fork)", () => {
    expect([...ACCOM_MODS]).toEqual(["accommodation", "modification", "none"]);
    expect([...MYP_CRITERIA]).toEqual(["A", "B", "C", "D"]);
  });
});

// ── Test group 2 — required, no default (type-level) ──────────────────────────
describe("M10-U1 §2 — access_band and accom_mod are REQUIRED (no default)", () => {
  it("omitting access_band or accom_mod is a compile error (type-level guard)", () => {
    const { access_band, accom_mod, ...rest } = validMaterial();
    // Both required fields recovered so the rest is a Material minus exactly one.
    expect(access_band).toBe("on_grade");
    expect(accom_mod).toBe("none");

    // @ts-expect-error — access_band is required; omitting it must not typecheck.
    const missingBand: Material = { ...rest, accom_mod };
    // @ts-expect-error — accom_mod is required; omitting it must not typecheck.
    const missingMod: Material = { ...rest, access_band };
    void missingBand;
    void missingMod;
    expect(rest.material_id).toBeDefined();
  });
});

// ── Test group 3 — accom_mod = none ⟹ access_band = on_grade (§A.3) ────────────
describe("M10-U1 §3 — accom_mod=none valid ONLY at access_band=on_grade", () => {
  it("none + on_grade is valid", () => {
    expect(
      validateMaterialConstraints({
        access_band: "on_grade",
        accom_mod: "none",
        support_types: ["reference_tool"],
      }).map((v) => v.rule),
    ).not.toContain("accom_mod_band");
  });

  it.each<AccessBand>(["grade_level_scaffolded", "foundational_bridge", "access_foundational"])(
    "none at %s is INVALID (cannot adapt and leave the posture unlabeled)",
    (band) => {
      expect(
        validateMaterialConstraints({
          access_band: band,
          accom_mod: "none",
          support_types: ["reference_tool"],
        }).map((v) => v.rule),
      ).toContain("accom_mod_band");
    },
  );

  it.each<AccomMod>(["accommodation", "modification"])(
    "%s at a non-on_grade band is valid",
    (mod) => {
      expect(
        validateMaterialConstraints({
          access_band: "grade_level_scaffolded",
          accom_mod: mod,
          support_types: ["guided_notes"],
        }).map((v) => v.rule),
      ).not.toContain("accom_mod_band");
    },
  );
});

// ── Test group 4 — support ∋ modified_assessment ⟹ accom_mod = modification ────
describe("M10-U1 §4 — modified_assessment forces accom_mod=modification", () => {
  it.each<AccomMod>(["none", "accommodation"])(
    "modified_assessment with accom_mod=%s is INVALID",
    (mod) => {
      const rules = validateMaterialConstraints({
        access_band: "access_foundational",
        accom_mod: mod,
        support_types: ["adapted_practice", "modified_assessment"],
        myp_criteria: ["A"],
      }).map((v) => v.rule);
      expect(rules).toContain("modified_assessment_mod");
    },
  );

  it("modified_assessment with accom_mod=modification is valid", () => {
    const rules = validateMaterialConstraints({
      access_band: "access_foundational",
      accom_mod: "modification",
      support_types: ["modified_assessment"],
      myp_criteria: ["A", "C"],
    }).map((v) => v.rule);
    expect(rules).not.toContain("modified_assessment_mod");
  });
});

// ── Test group 5 — myp_criteria two-way conditional (§B) ───────────────────────
describe("M10-U1 §5 — myp_criteria iff support ∋ modified_assessment", () => {
  it("modified_assessment REQUIRES ≥1 criterion (empty/absent invalid)", () => {
    const absent = validateMaterialConstraints({
      access_band: "access_foundational",
      accom_mod: "modification",
      support_types: ["modified_assessment"],
    }).map((v) => v.rule);
    expect(absent).toContain("myp_criteria_conditional");

    const empty = validateMaterialConstraints({
      access_band: "access_foundational",
      accom_mod: "modification",
      support_types: ["modified_assessment"],
      myp_criteria: [],
    }).map((v) => v.rule);
    expect(empty).toContain("myp_criteria_conditional");
  });

  it("modified_assessment WITH criteria (subset of A–D) is valid", () => {
    const rules = validateMaterialConstraints({
      access_band: "access_foundational",
      accom_mod: "modification",
      support_types: ["modified_assessment"],
      myp_criteria: ["A", "B", "C", "D"],
    }).map((v) => v.rule);
    expect(rules).not.toContain("myp_criteria_conditional");
  });

  it.each<[readonly MypCriterion[]]>([[["A"]], [[]]])(
    "myp_criteria=%j on a non-modified material is INVALID (must be absent, not even empty)",
    (criteria) => {
      const rules = validateMaterialConstraints({
        access_band: "grade_level_scaffolded",
        accom_mod: "accommodation",
        support_types: ["guided_notes", "graphic_organizer"],
        myp_criteria: criteria,
      }).map((v) => v.rule);
      expect(rules).toContain("myp_criteria_conditional");
    },
  );

  it("no criteria on a non-modified material is valid", () => {
    const rules = validateMaterialConstraints({
      access_band: "on_grade",
      accom_mod: "none",
      support_types: ["reference_tool"],
    }).map((v) => v.rule);
    expect(rules).toEqual([]);
  });
});

// ── Test group 7 — storage classification (§classification table) ─────────────
describe("M10-U1 §7 — RECORD_CLASSIFICATION extends with the M10 types", () => {
  const encrypted: readonly RecordType[] = [
    "material",
    "material_asset",
    "material_goal_support",
    "material_student_support",
  ];
  const cleartext: readonly RecordType[] = ["material_seed", "prompt_template"];

  it.each(encrypted)("%s is ENCRYPTED (teacher MK, never a Period DEK / para surface)", (t) => {
    expect(RECORD_CLASSIFICATION[t]).toBe("ENCRYPTED");
    expect(isEncryptedRecordType(t)).toBe(true);
  });

  it.each(cleartext)("%s is CLEARTEXT (SME-curated PII-free reference)", (t) => {
    expect(RECORD_CLASSIFICATION[t]).toBe("CLEARTEXT");
    expect(isEncryptedRecordType(t)).toBe(false);
  });

  it("material_plan_attach is DEFERRED (M10-U8) — NOT defined in U1", () => {
    expect(Object.keys(RECORD_CLASSIFICATION)).not.toContain("material_plan_attach");
  });
});

// ── Test group 8 — MaterialContent union round-trips all three kinds ───────────
describe("M10-U1 §8 — MaterialContent discriminated union (text | link | file)", () => {
  it("text | link | file all construct and discriminate on `kind`", () => {
    const text: MaterialContent = { kind: "text", body: "3 + 4 = ?" };
    const link: MaterialContent = { kind: "link", url: "https://example.org/x", label: "Guide" };
    const file: MaterialContent = {
      kind: "file",
      asset_id: newOpaqueId(),
      filename: "grid.pdf",
      mime: "application/pdf",
      size: 2048,
    };
    for (const c of [text, link, file] as const) {
      switch (c.kind) {
        case "text":
          expect(c.body).toBe("3 + 4 = ?");
          break;
        case "link":
          expect(c.url).toContain("https://");
          break;
        case "file":
          // `file` variant type-checks; no blob channel is exercised (deferred).
          expect(c.mime).toBe("application/pdf");
          break;
      }
    }
  });

  it("a Material accepts each content kind", () => {
    const bands: readonly MaterialSupportType[] = ["visual_scaffold"];
    expect(validMaterial({ content: { kind: "link", url: "https://k.org" } }).content.kind).toBe(
      "link",
    );
    expect(validMaterial({ support_types: bands }).support_types).toEqual(bands);
  });
});
