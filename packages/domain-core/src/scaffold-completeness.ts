// M10-U4 — scaffold-completeness (gap) projection (spec architecture/m10-u4-spec.md).
//
// A PURE projection (like U2 `buildMaterialLibrary` / U3 `queryMaterials`): it
// scores a teacher's already-decrypted, PII-free `Material` set that matches a
// target against a `CompletenessTemplate` and returns which required CATEGORIES
// are covered and which are gaps. Read-only and deterministic — no writes, no
// crypto, no I/O, no egress, no generation, and no goal/probe mutation. It NAMES
// missing categories; it NEVER authors, suggests, titles, ranks, or generates a
// material, and its output carries NO student data (every value comes from the
// template config or a count — `target` is an opaque code/id echoed back).
//
// All pedagogy is in the template config (schema, `default_v1`). The ONLY logic
// here is the uniform count rule (arch §4): per requirement,
//   found  = count(materials where material[facet] ∩ any_of ≠ ∅)
//   status = found >= min_count ? "covered" : "gap".

import type {
  CompletenessFacet,
  CompletenessTemplate,
  Material,
  MaterialGoalSupport,
  OpaqueId,
} from "@teacher-assistant/schema";

/**
 * What the completeness is scored FOR. A standard code (fully functional at U4 —
 * matches `material.standard_codes`) or an opaque goal id (materials linked via
 * `MaterialGoalSupport`; real link data flows in at U5). Opaque — no student data.
 */
export type CompletenessTarget =
  | { readonly standard_code: string }
  | { readonly goal_id: OpaqueId };

/** Covered-vs-gap verdict for one requirement. */
export type CompletenessStatus = "covered" | "gap";

/**
 * One evaluated requirement (the spec's `Facet`). Every field is template config
 * or a count — no material identity, title, or student data.
 */
export interface CompletenessFacetResult {
  readonly dimension_id: string;
  readonly dimension_label: string;
  readonly requirement_id: string;
  readonly requirement_label: string;
  readonly facet: CompletenessFacet;
  readonly any_of: readonly string[];
  readonly required_count: number;
  readonly found_count: number;
  readonly priority: number;
  readonly status: CompletenessStatus;
}

/** The projection result: the echoed target plus covered / gap requirements. */
export interface ScaffoldCompleteness {
  readonly target: CompletenessTarget;
  readonly covered: readonly CompletenessFacetResult[];
  readonly gaps: readonly CompletenessFacetResult[];
}

/** Inputs to `buildScaffoldCompleteness` (arch §4 signature). */
export interface ScaffoldCompletenessInput {
  readonly target: CompletenessTarget;
  readonly materials: readonly Material[];
  readonly links: readonly MaterialGoalSupport[];
  readonly template: CompletenessTemplate;
}

/**
 * Score the material set matching `target` against `template` (arch §4). Pure and
 * deterministic: it never mutates an input, reads no store/crypto/network, and
 * emits only template config + counts. `covered` and `gaps` are both ordered by
 * dimension priority ascending, then requirement order (stable UI). A zero-match
 * target yields all gaps — not special-cased, it falls out of the count rule.
 */
export function buildScaffoldCompleteness(input: ScaffoldCompletenessInput): ScaffoldCompleteness {
  const { target, materials, links, template } = input;
  const scored = selectMaterials(target, materials, links);

  const results: CompletenessFacetResult[] = [];
  // Priority asc, then requirement order. Sort a COPY (never mutate the template);
  // Array.prototype.sort is stable, so equal priorities keep authored order.
  const dimensions = [...template.dimensions].sort((a, b) => a.priority - b.priority);
  for (const dimension of dimensions) {
    for (const requirement of dimension.requirements) {
      const requiredCount = requirement.min_count ?? 1;
      const anyOf = requirement.match.any_of;
      const foundCount = scored.filter((m) =>
        intersects(facetValues(m, requirement.match.facet), anyOf),
      ).length;
      results.push({
        dimension_id: dimension.dimension_id,
        dimension_label: dimension.label,
        requirement_id: requirement.requirement_id,
        requirement_label: requirement.label,
        facet: requirement.match.facet,
        any_of: anyOf,
        required_count: requiredCount,
        found_count: foundCount,
        priority: dimension.priority,
        status: foundCount >= requiredCount ? "covered" : "gap",
      });
    }
  }

  return {
    target,
    covered: results.filter((r) => r.status === "covered"),
    gaps: results.filter((r) => r.status === "gap"),
  };
}

/**
 * Pick the template for a target (arch §4, "Default vs per-standard"). Most-specific
 * wins: a template whose `applies_to` lists the target's standard code beats the
 * `"*"` default — a wholesale REPLACE, never a merge. A `goal_id` target resolves
 * via its KY standard code, which the caller supplies (`standardCodeForGoal`) so
 * this stays PII-free and never reads a goal record; unresolved → default.
 */
export function resolveCompletenessTemplate(
  templates: readonly CompletenessTemplate[],
  target: CompletenessTarget,
  opts?: { readonly standardCodeForGoal?: string },
): CompletenessTemplate {
  const code = "standard_code" in target ? target.standard_code : opts?.standardCodeForGoal;
  if (code !== undefined) {
    const specific = templates.find((t) => t.applies_to !== "*" && t.applies_to.includes(code));
    if (specific !== undefined) {
      return specific;
    }
  }
  const fallback = templates.find((t) => t.applies_to === "*");
  if (fallback === undefined) {
    throw new Error('resolveCompletenessTemplate: no default (applies_to "*") template in the set');
  }
  return fallback;
}

/**
 * The distinct, ACTIVE materials that count toward a target: `standard_code` →
 * materials whose `standard_codes` contains the code; `goal_id` → materials linked
 * via `MaterialGoalSupport` for that goal. Both dedupe by `material_id`.
 */
function selectMaterials(
  target: CompletenessTarget,
  materials: readonly Material[],
  links: readonly MaterialGoalSupport[],
): readonly Material[] {
  const matches =
    "standard_code" in target
      ? (m: Material) => m.standard_codes.includes(target.standard_code)
      : linkedTo(links, target.goal_id);
  return distinctActive(materials, matches);
}

/** A predicate: material is linked to `goalId` by at least one support record. */
function linkedTo(
  links: readonly MaterialGoalSupport[],
  goalId: OpaqueId,
): (m: Material) => boolean {
  const linkedIds = new Set(links.filter((l) => l.goal_id === goalId).map((l) => l.material_id));
  return (m) => linkedIds.has(m.material_id);
}

/** Active + predicate-matching materials, each `material_id` at most once. */
function distinctActive(
  materials: readonly Material[],
  matches: (m: Material) => boolean,
): readonly Material[] {
  const seen = new Set<OpaqueId>();
  const out: Material[] = [];
  for (const m of materials) {
    if (!m.active || !matches(m) || seen.has(m.material_id)) {
      continue;
    }
    seen.add(m.material_id);
    out.push(m);
  }
  return out;
}

/** The material's value(s) for a facet. `access_band` is scalar → a singleton set. */
function facetValues(m: Material, facet: CompletenessFacet): readonly string[] {
  switch (facet) {
    case "cra_stages":
      return m.cra_stages;
    case "udl_principles":
      return m.udl_principles;
    case "support_types":
      return m.support_types;
    case "lesson_blocks":
      return m.lesson_blocks;
    case "access_band":
      return [m.access_band];
  }
}

/** Non-empty set intersection (the uniform rule's `∩ ≠ ∅`). */
function intersects(values: readonly string[], anyOf: readonly string[]): boolean {
  return values.some((v) => anyOf.includes(v));
}
