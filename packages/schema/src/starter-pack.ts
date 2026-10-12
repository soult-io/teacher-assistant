// M10-U7 — STARTER_PACK seed catalog (CLEARTEXT content-api reference).
//
// The curated starter pack: SME-authored `material_seed` records a teacher can
// COPY into her library (copy-on-import, ./materials.ts + packages/store). It is
// a PII-free CLEARTEXT reference with the SAME posture as `default_v1`
// (completeness.ts), PROMPT_TEMPLATES_V1 (prompt-templates.ts), and the segment
// catalog — served by content-api at M11 (a 501 scaffold until then); until then
// the canonical instances live here as the reference payload.
//
// CONTENT TRANCHE 1 (this PR): the first curated data tranche — 16 records across
// four KY power standards (KY.8.NS.1, KY.8.NS.2, KY.8.EE.1, KY.8.EE.4), four per
// standard (vocab keyword, anchor/reference, CRA manipulative, full worked
// example). Authored by differentiation-udl-sme, accom_mod/access_band co-signed
// PASS by ky-sped-lbd-sdi-sme (architecture/starter-pack-tranche1.md). Every
// record: origin imported_seed at import time, access_band grade_level_scaffolded
// (preserve the 8th-grade construct, change only access). A `material_seed`
// carries NO `accom_mod` (an SDI call the teacher makes per material/goal at
// import time, ./materials.ts) and NO `myp_criteria` (none is a
// modified_assessment). A `material_seed` carries NO student field by
// construction (see MaterialSeed in ./materials.ts); the FERPA structural
// invariant is asserted in ./starter-pack.test.ts.

import type { MaterialSeed } from "./materials.js";
import type { OpaqueId } from "./ids.js";

/**
 * The v1 starter-pack catalog. Content tranche 1 = 16 SME-authored records (4 per
 * standard) across KY.8.NS.1 / KY.8.NS.2 / KY.8.EE.1 / KY.8.EE.4. Test fixtures
 * use `__fixture__`-prefixed `seed_id`s and live in the tests, never here.
 */
