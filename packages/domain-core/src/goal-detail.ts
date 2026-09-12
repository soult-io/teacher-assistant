// M5 — Goal Detail read model (design R3 D2/D3): reachable from every goal. It
// assembles the trend series, the consistency-window state, the fidelity
// counters (No-time / excused ⊘), the edit-audit history (ARC-auditable), and the
// observed-mastery candidate. The quarterly-summary slot is left for M6a (F4) to
// fill. Pure over decrypted points — no narrative, no PII beyond the opaque ids.

import type {
  IEPGoal,
  IsoDate,
  NoDataReason,
  ProgressDataPoint,
  Revision,
} from "@teacher-assistant/schema";
import { compareCodePoints } from "./comparators.js";
import {
  type ConsistencyResult,
  consistencyWindow,
  type MasteryCandidate,
  observeMastery,
} from "./consistency.js";
import { computeValue } from "./value.js";

export interface TrendPoint {
  readonly adminDate: IsoDate;
  /** Value per the goal's method (% for the % model; raw otherwise). */
  readonly value: number;
  readonly isPercent: boolean;
  /** True if this scored point is flagged as a denominator mismatch (excluded from the window). */
  readonly mismatch: boolean;
}

export interface GoalDetail {
  readonly goalId: IEPGoal["goal_id"];
  readonly status: IEPGoal["status"];
  /** Scored points in admin-date order, valued per the goal's method. */
  readonly trend: readonly TrendPoint[];
  readonly consistency: ConsistencyResult;
  /** No-time ⊘ count — the teacher/scheduling fidelity gap surfaced before an ARC. */
  readonly noTimeCount: number;
  /** Excused ⊘ count (absent/testing/no_school). */
  readonly excusedCount: number;
  /** Behavior ⊘ count — a soft flag (watch pattern), neither excused nor a fidelity gap (§A.2). */
  readonly behaviorCount: number;
  /** The full edit-audit trail across the goal's points (who/when/old→new). */
  readonly revisions: readonly Revision[];
  /** Non-null when the consistency window is met (observed, not closed). */
  readonly masteryCandidate: MasteryCandidate | null;
  /** Filled by M6a (F4 quarterly 5-point summary); null until then. */
  readonly quarterlySummary: null;
}

// Excused ⊘ reasons (design §A.2). `no_time` is the fidelity gap (counted
// separately) and `behavior` is a soft flag (watch pattern) — neither is excused.
const EXCUSED: ReadonlySet<NoDataReason> = new Set<NoDataReason>([
  "absent",
  "testing",
  "no_school",
]);

/** Build the Goal Detail read model for a goal from its (decrypted) points. */
export function buildGoalDetail(goal: IEPGoal, points: readonly ProgressDataPoint[]): GoalDetail {
  const mine = points.filter((p) => p.goal_id === goal.goal_id);

  const trend: TrendPoint[] = mine
    .filter((p) => p.state === "scored")
    .sort((a, b) => compareCodePoints(a.admin_date, b.admin_date))
    .map((p) => {
      const computed = computeValue(
        goal.denominator_model,
        p.numerator ?? 0,
        p.denominator_used ?? 0,
      );
      return {
        adminDate: p.admin_date,
        value: computed.value,
        isPercent: computed.isPercent,
        mismatch: p.denominator_mismatch === true,
      };
    });

  let noTimeCount = 0;
  let excusedCount = 0;
  let behaviorCount = 0;
  for (const p of mine) {
    if (p.state === "no_data") {
      if (p.no_data_reason === "no_time") {
        noTimeCount += 1;
      } else if (p.no_data_reason === "behavior") {
        behaviorCount += 1;
      } else if (p.no_data_reason !== undefined && EXCUSED.has(p.no_data_reason)) {
        excusedCount += 1;
      }
    }
  }

  const revisions = mine.flatMap((p) => p.revisions);

  return {
    goalId: goal.goal_id,
    status: goal.status,
    trend,
    consistency: consistencyWindow(goal, mine),
    noTimeCount,
    excusedCount,
    behaviorCount,
    revisions,
    masteryCandidate: observeMastery(goal, mine),
    quarterlySummary: null,
  };
}
