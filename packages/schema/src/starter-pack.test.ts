// M10-U7 — STARTER_PACK seed catalog tests (spec architecture/m10-u7-spec.md §Test 4).
//
// STARTER_PACK is a CLEARTEXT, PII-free reference catalog of `material_seed`
// records — the same posture as `default_v1` / PROMPT_TEMPLATES_V1 / the segment
// catalog, served by content-api at M11 (a 501 scaffold until then). The ENGINE
// PR shipped the catalog EMPTY; curated content lands as SME-authored data PRs,
// each with a FERPA PII-free scan. This file now also locks CONTENT TRANCHE 1
// (architecture/starter-pack-tranche1.md): 16 records across KY.8.NS.1 /
// KY.8.NS.2 / KY.8.EE.1 / KY.8.EE.4, four per standard.

import { describe, expect, it } from "vitest";
import { RECORD_CLASSIFICATION } from "./classification.js";
import type { OpaqueId } from "./ids.js";
import type { MaterialSeed } from "./materials.js";
import { STARTER_PACK_V1 } from "./starter-pack.js";

// The four KY power standards seeded in tranche 1, each with four records.
const TRANCHE1_STANDARDS = ["KY.8.NS.1", "KY.8.NS.2", "KY.8.EE.1", "KY.8.EE.4"] as const;

// Keys a PII-free reference record must NEVER carry (FERPA / data-model §10.2).
// A `material_seed` is student-agnostic BY CONSTRUCTION; this guards the curated
// content against a student-coupling leak. Extends the engine-PR list with the
// per-tranche student-identifying keys called out by the content gate.
const FORBIDDEN_STUDENT_KEYS = [
  "student_id",
  "student_ids",
  "student",
  "students",
  "initials",
  "goal_id",
  "goal_ids",
  "period",
  "name",
] as const;

// The four support categories every standard's four records must span (one each).
type SupportCategory = "vocab" | "anchor" | "cra" | "worked";
function supportCategory(seed: MaterialSeed): SupportCategory | "other" {
  const s = new Set<string>(seed.support_types);
  if (s.has("vocab_keyword")) return "vocab";
  if (s.has("cra_manipulative")) return "cra";
  if (s.has("worked_example_full")) return "worked";
  if (s.has("visual_scaffold") || s.has("reference_tool")) return "anchor";
  return "other";
}

// Every object key that appears anywhere in a value (deep), for the PII scan.
function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const el of value) collectKeys(el, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
}

describe("STARTER_PACK_V1 (M10-U7) — catalog container", () => {
  it("loads as an array", () => {
    expect(Array.isArray(STARTER_PACK_V1)).toBe(true);
  });

  it("classifies material_seed CLEARTEXT (content-api reference, not student-linked)", () => {
    expect(RECORD_CLASSIFICATION.material_seed).toBe("CLEARTEXT");
  });
});

describe("STARTER_PACK_V1 (M10-U7) — content tranche 1 (NS1, NS2, EE1, EE4)", () => {
  it("ships exactly 16 records", () => {
    expect(STARTER_PACK_V1).toHaveLength(16);
  });

  it("has exactly 4 records per KY power standard", () => {
    for (const standard of TRANCHE1_STANDARDS) {
      const forStandard = STARTER_PACK_V1.filter((s) => s.standard_codes.includes(standard));
      expect(forStandard, standard).toHaveLength(4);
    }
    // No stray records outside the four seeded standards.
    const covered = STARTER_PACK_V1.filter((s) =>
      s.standard_codes.some((c) => (TRANCHE1_STANDARDS as readonly string[]).includes(c)),
    );
    expect(covered).toHaveLength(16);
  });

  it("each standard spans all four support categories (vocab, anchor, cra, worked), one each", () => {
    for (const standard of TRANCHE1_STANDARDS) {
      const categories = STARTER_PACK_V1.filter((s) => s.standard_codes.includes(standard)).map(
        supportCategory,
      );
      expect([...categories].sort(), standard).toEqual(["anchor", "cra", "vocab", "worked"]);
    }
  });

  it("every record is access_band grade_level_scaffolded", () => {
    for (const seed of STARTER_PACK_V1) {
      expect(seed.access_band, String(seed.seed_id)).toBe("grade_level_scaffolded");
    }
  });

  it("no record carries myp_criteria (none is a modified_assessment)", () => {
    for (const seed of STARTER_PACK_V1) {
      expect(Object.hasOwn(seed, "myp_criteria"), String(seed.seed_id)).toBe(false);
    }
  });

  it("every seed_id is unique", () => {
    const ids = STARTER_PACK_V1.map((s) => String(s.seed_id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(16);
  });

  it("every record's content.kind is text", () => {
    for (const seed of STARTER_PACK_V1) {
      expect(seed.content.kind, String(seed.seed_id)).toBe("text");
    }
  });
});

describe("STARTER_PACK_V1 (M10-U7) — FERPA structural (no student field on a seed)", () => {
  // A representative fully-tagged seed, built here (not read from the catalog) to
  // assert the TYPE cannot carry a student field.
  const representative: MaterialSeed = {
    seed_id: "__fixture__representative" as OpaqueId,
    title: "Keyword card — linear equations",
    content: { kind: "text", body: "slope, intercept, variable — plain-language cards" },
    standard_codes: ["KY.8.EE.6"],
    segment_ids: ["seg-1" as OpaqueId],
    support_types: ["vocab_keyword"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference"],
    udl_principles: ["representation"],
    cra_stages: ["abstract"],
  };

  it("a representative seed carries none of the forbidden student keys", () => {
    for (const key of FORBIDDEN_STUDENT_KEYS) {
      expect(Object.hasOwn(representative, key)).toBe(false);
    }
  });

  it("no shipped catalog entry carries a forbidden student key (top level)", () => {
    for (const seed of STARTER_PACK_V1) {
      for (const key of FORBIDDEN_STUDENT_KEYS) {
        expect(Object.hasOwn(seed, key), `${String(seed.seed_id)}.${key}`).toBe(false);
      }
    }
  });

  it("per-tranche PII guard: no forbidden student key anywhere in a record (deep scan)", () => {
    for (const seed of STARTER_PACK_V1) {
      const keys = new Set<string>();
      collectKeys(seed, keys);
      for (const forbidden of FORBIDDEN_STUDENT_KEYS) {
        expect(keys.has(forbidden), `${String(seed.seed_id)} deep key ${forbidden}`).toBe(false);
      }
    }
  });
});