export const STARTER_PACK_V1: readonly MaterialSeed[] = [
  {
    seed_id: "seed_ns1_keyword_v1" as OpaqueId,
    title: "Rational vs. Irrational — Word List (plain language)",
    content: {
      kind: "text",
      body: `RATIONAL NUMBER — a number you CAN write as a fraction (one whole number over another). Its decimal STOPS or REPEATS. Examples: 1/2 = 0.5 (stops), 1/3 = 0.333... (repeats).
IRRATIONAL NUMBER — a number you CANNOT write as a fraction. Its decimal goes on FOREVER with NO repeating pattern. Examples: π = 3.14159..., √2 = 1.41421...
DECIMAL EXPANSION — the number written out as a decimal (the digits after the dot).
TERMINATE — the decimal STOPS. 0.25 stops.
REPEAT — the same digit or group keeps going. 0.666... the 6 repeats.
BAR — the short line drawn over the repeating digits. 0.6̄ means 0.6666...`,
    },
    standard_codes: ["KY.8.NS.1"],
    segment_ids: ["S1" as OpaqueId],
    support_types: ["vocab_keyword"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference", "i_do"],
    udl_principles: ["representation"],
    cra_stages: [],
  },
  {
    seed_id: "seed_ns1_anchor_v1" as OpaqueId,
    title: "Anchor Chart — Is It Rational or Irrational?",
    content: {
      kind: "text",
      body: `IS IT RATIONAL OR IRRATIONAL?

RATIONAL (fraction-friendly) → the decimal STOPS (0.75) or REPEATS (0.4444...).
Includes: all fractions, all whole numbers, all terminating decimals, all repeating decimals.

IRRATIONAL (never a fraction) → the decimal goes FOREVER and NEVER repeats.
Includes: π, and the square root of any number that is NOT a perfect square (√2, √3, √5, √8...).

SYMBOL KEY: √ = square root · ... = keeps going · bar over digits = that group repeats.

ASK YOURSELF: Can I write it as a fraction / does its decimal stop or repeat? YES → rational. NO → irrational.`,
    },
    standard_codes: ["KY.8.NS.1"],
    segment_ids: ["S1" as OpaqueId],
    support_types: ["visual_scaffold", "reference_tool"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference", "i_do", "we_do", "you_do"],
    udl_principles: ["representation", "engagement"],
    cra_stages: ["representational"],
  },
  {
    seed_id: "seed_ns1_cra_v1" as OpaqueId,
    title: "CRA — Sort It: Rational vs. Irrational (concrete → abstract)",
    content: {
      kind: "text",
      body: `CONCRETE: Give the student a stack of number cards (1/4, 0.5, 7, 2/3, √2, π, √9, 0.8). Student uses a calculator to turn each card into a decimal (a physical action). Sort the real cards into two labeled boxes/hoops: box A = "STOPS or REPEATS", box B = "GOES FOREVER, NO PATTERN".

REPRESENTATIONAL: Copy the sorted cards into a T-chart. In the left column (rational) draw a bar over any repeating digits. In the right column (irrational) write "...".

ABSTRACT: Finish the rule out loud and in writing: "If a number is a fraction, or its decimal stops or repeats, it is RATIONAL. If its decimal goes forever with no repeat, it is IRRATIONAL."

Teacher script: model ONE card in each box first (I DO), sort the next two together (WE DO), then release the stack.`,
    },
    standard_codes: ["KY.8.NS.1"],
    segment_ids: ["S1" as OpaqueId],
    support_types: ["cra_manipulative"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["i_do", "we_do"],
    udl_principles: ["representation", "action_expression"],
    cra_stages: ["concrete", "representational", "abstract"],
  },
  {
    seed_id: "seed_ns1_worked_v1" as OpaqueId,
    title: "Worked Example — Turn a Repeating Decimal Into a Fraction",
    content: {
      kind: "text",
      body: `WORKED EXAMPLE: Write 0.7777... as a fraction.
Step 1 — Name it. Let x = 0.7777...
Step 2 — Count the repeating digits. One digit repeats (the 7).
Step 3 — Multiply both sides by 10 (1 repeating digit → ×10). 10x = 7.7777...
Step 4 — Subtract the first line from the second: 10x − x = 7.7777... − 0.7777... → 9x = 7
Step 5 — Solve. Divide both sides by 9: x = 7/9.
Step 6 — Check. 7 ÷ 9 = 0.777... ✓

YOUR TURN (same steps): Write 0.4444... as a fraction.
___ = 0.4444...   →  10·___ = 4.4444...  →  9·___ = 4  →  ___ = 4/9.`,
    },
    standard_codes: ["KY.8.NS.1"],
    segment_ids: ["S1" as OpaqueId],
    support_types: ["worked_example_full"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["i_do", "we_do", "reference"],
    udl_principles: ["representation", "action_expression"],
    cra_stages: ["representational", "abstract"],
  },
  {
    seed_id: "seed_ns2_keyword_v1" as OpaqueId,
    title: "Estimating Square Roots — Word List (plain language)",
    content: {
      kind: "text",
      body: `APPROXIMATE / ESTIMATE — a CLOSE answer, not exact. "About this much."
SQUARE ROOT (√) — asks "what number times itself gives this?" √9 = 3 because 3×3 = 9.
PERFECT SQUARE — a number whose square root is a whole number: 1, 4, 9, 16, 25, 36, 49, 64, 81, 100.
BETWEEN — √8 is between √4 (=2) and √9 (=3), so √8 is between 2 and 3.
NUMBER LINE — a straight line that puts numbers in order, smallest to biggest.
CLOSER TO — √8 is between 2 and 3, and 8 is closer to 9 than to 4, so √8 is closer to 3.`,
    },
    standard_codes: ["KY.8.NS.2"],
    segment_ids: ["S1" as OpaqueId],
    support_types: ["vocab_keyword"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference", "i_do"],
    udl_principles: ["representation"],
    cra_stages: [],
  },
  {
    seed_id: "seed_ns2_anchor_v1" as OpaqueId,
    title: "Reference Chart — Perfect Squares (use it to estimate roots)",
    content: {
      kind: "text",
      body: `PERFECT SQUARES CHART
1²=1 · 2²=4 · 3²=9 · 4²=16 · 5²=25 · 6²=36 · 7²=49 · 8²=64 · 9²=81 · 10²=100 · 11²=121 · 12²=144 · 13²=169 · 14²=196 · 15²=225

HOW TO USE IT to estimate √n:
1) Find the two perfect squares that n sits BETWEEN.
2) The square roots of those two squares are your two whole numbers.
3) Decide which one n is CLOSER to.
Example: √50 is between 49 (7²) and 64 (8²), so between 7 and 8. 50 is very close to 49, so √50 ≈ 7.1.`,
    },
    standard_codes: ["KY.8.NS.2"],
    segment_ids: ["S1" as OpaqueId],
    support_types: ["reference_tool", "visual_scaffold"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference", "we_do", "you_do"],
    udl_principles: ["representation", "engagement"],
    cra_stages: ["representational", "abstract"],
  },
  {
    seed_id: "seed_ns2_cra_v1" as OpaqueId,
    title: "CRA — Build a Square to Estimate a Root (concrete → abstract)",
    content: {
      kind: "text",
      body: `CONCRETE: Give the student square tiles/counters. To estimate √30, try to build a square. A 5×5 square uses 25 tiles; a 6×6 square uses 36 tiles. 30 tiles make a square bigger than 5×5 but smaller than 6×6. So √30 is between 5 and 6.

REPRESENTATIONAL: Draw a number line from 5 to 6. 30 is a little past halfway between 25 and 36, and closer to 25, so mark √30 a bit past 5 (about 5.5).

ABSTRACT: Write √30 ≈ 5.5. Say the sentence: "√30 is between 5 and 6, closer to 5, about 5.5."

Teacher script: build √30 together (I DO), let the student build √40 with you (WE DO), then release √20 and √72.`,
    },
    standard_codes: ["KY.8.NS.2"],
    segment_ids: ["S1" as OpaqueId],
    support_types: ["cra_manipulative"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["i_do", "we_do"],
    udl_principles: ["representation", "action_expression"],
    cra_stages: ["concrete", "representational", "abstract"],
  },
  {
    seed_id: "seed_ns2_worked_v1" as OpaqueId,
    title: "Worked Example — Estimate √50 and Place It on a Number Line",
    content: {
      kind: "text",
      body: `WORKED EXAMPLE: Estimate √50 to the nearest tenth and place it on a number line.
Step 1 — Two perfect squares it sits between: 49 (7²) and 64 (8²). So √50 is between 7 and 8.
Step 2 — Closer to which? 50 is very close to 49, so √50 is close to 7 (just a little more).
Step 3 — Estimate the tenth: 50 − 49 = 1, and 64 − 49 = 15, so 1 out of 15 ≈ 0.1. √50 ≈ 7.1.
Step 4 — Check: 7.1 × 7.1 = 50.41, very close to 50 ✓
Step 5 — Draw a number line 7 to 8; mark √50 just past 7.

YOUR TURN (same steps): Estimate √20. Between ___ (4²=16) and ___ (5²=25) → between 4 and 5; 20 is closer to ___; √20 ≈ ___.`,
    },
    standard_codes: ["KY.8.NS.2"],
    segment_ids: ["S1" as OpaqueId],
    support_types: ["worked_example_full"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["i_do", "we_do", "reference"],
    udl_principles: ["representation", "action_expression"],
    cra_stages: ["representational", "abstract"],
  },
  {
    seed_id: "seed_ee1_keyword_v1" as OpaqueId,
    title: "Exponent Rules — Word List (plain language)",
    content: {
      kind: "text",
      body: `BASE — the big number being multiplied. In 3⁴, the base is 3.
EXPONENT (POWER) — the small number up high; it tells how many times to multiply the base. 3⁴ = 3×3×3×3.
PRODUCT RULE — SAME base, multiplying → ADD the exponents. 3²×3⁵ = 3⁷.
QUOTIENT RULE — SAME base, dividing → SUBTRACT the exponents. 3⁵÷3² = 3³.
POWER RULE — a power raised to a power → MULTIPLY the exponents. (3²)⁴ = 3⁸.
ZERO EXPONENT — anything to the 0 power = 1. 3⁰ = 1.
NEGATIVE EXPONENT — flip it (reciprocal). 3⁻² = 1/3² = 1/9.`,
    },
    standard_codes: ["KY.8.EE.1"],
    segment_ids: ["S2" as OpaqueId],
    support_types: ["vocab_keyword"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference", "i_do"],
    udl_principles: ["representation"],
    cra_stages: [],
  },
  {
    seed_id: "seed_ee1_anchor_v1" as OpaqueId,
    title: "Cue Card — The 5 Exponent Rules (one look, one example each)",
    content: {
      kind: "text",
      body: `EXPONENT RULES — ASK FIRST: "Is the BASE the same?" Then match the operation:

MULTIPLYING same base → ADD the powers:  aᵐ × aⁿ = aᵐ⁺ⁿ   (3²×3³ = 3⁵)
DIVIDING same base → SUBTRACT the powers:  aᵐ ÷ aⁿ = aᵐ⁻ⁿ   (3⁵÷3² = 3³)
POWER of a POWER → MULTIPLY the powers:  (aᵐ)ⁿ = aᵐˣⁿ   ((3²)³ = 3⁶)
ZERO power → answer is 1:  a⁰ = 1   (3⁰ = 1)
NEGATIVE power → FLIP it:  a⁻ⁿ = 1/aⁿ   (3⁻² = 1/9)

STUCK? 1) Same base? 2) What operation (×, ÷, power)? 3) Pick the matching rule.`,
    },
    standard_codes: ["KY.8.EE.1"],
    segment_ids: ["S2" as OpaqueId],
    support_types: ["reference_tool", "visual_scaffold"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference", "we_do", "you_do"],
    udl_principles: ["representation", "engagement"],
    cra_stages: ["abstract"],
  },
  {
    seed_id: "seed_ee1_cra_v1" as OpaqueId,
    title: "CRA — Why the Product Rule Works: Expand and Count",
    content: {
      kind: "text",
      body: `CONCRETE: Write each factor on cards. Make 2³ as three "×2" cards: [×2][×2][×2]. Make 2² as two "×2" cards: [×2][×2]. Push the two groups together and count all the "×2" cards: 5 of them. So 2³ × 2² = 2⁵.

REPRESENTATIONAL: Draw the expansion: 2³ × 2² = (2·2·2) × (2·2) = 2·2·2·2·2. Circle the twos and count → 5 twos → 2⁵.

ABSTRACT: See the shortcut: you ADD the exponents. 3 + 2 = 5, so 2³ × 2² = 2⁵. Now the rule makes sense: aᵐ × aⁿ = aᵐ⁺ⁿ.

Teacher script: model 2³×2² by counting cards (I DO), count 3²×3² together (WE DO), then release to the abstract rule.`,
    },
    standard_codes: ["KY.8.EE.1"],
    segment_ids: ["S2" as OpaqueId],
    support_types: ["cra_manipulative"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["i_do", "we_do"],
    udl_principles: ["representation", "action_expression"],
    cra_stages: ["concrete", "representational", "abstract"],
  },
  {
    seed_id: "seed_ee1_worked_v1" as OpaqueId,
    title: "Worked Example — Simplify (3²)(3⁻⁵) [the standard's own example]",
    content: {
      kind: "text",
      body: `WORKED EXAMPLE: Simplify (3²)(3⁻⁵).
Step 1 — Same base? Yes, both are base 3. We are MULTIPLYING → ADD the exponents.
Step 2 — Add: 2 + (−5) = −3. So (3²)(3⁻⁵) = 3⁻³.
Step 3 — Negative exponent → FLIP it: 3⁻³ = 1/3³.
Step 4 — 3³ = 3×3×3 = 27. Answer: 1/27.

YOUR TURN (same steps): Simplify (2⁴)(2⁻¹).
Same base? ___  Add exponents: 4 + (−1) = ___  → 2___  → (if negative, flip) → ___.`,
    },
    standard_codes: ["KY.8.EE.1"],
    segment_ids: ["S2" as OpaqueId],
    support_types: ["worked_example_full"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["i_do", "we_do", "reference"],
    udl_principles: ["representation", "action_expression"],
    cra_stages: ["abstract"],
  },
  {
    seed_id: "seed_ee4_keyword_v1" as OpaqueId,
    title: "Scientific Notation — Word List (plain language)",
    content: {
      kind: "text",
      body: `SCIENTIFIC NOTATION — a short way to write very BIG or very TINY numbers: (a number from 1 up to under 10) × 10 to a power. Example: 3 × 10⁸.
STANDARD FORM — the number written out the long way. 3 × 10⁸ = 300,000,000.
COEFFICIENT — the front number; it must be 1 or more and less than 10. In 4.5 × 10⁶, the coefficient is 4.5.
POWER OF 10 — tells how many places to move the dot. POSITIVE = big number (move dot RIGHT). NEGATIVE = tiny number (move dot LEFT).
VERY LARGE — big positive power (population, distances in space).
VERY SMALL — negative power (size of a cell, seafloor spreading in mm/year).`,
    },
    standard_codes: ["KY.8.EE.4"],
    segment_ids: ["S2" as OpaqueId],
    support_types: ["vocab_keyword"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference", "i_do"],
    udl_principles: ["representation"],
    cra_stages: [],
  },
  {
    seed_id: "seed_ee4_anchor_v1" as OpaqueId,
    title: "Anchor Chart — Moving the Decimal (scientific ↔ standard)",
    content: {
      kind: "text",
      body: `MOVING THE DECIMAL POINT

SCIENTIFIC → STANDARD (read the power of 10):
  POSITIVE power → move the dot RIGHT that many places (number gets BIGGER). 3 × 10⁴ → right 4 → 30,000.
  NEGATIVE power → move the dot LEFT that many places (number gets SMALLER). 3 × 10⁻⁴ → left 4 → 0.0003.
  (Fill empty places with 0.)

STANDARD → SCIENTIFIC:
  1) Put the dot right after the first non-zero digit.
  2) Count how many places you moved it.
  3) Moved LEFT → power is POSITIVE. Moved RIGHT → power is NEGATIVE.
  Example: 52,000 → 5.2, moved 4 left → 5.2 × 10⁴.

CHECK: the coefficient must be 1 up to under 10.`,
    },
    standard_codes: ["KY.8.EE.4"],
    segment_ids: ["S2" as OpaqueId],
    support_types: ["visual_scaffold", "reference_tool"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["reference", "i_do", "we_do", "you_do"],
    udl_principles: ["representation", "engagement"],
    cra_stages: ["representational"],
  },
  {
    seed_id: "seed_ee4_cra_v1" as OpaqueId,
    title: "CRA — Slide the Decimal on a Place-Value Mat",
    content: {
      kind: "text",
      body: `CONCRETE: Use a place-value mat and one physical "dot" chip. Start with the digit 3 in the ones place. For 3 × 10³, physically slide the dot chip 3 places to the RIGHT, dropping a 0 counter into each empty place: 3 → 30 → 300 → 3,000.
For a tiny number, 3 × 10⁻², slide the dot 2 places LEFT, filling with 0s: 3 → 0.3 → 0.03.

REPRESENTATIONAL: Draw the place-value chart. Draw curved arrows showing the dot jump each place; write a 0 in every new place it passes.

ABSTRACT: Write the finished number and the rule: "positive power → dot moves right (bigger); negative power → dot moves left (smaller)."

Teacher script: model 3 × 10³ (I DO), do 4 × 10² together (WE DO), then release 6 × 10⁻³.`,
    },
    standard_codes: ["KY.8.EE.4"],
    segment_ids: ["S2" as OpaqueId],
    support_types: ["cra_manipulative"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["i_do", "we_do"],
    udl_principles: ["representation", "action_expression"],
    cra_stages: ["concrete", "representational", "abstract"],
  },
  {
    seed_id: "seed_ee4_worked_v1" as OpaqueId,
    title: "Worked Example — Multiply Numbers in Scientific Notation",
    content: {
      kind: "text",
      body: `WORKED EXAMPLE: Multiply (2 × 10³) × (4 × 10²).
Step 1 — Multiply the front numbers (coefficients): 2 × 4 = 8.
Step 2 — The base is 10 and we are multiplying → ADD the powers: 3 + 2 = 5. That gives 10⁵.
Step 3 — Put them together: 8 × 10⁵.
Step 4 — Check the coefficient is 1 up to under 10: 8 is fine. Done: 8 × 10⁵.
Step 5 — (Standard form: 800,000.)

YOUR TURN (same steps): (3 × 10²) × (2 × 10⁴).
Coefficients: 3 × 2 = ___   Powers: 2 + 4 = ___   Answer: ___ × 10___.`,
    },
    standard_codes: ["KY.8.EE.4"],
    segment_ids: ["S2" as OpaqueId],
    support_types: ["worked_example_full"],
    access_band: "grade_level_scaffolded",
    lesson_blocks: ["i_do", "we_do", "reference"],
    udl_principles: ["representation", "action_expression"],
    cra_stages: ["abstract"],
  },
];
