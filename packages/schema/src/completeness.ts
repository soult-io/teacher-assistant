// M10-U4 — scaffold-completeness template (CLEARTEXT content-api reference).
//
// The rubric config the gap projection (`buildScaffoldCompleteness`, domain-core)
// scores a material set against. It names the REQUIRED coverage CATEGORIES — a
// facet plus the tag values that satisfy it — and NOTHING student-facing: no
// student_id / initials / goal_id, no free-text material, no title, rank, or
// generated content BY CONSTRUCTION. All pedagogy lives in this config so the
// engine stays trivial (one uniform count rule).
//
// Classified CLEARTEXT, PII-free reference — the same posture the `material_seed`
// type and the segment catalog carry. The content-api endpoint that serves this
// template library to the PWA lands with M11 (content-api is a 501 scaffold today,
// and no segment-catalog / material_seed DATA instance is materialized yet
// either); until then the canonical `default_v1` instance is exported here as the
// reference payload. NO student field.

/**
 * The five `Material` tag facets a completeness requirement may test. Closed set
 * (the engine switches on it exhaustively); four are multi-valued tag arrays and
 * `access_band` is the material's single pitch band, tested as a singleton.
 */
export type CompletenessFacet =
  | "cra_stages"
  | "udl_principles"
  | "support_types"
  | "lesson_blocks"
  | "access_band";

/**
 * A facet test: the requirement is met by a material whose value(s) for `facet`
 * intersect `any_of` (OR within the list). `any_of` is a plain string list — the
 * values are facet enum members, kept as `string` so the engine's count rule is
 * uniform across every facet and a per-standard override needs no new type.
 */
export interface FacetMatch {
  readonly facet: CompletenessFacet;
  readonly any_of: readonly string[];
}

/**
 * One coverage requirement inside a dimension. `min_count` is how many DISTINCT
 * matching materials the set must contain to count as covered; omitted = 1.
 */
export interface CompletenessRequirement {
  readonly requirement_id: string;
  readonly label: string;
  readonly match: FacetMatch;
  /** DISTINCT matching materials needed to cover. Default 1 when omitted. */
  readonly min_count?: number;
}

/**
 * A named coverage dimension. `priority` orders gap surfacing (lower first); it
 * is the only ranking input and ranks CATEGORIES, never materials.
 */
export interface CompletenessDimension {
  readonly dimension_id: string;
  readonly label: string;
  readonly priority: number;
  readonly requirements: readonly CompletenessRequirement[];
}

/**
 * A completeness rubric. `applies_to` is `"*"` (the default for all standards) or
 * a list of KY standard codes this template overrides the default for. Resolution
 * is a wholesale lookup — a per-standard template REPLACES the default, never
 * merges (see `resolveCompletenessTemplate`). PII-FREE: no student field.
 */
export interface CompletenessTemplate {
  readonly template_id: string;
  readonly version: string;
  readonly applies_to: "*" | readonly string[];
  readonly dimensions: readonly CompletenessDimension[];
}

/**
 * `default_v1` — the LOCKED differentiation-udl-sme completeness floor, for all 13
 * power standards (`applies_to:"*"`). Five dimensions in priority order; every
 * requirement `min_count:1`. Deliberate v1 exclusions (do NOT add to the floor):
 * `lesson_blocks` assessment/reference, and `accom_mod` (a per-material required
 * label, never a coverage target). `ky-sped-lbd-sdi-sme` owns tightening the
 * `access_reach` band set later; the dimension is isolated so only `any_of`
 * changes, never the engine.
 */
export const DEFAULT_COMPLETENESS_TEMPLATE_V1: CompletenessTemplate = {
  template_id: "default_v1",
  version: "v1",
  applies_to: "*",
  dimensions: [
    {
      dimension_id: "access_reach",
      label: "Foundational access reach",
      priority: 1,
      requirements: [
        {
          requirement_id: "access_foundational_present",
          label: "A foundational-access material is present",
          match: { facet: "access_band", any_of: ["foundational_bridge", "access_foundational"] },
          min_count: 1,
        },
      ],
    },
    {
      dimension_id: "cra_ladder",
      label: "CRA ladder",
      priority: 2,
      requirements: [
        {
          requirement_id: "cra_concrete",
          label: "Concrete-stage material",
          match: { facet: "cra_stages", any_of: ["concrete"] },
          min_count: 1,
        },
        {
          requirement_id: "cra_representational",
          label: "Representational-stage material",
          match: { facet: "cra_stages", any_of: ["representational"] },
          min_count: 1,
        },
        {
          requirement_id: "cra_abstract",
          label: "Abstract-stage material",
          match: { facet: "cra_stages", any_of: ["abstract"] },
          min_count: 1,
        },
      ],
    },
    {
      dimension_id: "support_floor",
      label: "Support floor",
      priority: 3,
      requirements: [
        {
          requirement_id: "st_keyword",
          label: "Vocabulary / keyword support",
          match: { facet: "support_types", any_of: ["vocab_keyword"] },
          min_count: 1,
        },
        {
          requirement_id: "st_anchor_symbol",
          label: "Anchor chart / symbol reference",
          match: { facet: "support_types", any_of: ["visual_scaffold", "reference_tool"] },
          min_count: 1,
        },
        {
          requirement_id: "st_worked_example",
          label: "Worked example",
          match: {
            facet: "support_types",
            any_of: ["worked_example_full", "worked_example_faded"],
          },
          min_count: 1,
        },
        {
          requirement_id: "st_cra_support",
          label: "CRA manipulative support",
          match: { facet: "support_types", any_of: ["cra_manipulative"] },
          min_count: 1,
        },
      ],
    },
    {
      dimension_id: "udl",
      label: "UDL principles",
      priority: 4,
      requirements: [
        {
          requirement_id: "udl_representation",
          label: "Multiple means of representation",
          match: { facet: "udl_principles", any_of: ["representation"] },
          min_count: 1,
        },
        {
          requirement_id: "udl_action_expression",
          label: "Multiple means of action & expression",
          match: { facet: "udl_principles", any_of: ["action_expression"] },
          min_count: 1,
        },
        {
          requirement_id: "udl_engagement",
          label: "Multiple means of engagement",
          match: { facet: "udl_principles", any_of: ["engagement"] },
          min_count: 1,
        },
      ],
    },
    {
      dimension_id: "lesson_block",
      label: "Gradual-release blocks",
      priority: 5,
      requirements: [
        {
          requirement_id: "block_i_do",
          label: "I do (model)",
          match: { facet: "lesson_blocks", any_of: ["i_do"] },
          min_count: 1,
        },
        {
          requirement_id: "block_we_do",
          label: "We do (guided)",
          match: { facet: "lesson_blocks", any_of: ["we_do"] },
          min_count: 1,
        },
        {
          requirement_id: "block_you_do",
          label: "You do (independent)",
          match: { facet: "lesson_blocks", any_of: ["you_do"] },
          min_count: 1,
        },
      ],
    },
  ],
};

/**
 * The v1 completeness template library the resolver reads (content-api reference).
 * v1 ships ONE template — the `default_v1` floor. Per-standard overrides are added
 * here only when a standard needs one; each REPLACES the default wholesale for its
 * codes (never merges).
 */
export const COMPLETENESS_TEMPLATES_V1: readonly CompletenessTemplate[] = [
  DEFAULT_COMPLETENESS_TEMPLATE_V1,
];
