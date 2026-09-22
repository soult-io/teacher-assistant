// M10-U6 — PROMPT_TEMPLATES_V1 (CLEARTEXT content-api reference seed).
//
// The five LOCKED differentiation-udl-sme fill-the-blank prompt templates. A
// PromptTemplate is INERT static text (spec architecture/m10-u6-spec.md,
// differentiation-architecture §5, DECISIONS D-ARCH-4): the teacher COPIES the
// body into their OWN AI tool — the app NEVER runs it. By construction there is
// no endpoint / URL / execution field and NO code path here that sends body_text
// anywhere. See ./materials.ts (the type) and the FERPA-guard M10 no-egress suite
// (tools/ferpa-guard/test/ferpa-m10.test.ts) which proves that structurally.
//
// Classified CLEARTEXT, PII-free reference — the same posture as `material_seed`,
// the segment catalog, and `default_v1` (completeness.ts). The content-api endpoint
// that serves this library to the PWA lands with M11 (content-api is a 501 scaffold
// today); until then the canonical instances are exported here as the reference
// payload. NO student field.
//
// `body_text` is authored content, transcribed VERBATIM from the spec §CONTENT: the
// `___` blanks, the `[ ]` accommodation/modification checkboxes, and every line
// break copy through unchanged. The template literals are FLUSH-LEFT on purpose —
// any source indentation would leak into the string and corrupt the authored text.

import type { OpaqueId } from "./ids.js";
import type { PromptTemplate } from "./materials.js";

/**
 * The REQUIRED standing caution — shown wherever a template is offered (spec
 * §CONTENT). Identical verbatim on all five; defined once so it cannot drift.
 */
const STANDING_CAUTION =
  "AI can be wrong about math and about what a student needs — check every problem and every step before you use it.";

/**
 * The v1 prompt-template library the Copy-button surface (M10-UI) reads. Five
 * inert templates, one per differentiation support type the SME authored. Seeded
 * verbatim; the differentiation-udl-sme gate is the authority on the content.
 */
