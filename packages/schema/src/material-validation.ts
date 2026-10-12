// Differentiation toolkit — cross-field constraint validators (M10-U1, spec
// §validators / Tests 3–5). Pure, schema-level functions: they take the tag
// facets and return the set of violated rules (empty = valid). They import no
// engine and touch no student data — they are total functions over the enums.
//
// The three rules are the HARD schema constraints from the two SME rulings
// (§A.3, §B). Per-type "default lean" guidance is advisory and lives in the
// ruling table, NOT here — only these three are enforced.

import { MYP_CRITERIA, type MypCriterion } from "./enums.js";
import type { Material } from "./materials.js";

/** The cross-field rules a material's tag facets can violate. */
export type MaterialConstraintRule =
  | "accom_mod_band"
  | "modified_assessment_mod"
  | "myp_criteria_conditional";

export interface MaterialConstraintViolation {
  readonly rule: MaterialConstraintRule;
  readonly message: string;
}

/** The tag facets the constraints are computed from (a subset of `Material`). */
export type MaterialConstraintInput = Pick<
  Material,
  "access_band" | "accom_mod" | "support_types" | "myp_criteria"
>;

const MODIFIED_ASSESSMENT = "modified_assessment";

/** §A.3 — `accom_mod=none` is valid ONLY at `access_band=on_grade`. */
function checkAccomModBand(m: MaterialConstraintInput): MaterialConstraintViolation | undefined {
  if (m.accom_mod === "none" && m.access_band !== "on_grade") {
    return {
      rule: "accom_mod_band",
      message: `accom_mod=none is valid only at access_band=on_grade, not ${m.access_band}`,
    };
  }
  return undefined;
}

/** §A.3 — a `modified_assessment` support is inherently a modification. */
function checkModifiedAssessmentMod(
  m: MaterialConstraintInput,
): MaterialConstraintViolation | undefined {
  if (m.support_types.includes(MODIFIED_ASSESSMENT) && m.accom_mod !== "modification") {
    return {
      rule: "modified_assessment_mod",
      message: `support_types includes ${MODIFIED_ASSESSMENT}, so accom_mod must be modification, not ${m.accom_mod}`,
    };
  }
  return undefined;
}

/**
 * §B — two-way: `myp_criteria` names ≥1 of A–D IFF `support_types` includes
 * `modified_assessment`; it must be null/absent otherwise. When present, every
 * value must be a valid MYP criterion (⊆ {A,B,C,D}).
 */
function checkMypCriteriaConditional(
  m: MaterialConstraintInput,
): MaterialConstraintViolation | undefined {
  const isModified = m.support_types.includes(MODIFIED_ASSESSMENT);
  const criteria = m.myp_criteria;

  if (!isModified) {
    // Two-way (§B): myp_criteria must be ABSENT entirely — not even an empty
    // array — for every material without modified_assessment.
    if (criteria !== undefined) {
      return {
        rule: "myp_criteria_conditional",
        message: "myp_criteria must be absent unless support_types includes modified_assessment",
      };
    }
    return undefined;
  }
  // modified_assessment ⟹ ≥1 criterion, each a valid MYP criterion (⊆ {A,B,C,D}).
  if (criteria === undefined || criteria.length === 0) {
    return {
      rule: "myp_criteria_conditional",
      message: `support_types includes ${MODIFIED_ASSESSMENT}, so myp_criteria must name ≥1 of A–D`,
    };
  }
  if (!criteria.every((c) => (MYP_CRITERIA as readonly MypCriterion[]).includes(c))) {
    return {
      rule: "myp_criteria_conditional",
      message: "myp_criteria must be a subset of {A,B,C,D}",
    };
  }
  return undefined;
}

/**
 * Return every constraint a material's tag facets violate; empty = valid. Pure
 * and total over well-typed input — the add-time and link-time gate. Runtime
 * shape-guarding of raw JSON (a deserialized object missing `support_types`)
 * belongs at the U2 store boundary, not here.
 */
export function validateMaterialConstraints(
  m: MaterialConstraintInput,
): readonly MaterialConstraintViolation[] {
  const checks = [checkAccomModBand, checkModifiedAssessmentMod, checkMypCriteriaConditional];
  const violations: MaterialConstraintViolation[] = [];
  for (const check of checks) {
    const v = check(m);
    if (v !== undefined) {
      violations.push(v);
    }
  }
  return violations;
}

/** Convenience: true iff the material's tag facets satisfy every constraint. */
export function isValidMaterial(m: MaterialConstraintInput): boolean {
  return validateMaterialConstraints(m).length === 0;
}
