// Differentiation toolkit — curriculum records (M10-U1, spec architecture/m10-u1-spec.md).
//
// D-ARCH-4 hard frame: the app NEVER generates and NEVER depends on any single
// source method. No runtime AI, no external egress, no code path that executes a
// prompt. A `Material` is a PII-FREE curriculum artifact — it carries NO
// student_id / initials / goal_id BY CONSTRUCTION (spec §A.5, FERPA). The ONLY
// student/goal coupling in the feature is the two link records in
// ./material-links.ts; keeping the curriculum records in their own file lets the
// FERPA-guard suite scan this file for the absence of any student field.
//
// Materials are ENCRYPTED under the TEACHER master key — not because they are
// student-linked (they are not), but because the teacher's private library and
// its `access_band` pitch must never cross the Period-DEK boundary onto the para
// surface (spec §A.5(4)). See ./classification.ts.

import type {
  AccessBand,
  AccomMod,
  CraStage,
  LessonBlock,
  MaterialOrigin,
  MaterialSupportType,
  MypCriterion,
  UdlPrinciple,
} from "./enums.js";
import type { Revision } from "./entities.js";
import type { OpaqueId, Timestamp } from "./ids.js";

/**
 * The payload of a material (spec §2). Discriminated on `kind`. ALL THREE
 * variants are DEFINED (forward-compatible); the `file` variant references a
 * `material_asset` blob by `asset_id`, but NO blob channel and NO store CRUD is
 * built in this unit or in v1 (Neil deferred file upload; the encrypted blob
 * channel is a post-v1 follow-up — D-ARCH-4a).
 */
export type MaterialContent =
  | { readonly kind: "text"; readonly body: string }
  | { readonly kind: "link"; readonly url: string; readonly label?: string }
  | {
      readonly kind: "file";
      readonly asset_id: OpaqueId;
      readonly filename: string;
      readonly mime: string;
      readonly size: number;
    };

/**
 * The material-descriptive tag facets, PII-free and shared by a teacher's
 * `Material` and an SME-curated `MaterialSeed`. It deliberately EXCLUDES the SDI
 * posture (`accom_mod`) and the lifecycle/audit fields: a seed is "a material
 * minus the accommodation/modification call and its lifecycle", and encoding
 * that in the type keeps the two records' facet set in lockstep as it grows.
 */
export interface MaterialFacets {
  readonly title: string;
  readonly content: MaterialContent;
  /** KY standard codes this material ties to (the 13 power standards). */
  readonly standard_codes: readonly string[];
  /** Segment-catalog ids this material ties to. */
  readonly segment_ids: readonly OpaqueId[];
  readonly support_types: readonly MaterialSupportType[];
  /** REQUIRED, no default. The material's pitch — never the child (§A.5). */
  readonly access_band: AccessBand;
  readonly lesson_blocks: readonly LessonBlock[];
  readonly udl_principles: readonly UdlPrinciple[];
  readonly cra_stages: readonly CraStage[];
  /**
   * Conditional (§B): present with ≥1 of A–D iff `support_types` includes
   * `modified_assessment`; absent otherwise. Criterion-level ONLY — never a
   * strand, a 0–8 score, or a band (those are per-student, on the Toddle-bound
   * Achievement record).
   */
  readonly myp_criteria?: readonly MypCriterion[];
}

/**
 * A differentiation material (spec §"Material fields"). ENCRYPTED, teacher MK.
 * `access_band` and `accom_mod` are REQUIRED with no default (spec §A.1/§A.3);
 * `myp_criteria` is conditional — populated iff `support_types` includes
 * `modified_assessment` (spec §B). The cross-field rules are enforced by
 * `validateMaterialConstraints` in ./material-validation.ts, not by the type.
 */
export interface Material extends MaterialFacets {
  /** Random opaque id — never derived from content. */
  readonly material_id: OpaqueId;
  /**
   * REQUIRED, no default (§A.3). The artifact's DEFAULT/suggested posture
   * (advisory). The operative, compliance-bearing label is
   * `MaterialGoalSupport.accom_mod` (posture of THIS support against THIS goal),
   * confirmed per goal at link-time.
   */
  readonly accom_mod: AccomMod;
  readonly origin: MaterialOrigin;
  /** Soft-retire; no hard delete (audit). */
  readonly active: boolean;
  readonly created_ts: Timestamp;
  readonly revisions: readonly Revision[];
}

/**
 * Metadata for a `MaterialContent` `file` variant (spec §classification —
 * `material_asset`, ENCRYPTED teacher MK). Reserved for the DEFERRED file blob
 * channel: NO blob bytes and NO store CRUD are built in v1; this shape exists so
 * the `file` variant's `asset_id` has a typed referent and the classification is
 * complete. PII-FREE — no student field.
 */
export interface MaterialAsset {
  readonly asset_id: OpaqueId;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly created_ts: Timestamp;
}

/**
 * An SME-curated reference material (spec §classification — `material_seed`,
 * CLEARTEXT). A PII-FREE content-api reference, like the segment catalog, that
 * can pre-fill a teacher's `Material`. It carries the material-descriptive facets
 * but deliberately NOT `accom_mod`: the accommodation/modification posture is an
 * SDI call the teacher makes per material/goal at add-time (§A.3), never baked
 * into a shared cleartext catalog entry. NO student field by construction.
 */
export interface MaterialSeed extends MaterialFacets {
  readonly seed_id: OpaqueId;
}

/**
 * A fill-the-blank prompt template (spec §"prompt_template shape", CLEARTEXT).
 * Inert static text only. It has NO endpoint / URL / execution field BY
 * CONSTRUCTION — the "no egress path" frame (D-ARCH-4): this type can never carry
 * a way to execute a prompt. NO student field by construction.
 */
export interface PromptTemplate {
  readonly template_id: OpaqueId;
  readonly title: string;
  /** Static fill-the-blank text. Never executed, never a URL. */
  readonly body_text: string;
  readonly support_type: MaterialSupportType;
  /** REQUIRED standing caution shown wherever the template is offered. */
  readonly standing_caution: string;
}
