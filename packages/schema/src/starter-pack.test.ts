// M10-U7 — STARTER_PACK seed catalog tests (spec architecture/m10-u7-spec.md §Test 4).
// Failing-first: they encode the spec before `STARTER_PACK_V1` exists.
//
// STARTER_PACK is a CLEARTEXT, PII-free reference catalog of `material_seed`
// records — the same posture as `default_v1` / PROMPT_TEMPLATES_V1 / the segment
// catalog, served by content-api at M11 (a 501 scaffold until then). The ENGINE
// PR ships the catalog EMPTY: the 13-standard curated content is SME-authored and
// lands later as data PRs. These tests lock the container's shape and the FERPA
// structural invariant (no student field on a seed), NOT any curated content.

import { describe, expect, it } from "vitest";
import { RECORD_CLASSIFICATION } from "./classification.js";
import type { OpaqueId } from "./ids.js";
import type { MaterialSeed } from "./materials.js";
import { STARTER_PACK_V1 } from "./starter-pack.js";

// Keys a PII-free reference record must NEVER carry (FERPA / data-model §10.2).
// A `material_seed` is student-agnostic BY CONSTRUCTION; this guards future
// curated content against a student-coupling leak.
const FORBIDDEN_STUDENT_KEYS = [
  "student_id",
  "student_ids",
  "student",
  "students",
  "initials",
  "goal_id",
  "goal_ids",
] as const;

describe("STARTER_PACK_V1 (M10-U7) — catalog container", () => {
  it("loads as an array (ships EMPTY / __fixture__ only in the engine PR)", () => {
    expect(Array.isArray(STARTER_PACK_V1)).toBe(true);
    // The engine PR carries no curated content — an empty catalog, or clearly
    // labeled `__fixture__` entries only. The real 13-standard pack lands as data PRs.
    for (const seed of STARTER_PACK_V1) {
      expect(String(seed.seed_id).startsWith("__fixture__")).toBe(true);
    }
  });

  it("classifies material_seed CLEARTEXT (content-api reference, not student-linked)", () => {
    expect(RECORD_CLASSIFICATION.material_seed).toBe("CLEARTEXT");
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

  it("no shipped catalog entry carries a forbidden student key", () => {
    for (const seed of STARTER_PACK_V1) {
      for (const key of FORBIDDEN_STUDENT_KEYS) {
        expect(Object.hasOwn(seed, key), `${String(seed.seed_id)}.${key}`).toBe(false);
      }
    }
  });
});
