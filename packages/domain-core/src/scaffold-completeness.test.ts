// M10-U4 — scaffold-completeness (gap) projection tests (spec §Tests 1–9).
// Failing-first: they encode the spec + the LOCKED differentiation-udl-sme
// default_v1 rubric before buildScaffoldCompleteness satisfies them.
//
// Pure projection over already-decrypted PII-free Material records: score the set
// matching a target against a CompletenessTemplate → covered/gaps. Uniform rule:
// found = count(materials where material[facet] ∩ any_of ≠ ∅); covered iff
// found >= min_count. Expected values are derived by hand from the spec, never
// read back from the engine.

import {
  COMPLETENESS_TEMPLATES_V1,
  type CompletenessTemplate,
  DEFAULT_COMPLETENESS_TEMPLATE_V1,
  type Material,
  type MaterialGoalSupport,
  type OpaqueId,
  RECORD_CLASSIFICATION,
  asTimestamp,
  newOpaqueId,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  type CompletenessFacetResult,
  type CompletenessTarget,
  buildScaffoldCompleteness,
  resolveCompletenessTemplate,
} from "./scaffold-completeness.js";

const STD = "S1";

/** A blank active material tagged to STD: EMPTY facet arrays + a non-foundational
 *  band, so by default it covers NOTHING in default_v1. Overrides set the facets
 *  under test. */
function material(overrides: Partial<Material> = {}): Material {
  return {
    material_id: newOpaqueId(),
    title: "m",
    content: { kind: "text", body: "b" },
    standard_codes: [STD],
    segment_ids: [],
    support_types: [],
    access_band: "on_grade",
    lesson_blocks: [],
    udl_principles: [],
    cra_stages: [],
    accom_mod: "none",
    origin: "teacher_authored",
    active: true,
    created_ts: asTimestamp(1_000),
    revisions: [],
    ...overrides,
  };
}

function link(material_id: OpaqueId, goal_id: OpaqueId): MaterialGoalSupport {
  return { support_id: newOpaqueId(), material_id, goal_id, accom_mod: "none" };
}

const stdTarget: CompletenessTarget = { standard_code: STD };

function build(
  materials: readonly Material[],
  target: CompletenessTarget = stdTarget,
  links: readonly MaterialGoalSupport[] = [],
) {
  return buildScaffoldCompleteness({
    target,
    materials,
    links,
    template: DEFAULT_COMPLETENESS_TEMPLATE_V1,
  });
}

const idset = (fs: readonly CompletenessFacetResult[]) => new Set(fs.map((f) => f.requirement_id));
const idlist = (fs: readonly CompletenessFacetResult[]) => fs.map((f) => f.requirement_id);

// The 14 requirement ids of default_v1, in (priority asc, requirement) order.
const ALL_REQUIREMENTS = [
  "access_foundational_present",
  "cra_concrete",
  "cra_representational",
  "cra_abstract",
  "st_keyword",
  "st_anchor_symbol",
  "st_worked_example",
  "st_cra_support",
  "udl_representation",
  "udl_action_expression",
  "udl_engagement",
  "block_i_do",
  "block_we_do",
  "block_you_do",
] as const;

describe("M10-U4 test 1 — {standard_code} target: covered/gaps per the uniform rule", () => {
  it("scores each requirement over the standard-matched set; other standards excluded", () => {
    const a = material({ access_band: "foundational_bridge" }); // access_foundational_present
    const b = material({ cra_stages: ["concrete", "abstract"] }); // cra_concrete, cra_abstract
    const c = material({ support_types: ["vocab_keyword", "cra_manipulative"] }); // st_keyword, st_cra_support
    const d = material({ udl_principles: ["engagement"] }); // udl_engagement
    const e = material({ lesson_blocks: ["we_do"] }); // block_we_do
    // Fully-loaded material on ANOTHER standard — must NOT count toward STD.
    const other = material({
      standard_codes: ["OTHER"],
      access_band: "access_foundational",
      cra_stages: ["representational"],
      support_types: ["visual_scaffold", "worked_example_full"],
      udl_principles: ["representation", "action_expression"],
      lesson_blocks: ["i_do", "you_do"],
    });

    const res = build([a, b, c, d, e, other]);

    expect(idset(res.covered)).toEqual(
      new Set([
        "access_foundational_present",
        "cra_concrete",
        "cra_abstract",
        "st_keyword",
        "st_cra_support",
        "udl_engagement",
        "block_we_do",
      ]),
    );
    expect(idset(res.gaps)).toEqual(
      new Set([
        "cra_representational",
        "st_anchor_symbol",
        "st_worked_example",
        "udl_representation",
        "udl_action_expression",
        "block_i_do",
        "block_you_do",
      ]),
    );
    const access = res.covered.find((f) => f.requirement_id === "access_foundational_present");
    expect(access).toMatchObject({
      required_count: 1,
      found_count: 1,
      priority: 1,
      status: "covered",
    });
  });
});

