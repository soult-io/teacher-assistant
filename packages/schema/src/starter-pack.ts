// M10-U7 — STARTER_PACK seed catalog (CLEARTEXT content-api reference).
//
// The curated starter pack: SME-authored `material_seed` records a teacher can
// COPY into her library (copy-on-import, ./materials.ts + packages/store). It is
// a PII-free CLEARTEXT reference with the SAME posture as `default_v1`
// (completeness.ts), PROMPT_TEMPLATES_V1 (prompt-templates.ts), and the segment
// catalog — served by content-api at M11 (a 501 scaffold until then); until then
// the canonical instances live here as the reference payload.
//
// DELIVERY SPLIT (spec architecture/m10-u7-spec.md): this ENGINE PR ships the
// catalog EMPTY. The 13-standard × 4-material curated pack is authored separately
// by SMEs (differentiation-udl-sme authorship + ky-sped-lbd-sdi-sme accom_mod/
// access_band co-sign) and lands in later CONTENT tranches as data PRs, each with
// a FERPA PII-free scan. Do NOT author starter content here — that is the SME
// deliverable, not the engine's. A `material_seed` carries NO student field by
// construction (see MaterialSeed in ./materials.ts); the FERPA structural
// invariant is asserted in ./starter-pack.test.ts.

import type { MaterialSeed } from "./materials.js";

/**
 * The v1 starter-pack catalog. EMPTY in the engine PR by design — curated content
 * arrives in the SME-authored data tranches. Test fixtures use `__fixture__`-
 * prefixed `seed_id`s and live in the tests, never here.
 */
export const STARTER_PACK_V1: readonly MaterialSeed[] = [];
