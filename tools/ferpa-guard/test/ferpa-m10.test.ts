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

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORD_CLASSIFICATION } from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { collectFiles, scanCodeForPattern, stripComments } from "../src/checks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schemaSrc = join(repoRoot, "packages", "schema", "src");

// The PII-FREE curriculum records. NO student-identifying field may appear here.
// `completeness.ts` (M10-U4) is the scaffold-completeness rubric reference — a
// coverage-category config that must stay as student-free as the material records.
// `prompt-templates.ts` (M10-U6) is the CLEARTEXT PROMPT_TEMPLATES_V1 seed — inert
// fill-the-blank text that must never carry a student field either.
const curriculumFiles = [
  join(schemaSrc, "materials.ts"),
  join(schemaSrc, "material-validation.ts"),
  join(schemaSrc, "completeness.ts"),
  join(schemaSrc, "prompt-templates.ts"),
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

// M10-U6 — the prompt_template store is INERT (D-ARCH-4: no runtime AI, no external
// egress). The whole point of the feature: a template is static fill-the-blank text
// the teacher copies into their OWN AI tool; the app NEVER runs it. This suite proves
// the no-egress property STRUCTURALLY, from source, so it cannot regress silently:
//
//   (a) grep-level — no module that references PROMPT_TEMPLATES_V1 / PromptTemplate /
//       prompt_template imports a network client (fetch / http / ws / fastify / axios /
//       the retired diff-orchestrator). If body_text can't reach a network sink, it
//       can't egress.
//   (b) type-level — the PromptTemplate type declares NO endpoint / url / execution
//       field, so there is nothing on the record to execute a prompt with.
//
// The two token-referencing files today are the type (materials.ts) and the
// classification map (classification.ts); the seed (prompt-templates.ts) joins them.
// The retired diff-orchestrator scaffold references none of these tokens and so is
// correctly out of scope — the guard fails the moment anyone wires it (or any other
// egress path) into the prompt_template surface.

// REPO-COMPLETE walk of shipped source (collectFiles prunes node_modules/dist/.git);
// test/spec files excluded — they legitimately name these patterns as regex literals and
// are not a runtime egress path. Walking the whole repo (not a fixed dir list) keeps the
// allowlist tripwire below sound: a consumer in a future top-level dir cannot hide.
const shippedTsFiles = collectFiles(repoRoot, [".ts"]).filter((f) => !/\.(test|spec)\.ts$/.test(f));

const PROMPT_TOKEN = /PROMPT_TEMPLATES_V1|PromptTemplate|prompt_template/;

// Blank comments AND string / template-literal contents, so authored body_text prose
// (a template could read "fetch the worksheet…") is treated as DATA, not code, and cannot
// trip a usage-shaped pattern. stripComments alone leaves string bodies intact.
function stripCommentsAndStrings(src: string): string {
  return stripComments(src)
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

// Network-client MODULE IMPORTS. The specifier is a string literal, so these are scanned
// with strings INTACT (comment-stripped only) — import-shaped, so prose cannot match. The
// retired diff-orchestrator is matched as a path substring: wiring it in is caught here.
const NETWORK_IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["'](?:node:)?https?["']/,
  /\brequire\(\s*["'](?:node:)?https?["']\)/,
  /\bfrom\s+["'](?:fastify|axios|undici|got|node-fetch|cross-fetch|superagent|ws)["']/,
  /\brequire\(\s*["'](?:fastify|axios|undici|got|node-fetch|cross-fetch|superagent|ws)["']\)/,
  /diff-orchestrator/,
];

// Egress CALL / instantiation sinks. Usage-shaped, so they are scanned with string bodies
// BLANKED (stripCommentsAndStrings) — a template's prose can never produce a false hit.
const NETWORK_USAGE_PATTERNS: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /\bnew\s+WebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bEventSource\b/,
  /\bFastify\s*\(/,
];

// A field on the PromptTemplate type that would give body_text somewhere to go, or a
// way to run it. None of the five real fields match.
const EXECUTION_FIELD_PATTERN =
  /\b(endpoint|url|uri|execute|exec|invoke|webhook|api[_-]?key|orchestrat)/i;

// The ONLY shipped modules allowed to reference the prompt_template surface today — all
// inert schema (the type, the classification entry, the seed). This is the tripwire that
// closes the transitive/two-hop egress path: a helper in module B that imports a network
// client is invisible to a one-file scan UNLESS some module A that reads the seed calls it,
// and A would then be a NEW referrer. Any new referrer (e.g. the M10-UI Copy-button
// consumer) MUST be added here AND re-clear this no-egress gate — it cannot land unreviewed.
const INERT_REFERRERS: readonly string[] = [
  join("packages", "schema", "src", "materials.ts"),
  join("packages", "schema", "src", "classification.ts"),
  join("packages", "schema", "src", "prompt-templates.ts"),
];

describe("FERPA (M10-U6) — prompt_template store is INERT (no egress)", () => {
  const referencingFiles = shippedTsFiles.filter(
    (f) => scanCodeForPattern([f], PROMPT_TOKEN).length > 0,
  );

  it("the scan actually resolves the prompt_template surface (not vacuously empty)", () => {
    // Anti-vacuous: if the walk or filter breaks, the whole suite must not pass silent.
    expect(referencingFiles.length).toBeGreaterThan(0);
    expect(
      referencingFiles.some((f) => f.endsWith(join("schema", "src", "prompt-templates.ts"))),
    ).toBe(true);
    expect(referencingFiles.some((f) => f.endsWith(join("schema", "src", "materials.ts")))).toBe(
      true,
    );
  });

  it("only inert schema modules reference the surface (a new consumer must re-clear this gate)", () => {
    const unexpected = referencingFiles.filter(
      (f) => !INERT_REFERRERS.some((allowed) => f.endsWith(allowed)),
    );
    expect(
      unexpected,
      `unlisted prompt_template referrer(s) — add to INERT_REFERRERS AND re-run the no-egress gate on the new consumer:\n${JSON.stringify(unexpected, null, 2)}`,
    ).toEqual([]);
  });

  it.each(NETWORK_IMPORT_PATTERNS)(
    "no module referencing prompt_template imports a network client (%s)",
    (pattern) => {
      const hits = scanCodeForPattern(referencingFiles, pattern);
      expect(hits, `${pattern} → ${JSON.stringify(hits, null, 2)}`).toEqual([]);
    },
  );

  it.each(NETWORK_USAGE_PATTERNS)(
    "no module referencing prompt_template calls a network / egress sink (%s)",
    (pattern) => {
      const hits = referencingFiles.filter((f) =>
        pattern.test(stripCommentsAndStrings(readFileSync(f, "utf8"))),
      );
      expect(hits, `${pattern} → ${JSON.stringify(hits, null, 2)}`).toEqual([]);
    },
  );

  it("the PromptTemplate type declares no endpoint / url / execution field", () => {
    const src = readFileSync(join(schemaSrc, "materials.ts"), "utf8");
    const match = src.match(/export interface PromptTemplate\b[^{]*\{([\s\S]*?)\n\}/);
    expect(match, "PromptTemplate interface not found in materials.ts").not.toBeNull();
    const body = stripComments(match?.[1] ?? "");
    expect(EXECUTION_FIELD_PATTERN.test(body), `PromptTemplate field body → ${body}`).toBe(false);
  });
});
