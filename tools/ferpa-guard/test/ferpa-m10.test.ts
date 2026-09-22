// FERPA-guard — M10-U1 differentiation library structural stops (spec §A.4/§A.5,
// §B; data-model differentiation-architecture §2 FERPA).
//
// The differentiation library is a PII-FREE curriculum surface. Two structural
// invariants are enforced here, both mechanically from the schema source:
//
//   (a) NO student field on the curriculum records — `Material`, its content
//       union / asset, `MaterialSeed`, and `PromptTemplate` carry NO student_id,
//       initials, or goal_id BY CONSTRUCTION. The ONLY student/goal coupling in
//       the whole feature is the two dedicated link records. Proven by a static,
//       comment-stripped scan (so the privacy prose that NAMES these fields does
//       not trip the check — the M8b precedent).
//   (b) The coupling DOES live on the link records — material_goal_support carries
//       goal_id, material_student_support carries student_id — and those records
//       are classified ENCRYPTED (teacher MK), never CLEARTEXT. Positive assertion
//       so an accidental move of the edge onto the curriculum record is caught
//       from the other side too.
//
// §A.4 (surface-only link, NO data edge) is additionally an entry-time/domain
// rule; here we guard the schema shape that makes the data edge structurally
// impossible: the link record is the ONLY place a goal_id appears.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORD_CLASSIFICATION } from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { scanCodeForPattern } from "../src/checks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schemaSrc = join(repoRoot, "packages", "schema", "src");

// The PII-FREE curriculum records. NO student-identifying field may appear here.
// `completeness.ts` (M10-U4) is the scaffold-completeness rubric reference — a
// coverage-category config that must stay as student-free as the material records.
const curriculumFiles = [
  join(schemaSrc, "materials.ts"),
  join(schemaSrc, "material-validation.ts"),
  join(schemaSrc, "completeness.ts"),
];
// The ONLY place the student/goal coupling is allowed to live.
const linkFile = join(schemaSrc, "material-links.ts");

const STUDENT_FIELDS: readonly RegExp[] = [/\bstudent_id\b/, /\binitials\b/, /\bgoal_id\b/];

describe("FERPA (M10-U1a) — curriculum records carry NO student field", () => {
  it.each(STUDENT_FIELDS)("no %s anywhere in the curriculum schema source", (pattern) => {
    const hits = scanCodeForPattern(curriculumFiles, pattern);
    expect(hits, `${pattern} → ${JSON.stringify(hits, null, 2)}`).toEqual([]);
  });
});

describe("FERPA (M10-U1b) — the coupling lives ONLY on the link records", () => {
  it("material-links.ts is the source of the goal_id / student_id coupling", () => {
    // Comment-stripped code scan: the fields are referenced as real record fields,
    // not merely named in prose.
    expect(scanCodeForPattern([linkFile], /\bgoal_id\b/).length).toBeGreaterThan(0);
    expect(scanCodeForPattern([linkFile], /\bstudent_id\b/).length).toBeGreaterThan(0);
  });

  it("both link records are ENCRYPTED (teacher MK) — never a cleartext edge", () => {
    expect(RECORD_CLASSIFICATION.material_goal_support).toBe("ENCRYPTED");
    expect(RECORD_CLASSIFICATION.material_student_support).toBe("ENCRYPTED");
  });

  it("the SME-curated reference records are CLEARTEXT and student-free", () => {
    expect(RECORD_CLASSIFICATION.material_seed).toBe("CLEARTEXT");
    expect(RECORD_CLASSIFICATION.prompt_template).toBe("CLEARTEXT");
    expect(RECORD_CLASSIFICATION.completeness_template).toBe("CLEARTEXT");
  });
});