describe("M10-U4 test 2 — {goal_id} target: only linked, active, distinct materials", () => {
  it("scores linked+active materials, dedupes double links, excludes unlinked/inactive", () => {
    const g1 = newOpaqueId();
    const linked = material({ cra_stages: ["concrete"] }); // covers cra_concrete
    const linkedInactive = material({ active: false, lesson_blocks: ["i_do"] }); // block_i_do — excluded
    const unlinked = material({ udl_principles: ["engagement"] }); // udl_engagement — excluded

    const res = buildScaffoldCompleteness({
      target: { goal_id: g1 },
      materials: [linked, linkedInactive, unlinked],
      // linkedInactive is linked but inactive; `linked` is linked TWICE (distinct dedupe).
      links: [
        link(linked.material_id, g1),
        link(linked.material_id, g1),
        link(linkedInactive.material_id, g1),
      ],
      template: DEFAULT_COMPLETENESS_TEMPLATE_V1,
    });

    expect(idset(res.covered)).toEqual(new Set(["cra_concrete"]));
    // distinct: two link rows to the same material still count as one.
    expect(res.covered.find((f) => f.requirement_id === "cra_concrete")?.found_count).toBe(1);
    // unlinked + inactive contributions never appear.
    expect(idset(res.gaps).has("udl_engagement")).toBe(true);
    expect(idset(res.gaps).has("block_i_do")).toBe(true);
  });
});

describe("M10-U4 test 3 — each of the 5 dimensions: a present (covered) and absent (gap) case", () => {
  const cases: ReadonlyArray<readonly [string, Partial<Material>]> = [
    ["access_foundational_present", { access_band: "access_foundational" }],
    ["cra_concrete", { cra_stages: ["concrete"] }],
    ["st_keyword", { support_types: ["vocab_keyword"] }],
    ["udl_representation", { udl_principles: ["representation"] }],
    ["block_i_do", { lesson_blocks: ["i_do"] }],
  ];
  it.each(cases)("%s present → covered, absent → gap", (reqId, present) => {
    const withMat = build([material(present)]);
    expect(idset(withMat.covered).has(reqId)).toBe(true);

    const withoutMat = build([material()]);
    expect(idset(withoutMat.gaps).has(reqId)).toBe(true);
  });
});

describe("M10-U4 test 4 — zero-match target → every requirement a gap", () => {
  it("empty set makes all 14 requirements gaps and covered empty", () => {
    const res = build([]);
    expect(res.covered).toEqual([]);
    expect(res.gaps.length).toBe(ALL_REQUIREMENTS.length);
    expect(idset(res.gaps)).toEqual(new Set(ALL_REQUIREMENTS));
  });
});

describe("M10-U4 test 5 — ordering: gaps by priority asc then requirement order; covered stable", () => {
  it("surfaces access_reach + cra gaps first, both lists in template order", () => {
    // Cover everything EXCEPT access_foundational_present (p1), cra_representational (p2),
    // block_you_do (p5). Band stays on_grade so access_reach is a gap.
    const kitchenSink = material({
      cra_stages: ["concrete", "abstract"],
      support_types: [
        "vocab_keyword",
        "visual_scaffold",
        "worked_example_full",
        "cra_manipulative",
      ],
      udl_principles: ["representation", "action_expression", "engagement"],
      lesson_blocks: ["i_do", "we_do"],
    });
    const res = build([kitchenSink]);

    expect(idlist(res.gaps)).toEqual([
      "access_foundational_present",
      "cra_representational",
      "block_you_do",
    ]);
    // priorities non-decreasing.
    const ps = res.gaps.map((g) => g.priority);
    expect(ps).toEqual([...ps].sort((x, y) => x - y));
    // covered is the remaining requirements, in the same template order.
    expect(idlist(res.covered)).toEqual([
      "cra_concrete",
      "cra_abstract",
      "st_keyword",
      "st_anchor_symbol",
      "st_worked_example",
      "st_cra_support",
      "udl_representation",
      "udl_action_expression",
      "udl_engagement",
      "block_i_do",
      "block_we_do",
    ]);
  });
});

