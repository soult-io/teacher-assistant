// M5 — baseline-mandatory gate + construct-integrity guard (design §B, §A,
// data-model §2.1/§2.3). A goal cannot begin monitoring without a baseline; a
// probe logs goal progress only if it matches the goal's circumstance (the probe
// condition must equal/derive it) — exposure-level content never auto-logs.

import type { IEPGoal, ProbeDefinition } from "@teacher-assistant/schema";

export interface GoalActivationCheck {
  readonly ok: boolean;
  /** Field names that block activation (empty iff ok). */
  readonly missing: readonly string[];
}

/**
 * Whether a goal may begin active monitoring. Baseline is MANDATORY (value +
 * source), alongside the other components a defensible active goal requires.
 * This is the gate the goal-creation path enforces (design §B baseline-mandatory).
 */
export function canBeginMonitoring(goal: IEPGoal): GoalActivationCheck {
  const missing: string[] = [];
  if (goal.baseline_value === undefined) {
    missing.push("baseline_value");
  }
  if (goal.baseline_source === undefined) {
    missing.push("baseline_source");
  }
  if (goal.criterion_consistency.n_probes <= 0) {
    missing.push("criterion_consistency");
  }
  if (goal.criterion_level <= 0) {
    missing.push("criterion_level");
  }
  if (goal.behavior.trim() === "") {
    missing.push("behavior");
  }
  if (goal.circumstance.trim() === "") {
    missing.push("circumstance");
  }
  return { ok: missing.length === 0, missing };
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Construct-integrity guard: a probe logs goal progress only if it belongs to the
 * goal AND its condition equals/derives the goal's circumstance. A probe that
 * doesn't match must not be recorded as progress for this goal.
 */
export function probeMatchesGoal(goal: IEPGoal, probe: ProbeDefinition): boolean {
  if (probe.goal_id !== goal.goal_id) {
    return false;
  }
  const condition = normalize(probe.condition);
  const circumstance = normalize(goal.circumstance);
  // "equal or derive": the probe condition is, or contains, the goal circumstance.
  return condition === circumstance || condition.includes(circumstance);
}
