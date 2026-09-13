// F-2 — the teacher's denominator-mismatch disposition (design §B). A mismatched
// scored point keeps `denominator_mismatch === true` (the FACT is never dropped);
// `mismatch_window_disposition` is a SEPARATE, teacher-chosen election over what
// the consistency window + F4 quarterly do with it:
//   - "counted"  → participates in that consumer's math, carried off-basis.
//   - "excluded" → out of the math, retained + visible in audit/history.
//   - absent     → PENDING: out of all computed math AND surfaced unresolved
//                  (the safe default — never silently counted, never silently hidden).
//
// The M8 auto-statement does NOT consult this — it hard-excludes every mismatched
// point (they keep `denominator_mismatch === true`), so an off-basis point can
// never flip a statement onto a trend claim (§G R3-3 step 4).

import type { ProgressDataPoint } from "@teacher-assistant/schema";

/** A mismatched scored point the teacher elected "counted" (in the math, off-basis). */
export function isCountedOffBasis(p: ProgressDataPoint): boolean {
  return p.denominator_mismatch === true && p.mismatch_window_disposition === "counted";
}

/** A mismatched point the teacher resolved OUT ("excluded") — retained + visible, not in math. */
export function isResolvedExcluded(p: ProgressDataPoint): boolean {
  return p.denominator_mismatch === true && p.mismatch_window_disposition === "excluded";
}

/** A mismatched point with no disposition yet — pending/unresolved (out of math, surfaced). */
export function isUnresolvedMismatch(p: ProgressDataPoint): boolean {
  return p.denominator_mismatch === true && p.mismatch_window_disposition === undefined;
}

/**
 * Whether a point participates in a consumer's computed math (consistency window,
 * F4 average, trend plot): a non-mismatched point, or a mismatched point the
 * teacher elected "counted". Excluded and pending mismatched points are out.
 */
export function inComputedMath(p: ProgressDataPoint): boolean {
  return p.denominator_mismatch !== true || p.mismatch_window_disposition === "counted";
}
