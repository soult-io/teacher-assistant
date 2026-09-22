// Differentiation toolkit — link records (M10-U1, spec §"Link record shapes").
//
// These are the ONLY records in the differentiation feature that couple a
// material to a student or a goal. They are ENCRYPTED under the teacher master
// key, initials-only, TEACHER-ONLY (spec §A.5(4)); the library + `access_band`
// NEVER cross the Period-DEK boundary onto the para surface.
//
// SURFACE-ONLY, NO DATA EDGE (spec §A.4, 707 KAR 1:320 §5(7)): `MaterialGoalSupport`
// surfaces "which supports are attached to this goal" and carries link-level
// `accom_mod` as planning metadata ONLY. It is structurally barred from mutating
// or feeding the goal definition / criterion / baseline, the probe definition /
// condition / circumstance, the denominator or denominator_model, the consistency
// window, the IC value, or the M8 auto-statement condition_phrase. This file
// defines ONLY the link shape; it exposes no field through which such a data edge
// could exist, and it imports nothing from the monitoring engine.

import type { AccomMod } from "./enums.js";
import type { OpaqueId } from "./ids.js";

/**
 * Attaches a material to an IEP goal (spec §"Link record shapes"). The
 * `accom_mod` here is the OPERATIVE, compliance-bearing SDI posture — the posture
 * of THIS support against THIS goal's construct — REQUIRED at link-time (spec
 * §A.3). It may pre-fill from the material's advisory default, but the teacher
 * confirms it per goal; the same material can be an accommodation for one goal
 * and a modification for another.
 *
 * The `goal_id` is an OPAQUE reference (initials-only coupling); nothing here
 * reads back into the goal's definition — surface-only, no data edge (§A.4).
 */
export interface MaterialGoalSupport {
  readonly support_id: OpaqueId;
  readonly material_id: OpaqueId;
  readonly goal_id: OpaqueId;
  readonly accom_mod: AccomMod;
}

/**
 * Attaches a material to a student (spec §"Link record shapes"). `student_id` is
 * an OPAQUE reference; the student's initials-only identity lives on the Student
 * record, never here.
 */
export interface MaterialStudentSupport {
  readonly support_id: OpaqueId;
  readonly material_id: OpaqueId;
  readonly student_id: OpaqueId;
}
