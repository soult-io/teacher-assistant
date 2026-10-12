// M10-U5 — Goal Detail support surfacing (spec architecture/m10-u5-spec.md §3).
//
// SURFACE-ONLY, NO DATA EDGE (U1 §A.4/§A.5(1), 707 KAR 1:320 §5(7)). This module
// lists the materials attached to a goal (via `material_goal_support`), each with
// its LINK-level `accom_mod` — the operative, compliance-bearing SDI posture. It
// is a PURE READ over already-decrypted, PII-free `Material` records and their
// opaque link edges.
//
// The no-data-edge guarantee is STRUCTURAL, not merely a convention: the
// monitoring read model (`buildGoalDetail`) neither imports nor receives supports,
// so it is incapable of letting an attachment touch the goal / criterion /
// baseline / probe condition / denominator / denominator_model / consistency
// window / IC value / M8 auto-statement condition_phrase. The support list is
// assembled here, independently, and composed onto the monitoring read model in a
// single ADDITIVE field (`supports`) that no monitoring computation reads. Test 7
// asserts the monitoring outputs are byte-identical with and without an attach.

import type {
  IEPGoal,
  Material,
  MaterialGoalSupport,
  OpaqueId,
  ProgressDataPoint,
} from "@teacher-assistant/schema";
import { compareLibraryOrder } from "./material-library.js";
import { compareCodePoints } from "./comparators.js";
import { buildGoalDetail, type GoalDetail } from "./goal-detail.js";

/**
 * One material attached to a goal, as the SDI-support view renders it. Carries the
 * LINK's `accom_mod` (the operative posture of THIS support against THIS goal, U1
 * §A.3) alongside the full PII-free `Material` for display. Note the accom_mod
 * here is the LINK's, which may differ from the material's advisory default.
 */
export interface GoalSupportEntry {
  readonly support_id: OpaqueId;
  /** The operative, compliance-bearing SDI posture of this support for this goal. */
  readonly accom_mod: MaterialGoalSupport["accom_mod"];
  /** The attached material (PII-free by construction — U1). */
  readonly material: Material;
}

/** The Goal Detail read model extended with the attached-support list (surface-only). */
export interface GoalDetailWithSupports extends GoalDetail {
  readonly supports: readonly GoalSupportEntry[];
}

/**
 * The materials attached to `goalId`, each paired with its link's operative
 * `accom_mod`. Pure: it neither mutates its inputs nor reads any monitoring value.
 *
 * A link is surfaced only when its material is BOTH supplied by the caller AND
 * active — a retired material (or one the caller withheld) is excluded, matching
 * the library-list rule (U2). Detached links never reach here: the store's live
 * projection filters tombstoned edges out before this function sees them.
 *
 * Order is the shared stable library order (newest material first by created_ts),
 * ties broken by the opaque `support_id` (code-point order — never localeCompare).
 */
export function buildGoalSupports(
  goalId: OpaqueId,
  links: readonly MaterialGoalSupport[],
  materials: readonly Material[],
): readonly GoalSupportEntry[] {
  const byId = new Map(materials.map((m) => [m.material_id, m]));
  const entries: GoalSupportEntry[] = [];
  for (const link of links) {
    if (link.goal_id !== goalId) {
      continue;
    }
    const material = byId.get(link.material_id);
    // Exclude unresolved (caller withheld) and retired materials.
    if (material === undefined || !material.active) {
      continue;
    }
    entries.push({ support_id: link.support_id, accom_mod: link.accom_mod, material });
  }
  return entries.sort(
    (a, b) =>
      compareLibraryOrder(a.material, b.material) || compareCodePoints(a.support_id, b.support_id),
  );
}

/**
 * The Goal Detail read model (unchanged monitoring core) PLUS the attached-support
 * list. The monitoring fields come verbatim from `buildGoalDetail(goal, points)`;
 * `supports` is a strictly additive surface computed independently. Nothing in the
 * monitoring core can observe `links`/`materials` — the no-data-edge guarantee.
 */
export function buildGoalDetailWithSupports(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
  links: readonly MaterialGoalSupport[],
  materials: readonly Material[],
): GoalDetailWithSupports {
  return {
    ...buildGoalDetail(goal, points),
    supports: buildGoalSupports(goal.goal_id, links, materials),
  };
}
