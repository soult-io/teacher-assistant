// M5 — value computation (PRD §5, design §B/C1). The MVP UI is %-only
// (#correct ÷ a per-probe custom total), but the schema's `denominator_model` is
// extensible and values are NEVER silently %-coerced: a non-% model returns its
// raw measure tagged as non-percent, so a later UI can render it correctly.

import type { DenominatorModel } from "@teacher-assistant/schema";

export interface ComputedValue {
  readonly model: DenominatorModel;
  /** For the % model: 0–100. For non-% models: the raw measure (rubric level / count / duration), NOT coerced. */
  readonly value: number;
  readonly isPercent: boolean;
}

/**
 * Compute a data point's value per the goal's own method. Only
 * `percent_correct_over_total` produces a percentage (from #correct + the
 * probe's actual total); the other models pass their raw measure through
 * untouched (no %-coercion, design C1).
 */
export function computeValue(
  model: DenominatorModel,
  numerator: number,
  denominatorUsed: number,
): ComputedValue {
  if (model === "percent_correct_over_total") {
    return { model, value: percentCorrect(numerator, denominatorUsed), isPercent: true };
  }
  // rubric_score / frequency_count / duration_latency: raw measure, no coercion.
  return { model, value: numerator, isPercent: false };
}

/** The stored ratio for a % point (data-model §2.4 `computed_value` = numerator/denominator_used). */
export function computedRatio(numerator: number, denominatorUsed: number): number {
  return denominatorUsed > 0 ? numerator / denominatorUsed : 0;
}

/** Percentage 0–100 (the single definition of the %-correct rule, reused by value + consistency). */
export function percentCorrect(numerator: number, denominatorUsed: number): number {
  return computedRatio(numerator, denominatorUsed) * 100;
}

/** A point's denominator mismatches the probe's expected total (data-model §2.4, design §B). */
export function isDenominatorMismatch(
  expectedDenominator: number,
  denominatorUsed: number,
): boolean {
  return denominatorUsed !== expectedDenominator;
}