export const PROMPT_TEMPLATES_V1: readonly PromptTemplate[] = [
  {
    template_id: "step_chunked_worked_example_v1" as OpaqueId,
    title: "Step-chunked worked example (I DO model)",
    support_type: "step_chunked",
    standing_caution: STANDING_CAUTION,
    body_text: `You are helping an 8th-grade special-education teacher build an "I DO" modeling example.

Standard: ___ (KY standard code + the exact skill statement)
Target skill to model: ___
Problem numbers / context to use: ___
Student access level: reading and number sense at about a 3rd-grade level.

ACCOMMODATION vs MODIFICATION — choose one and tell me which:
[ ] ACCOMMODATION: keep the SAME 8th-grade skill above; change ONLY how it is presented (shorter sentences, smaller numbers to carry the load, one step per line). Do NOT swap in an easier skill.
[ ] MODIFICATION: I am intentionally lowering the expectation to a prerequisite skill. If I pick this, name the prerequisite skill you dropped to and say plainly how it differs from the 8th-grade standard.

Produce ONE fully worked example that:
- Breaks the solution into numbered micro-steps, ONE action per step.
- Puts a short plain-language cue under each step ("Step 2: line up the place values").
- Uses 3rd-grade reading level in all wording; keep the math symbols and the 8th-grade procedure itself unchanged if I chose ACCOMMODATION.
- Adds these SDI supports where they fit: ___ (e.g. keyword box, worked-example frame, multiplication grid, symbol chart).
- Ends with a blank "You try" frame with the same steps but numbers removed.

Show your step count so I can see it is chunked.`,
  },
  {
    template_id: "smaller_number_practice_set_v1" as OpaqueId,
    title: "Smaller-number / adapted practice set (WE DO / YOU DO)",
    support_type: "adapted_practice",
    standing_caution: STANDING_CAUTION,
    body_text: `You are helping an 8th-grade special-education teacher build a practice set for guided or independent practice.

Standard: ___ (KY standard code + exact skill statement)
Target skill to practice: ___
Access level: reading and number sense at about a 3rd-grade level.
How many problems: ___

ACCOMMODATION vs MODIFICATION — choose one and tell me which:
[ ] ACCOMMODATION: SAME 8th-grade skill; reduce only the LOAD — smaller / friendlier numbers, fewer steps per item, cleaner layout, one problem per box. The skill being practiced must stay the 8th-grade standard above.
[ ] MODIFICATION: I am lowering to a prerequisite skill on purpose. If so, state which prerequisite skill and how it is easier than the standard.

Build the set so that:
- Problems are ordered easiest to hardest (spaced/repetitive practice: several near-identical items before any variation).
- Each item repeats the SAME format so the student practices the skill, not a new layout.
- Numbers stay small and clean (whole numbers / simple values) unless the standard itself requires otherwise.
- Include a 1-item worked model at the top as a reference.
- Add these SDI supports: ___ (e.g. number line, multiplication grid, worked-example frame, calculator-allowed marker).
- Provide a separate answer key.

Do not change what the problems ASSESS if I chose ACCOMMODATION — only how heavy they are to read and compute.`,
  },
  {
    template_id: "keyword_vocab_support_v1" as OpaqueId,
    title: "Keyword / vocabulary support (all blocks)",
    support_type: "vocab_keyword",
    standing_caution: STANDING_CAUTION,
    body_text: `You are helping an 8th-grade special-education teacher build a math vocabulary support.

Standard: ___ (KY standard code + exact skill statement)
Words / terms this lesson needs: ___
Access level: reading at about a 3rd-grade level.

This is an ACCOMMODATION by default: the words stay the real 8th-grade math terms; only the EXPLANATION is made accessible. Do NOT replace an 8th-grade term with a childish substitute — teach the real word in plain language.
(If I instead want fewer / prerequisite terms, I will say so here: ___ — and you will tell me which terms you removed.)

For each term produce:
- The real math word.
- A 3rd-grade-reading-level definition (one short sentence, everyday words).
- A tiny example using numbers from this lesson.
- A quick visual cue idea (a symbol, icon, or simple drawing the teacher can add).
- A common mix-up to warn about, if there is one.

Lay it out as a keyword card / word bank the student can keep on the desk. Keep every definition under ___ words.`,
  },
  {
    template_id: "cra_manipulative_script_v1" as OpaqueId,
    title: "CRA / manipulative teaching script (concrete → representational → abstract)",
    support_type: "cra_manipulative",
    standing_caution: STANDING_CAUTION,
    body_text: `You are helping an 8th-grade special-education teacher write a CRA (concrete -> representational -> abstract) teaching script for one skill.

Standard: ___ (KY standard code + exact skill statement)
Target skill: ___
Numbers / context to use: ___
Access level: about a 3rd-grade level.
Manipulatives available: ___ (e.g. algebra tiles, base-ten blocks, counters, fraction bars).

This is an ACCOMMODATION: CRA changes the PATH to the 8th-grade skill, not the skill. The ABSTRACT stage must land on the actual 8th-grade standard above. If I want to stop short of the abstract 8th-grade skill (a modification), I will say so here: ___ — and you will name what was lowered.

Write three short scripted stages for the SAME problem type:
1. CONCRETE: exact teacher words + what to do with the manipulative (___), step by step.
2. REPRESENTATIONAL: how the student draws/represents it on paper once the objects are removed (pictures, tallies, a diagram).
3. ABSTRACT: the numbers/symbols-only version — this must be the real 8th-grade procedure.

For each stage give: teacher script (3rd-grade reading level), one check-for-understanding question, and the sign the student is ready to move to the next stage. Note which stage each SDI support belongs in: ___.`,
  },
  {
    template_id: "anchor_chart_cue_card_v1" as OpaqueId,
    title: "Anchor chart / cue card (reference tool)",
    support_type: "visual_scaffold",
    standing_caution: STANDING_CAUTION,
    body_text: `You are helping an 8th-grade special-education teacher design an anchor chart or a small desk cue card.

Standard: ___ (KY standard code + exact skill statement)
Skill or procedure it should remind the student of: ___
Format: ___ (wall anchor chart OR pocket-size cue card).
Access level: reading at about a 3rd-grade level.

This is an ACCOMMODATION: it is a REMINDER of the 8th-grade skill, not a shortcut that removes the thinking. Keep the real 8th-grade steps; make them easy to read and follow. (If I want it to cue a prerequisite skill instead, I will say so: ___ — and you will tell me what changed.)

Produce:
- A short title in student-friendly words.
- The steps as a numbered list, ONE action per line, fewest words possible.
- A simple icon/visual idea for each step the teacher can draw.
- One tiny worked mini-example the student can copy the pattern from.
- Colour / highlight suggestions to separate steps.

Keep total wording low enough to fit on ___ (a poster / an index card). No paragraphs — lists and visuals only.`,
  },
];
