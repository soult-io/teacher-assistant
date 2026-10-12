// M10-U6 — PROMPT_TEMPLATES_V1 seed content tests (spec architecture/m10-u6-spec.md).
//
// The five differentiation-udl-sme fill-the-blank prompt templates are seeded as a
// CLEARTEXT reference (same posture as `default_v1` / segment catalog). These tests
// lock the seed's shape and the LOCKED content invariants; the differentiation-udl-sme
// gate is the verbatim authority, so these assert the properties that catch drift
// (ids/titles/support_types, the REQUIRED caution verbatim on all five, blanks
// preserved, and the accommodation-preserves-the-standard wording).
//
// Expected values are transcribed independently from the spec §CONTENT — NOT read
// back from the seed under test.

import { describe, expect, it } from "vitest";
import { MATERIAL_SUPPORT_TYPES, type MaterialSupportType } from "./enums.js";
import { PROMPT_TEMPLATES_V1 } from "./prompt-templates.js";

// The REQUIRED standing caution — identical verbatim on all five (spec §CONTENT).
const STANDING_CAUTION =
  "AI can be wrong about math and about what a student needs — check every problem and every step before you use it.";

// (template_id, title, support_type) transcribed from spec §CONTENT.
const EXPECTED: readonly {
  readonly template_id: string;
  readonly title: string;
  readonly support_type: MaterialSupportType;
}[] = [
  {
    template_id: "step_chunked_worked_example_v1",
    title: "Step-chunked worked example (I DO model)",
    support_type: "step_chunked",
  },
  {
    template_id: "smaller_number_practice_set_v1",
    title: "Smaller-number / adapted practice set (WE DO / YOU DO)",
    support_type: "adapted_practice",
  },
  {
    template_id: "keyword_vocab_support_v1",
    title: "Keyword / vocabulary support (all blocks)",
    support_type: "vocab_keyword",
  },
  {
    template_id: "cra_manipulative_script_v1",
    title: "CRA / manipulative teaching script (concrete → representational → abstract)",
    support_type: "cra_manipulative",
  },
  {
    template_id: "anchor_chart_cue_card_v1",
    title: "Anchor chart / cue card (reference tool)",
    support_type: "visual_scaffold",
  },
];

// A distinctive LOCKED phrase per template — the accommodation-preserves-the-standard
// discipline the differentiation-udl-sme authored (spec §CONTENT), keyed by id.
const LOCKED_PHRASES: Readonly<Record<string, string>> = {
  step_chunked_worked_example_v1: "Do NOT swap in an easier skill.",
  smaller_number_practice_set_v1:
    "The skill being practiced must stay the 8th-grade standard above.",
  keyword_vocab_support_v1: "Do NOT replace an 8th-grade term with a childish substitute",
  cra_manipulative_script_v1:
    "The ABSTRACT stage must land on the actual 8th-grade standard above.",
  anchor_chart_cue_card_v1:
    "it is a REMINDER of the 8th-grade skill, not a shortcut that removes the thinking.",
};

describe("PROMPT_TEMPLATES_V1 (M10-U6) — seed shape", () => {
  it("seeds exactly 5 templates with the authored ids/titles/support_types", () => {
    expect(PROMPT_TEMPLATES_V1).toHaveLength(EXPECTED.length);
    // Key by plain string so the test does not couple to the OpaqueId brand.
    const byId = new Map(PROMPT_TEMPLATES_V1.map((t) => [String(t.template_id), t]));
    for (const want of EXPECTED) {
      const got = byId.get(want.template_id);
      expect(got, `missing template ${want.template_id}`).toBeDefined();
      expect(got?.title).toBe(want.title);
      expect(got?.support_type).toBe(want.support_type);
    }
  });

  it("every support_type is a valid MaterialSupportType", () => {
    for (const t of PROMPT_TEMPLATES_V1) {
      expect(MATERIAL_SUPPORT_TYPES).toContain(t.support_type);
    }
  });
});

describe("PROMPT_TEMPLATES_V1 (M10-U6) — REQUIRED standing caution", () => {
  it("every template carries the caution, verbatim and identical", () => {
    for (const t of PROMPT_TEMPLATES_V1) {
      expect(t.standing_caution, `caution on ${t.template_id}`).toBe(STANDING_CAUTION);
    }
  });
});

describe("PROMPT_TEMPLATES_V1 (M10-U6) — body_text authored content", () => {
  it("preserves the fill-in blanks (___) in every body", () => {
    for (const t of PROMPT_TEMPLATES_V1) {
      expect(t.body_text, `blanks on ${t.template_id}`).toContain("___");
    }
  });

  it("carries the LOCKED accommodation-preserves-the-standard wording per template", () => {
    const byId = new Map(PROMPT_TEMPLATES_V1.map((t) => [String(t.template_id), t]));
    for (const [id, phrase] of Object.entries(LOCKED_PHRASES)) {
      expect(byId.get(id)?.body_text, `locked phrase on ${id}`).toContain(phrase);
    }
  });

  it("is non-empty static text on every template", () => {
    for (const t of PROMPT_TEMPLATES_V1) {
      expect(t.body_text.trim().length, `body on ${t.template_id}`).toBeGreaterThan(0);
    }
  });
});
