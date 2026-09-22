// M10-U2 — the material library-list projection (spec architecture/m10-u2-spec.md).
//
// A PURE function over already-decrypted `Material` records (no writes, no
// crypto, no student data — a Material is PII-free by construction, U1). It
// returns the teacher's ACTIVE library in a stable order; retired materials
// (active=false) are excluded (still retrievable by id via the store, just not
// listed). Each returned `Material` carries its full tag facets, so U3 can layer
// facet filtering on top WITHOUT a store change — U2 does no filtering itself.

import { compareCodePoints } from "./comparators.js";
import type { Material } from "@teacher-assistant/schema";

/**
 * The active materials in a stable, deterministic order: newest first by
 * `created_ts`, ties broken by the opaque `material_id` (code-point order — never
 * localeCompare). Pure: the input array is not mutated.
 */
export function buildMaterialLibrary(materials: readonly Material[]): readonly Material[] {
  return materials
    .filter((m) => m.active)
    .sort((a, b) => {
      if (a.created_ts !== b.created_ts) {
        return b.created_ts - a.created_ts;
      }
      return compareCodePoints(a.material_id, b.material_id);
    });
}