describe("M10-U4 test 6 — any_of OR semantics: any one listed value covers the requirement", () => {
  it("st_anchor_symbol [visual_scaffold, reference_tool] covered by either alone", () => {
    expect(
      idset(build([material({ support_types: ["reference_tool"] })]).covered).has(
        "st_anchor_symbol",
      ),
    ).toBe(true);
    expect(
      idset(build([material({ support_types: ["visual_scaffold"] })]).covered).has(
        "st_anchor_symbol",
      ),
    ).toBe(true);
    // st_worked_example [worked_example_full, worked_example_faded] — faded alone covers.
    expect(
      idset(build([material({ support_types: ["worked_example_faded"] })]).covered).has(
        "st_worked_example",
      ),
    ).toBe(true);
  });
});

describe("M10-U4 test 7 — template resolution: per-standard replaces default wholesale", () => {
  const custom: CompletenessTemplate = {
    template_id: "S1_v1",
    version: "v1",
    applies_to: [STD],
    dimensions: [
      {
        dimension_id: "custom_dim",
        label: "Custom",
        priority: 1,
        requirements: [
          {
            requirement_id: "only_req",
            label: "Only requirement",
            match: { facet: "cra_stages", any_of: ["concrete"] },
            min_count: 1,
          },
        ],
      },
    ],
  };
  const templates = [DEFAULT_COMPLETENESS_TEMPLATE_V1, custom];

  it("a per-standard applies_to wins for that code; unknown code falls back to default", () => {
    expect(resolveCompletenessTemplate(templates, { standard_code: STD })).toBe(custom);
    expect(resolveCompletenessTemplate(templates, { standard_code: "UNKNOWN" })).toBe(
      DEFAULT_COMPLETENESS_TEMPLATE_V1,
    );
  });

  it("goal target resolves via its KY standard when supplied, else default", () => {
    const g = newOpaqueId();
    expect(
      resolveCompletenessTemplate(templates, { goal_id: g }, { standardCodeForGoal: STD }),
    ).toBe(custom);
    expect(resolveCompletenessTemplate(templates, { goal_id: g })).toBe(
      DEFAULT_COMPLETENESS_TEMPLATE_V1,
    );
  });

  it("wholesale replace — the chosen template's requirements are the ONLY ones scored", () => {
    const res = buildScaffoldCompleteness({
      target: stdTarget,
      materials: [material({ cra_stages: ["concrete"] })],
      links: [],
      template: custom,
    });
    expect([...idset(res.covered), ...idset(res.gaps)]).toEqual(["only_req"]);
  });
});

describe("M10-U4 test 8 — purity: no input mutation, deterministic", () => {
  it("frozen inputs do not throw and are not reordered; repeated calls are equal", () => {
    const a = Object.freeze(material({ created_ts: asTimestamp(1) }));
    const b = Object.freeze(material({ created_ts: asTimestamp(2), cra_stages: ["concrete"] }));
    const materials = Object.freeze([a, b]);
    const links = Object.freeze([]);

    const r1 = buildScaffoldCompleteness({
      target: stdTarget,
      materials,
      links,
      template: DEFAULT_COMPLETENESS_TEMPLATE_V1,
    });
    const r2 = buildScaffoldCompleteness({
      target: stdTarget,
      materials,
      links,
      template: DEFAULT_COMPLETENESS_TEMPLATE_V1,
    });

    expect(materials).toEqual([a, b]); // order untouched
    expect(r1).toEqual(r2); // deterministic
  });
});

describe("M10-U4 test 9 — no student data on output; template type has no student field (FERPA)", () => {
  const ALLOWED_KEYS = [
    "dimension_id",
    "dimension_label",
    "requirement_id",
    "requirement_label",
    "facet",
    "any_of",
    "required_count",
    "found_count",
    "priority",
    "status",
  ].sort();

  it("every output facet has exactly the fixed config/count keys — no id/title/initials/score", () => {
    const res = build([material({ access_band: "foundational_bridge" })]);
    for (const f of [...res.covered, ...res.gaps]) {
      expect(Object.keys(f).sort()).toEqual(ALLOWED_KEYS);
    }
  });

  it("CompletenessTemplate graph carries no student-shaped key", () => {
    const json = JSON.stringify(COMPLETENESS_TEMPLATES_V1);
    expect(json).not.toMatch(/student|initials|goal_id/i);
  });

  it("completeness_template is classified CLEARTEXT (PII-free reference)", () => {
    expect(RECORD_CLASSIFICATION.completeness_template).toBe("CLEARTEXT");
  });
});
