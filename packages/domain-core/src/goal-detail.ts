// M5 — Goal Detail read model (design R3 D2/D3): reachable from every goal. It
// assembles the trend series, the consistency-window state, the fidelity
// counters (No-time / excused ⊘), the edit-audit history (ARC-auditable), and the
// observed-mastery candidate. The quarterly-summary slot is left for M6a (F4) to
// fill. Pure over decrypted points — no narrative, no PII beyond the opaque ids.

import type {
  IEPGoal,
  IsoDate,
  NoDataReason,
  OpaqueId,
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
import { inComputedMath, isCountedOffBasis } from "./mismatch.js";
import {
  clampAfterFromRevisions,
  computeQuarterlySummary,
  type QuarterlySummary,
} from "./quarterly.js";
import { computeValue } from "./value.js";

type ArcOrdered = Pick<ProgressDataPoint, "admin_date" | "entry_ts" | "data_point_id">;

/**
 * The ARC-history order (TEACH-25): admin date newest first, then entry time
 * newest first, then the point id. The chart plots in the exact reverse
 * (`arcChronological`), so same-day points read in matching order in both.
 */
export function compareArcNewestFirst(a: ArcOrdered, b: ArcOrdered): number {
  return (
    compareCodePoints(b.admin_date, a.admin_date) ||
    b.entry_ts - a.entry_ts ||
    compareCodePoints(a.data_point_id, b.data_point_id)
  );
}

/** Oldest-first plot order: the exact reverse of compareArcNewestFirst. */
function arcChronological(a: ArcOrdered, b: ArcOrdered): number {
  return compareArcNewestFirst(b, a);
}

export interface TrendPoint {
  /** The source point's opaque id — a stable identity for rendering (unique React key). */
  readonly dataPointId: OpaqueId;
  readonly adminDate: IsoDate;
  /** Value per the goal's method (% for the % model; raw otherwise). */
  readonly value: number;
  readonly isPercent: boolean;
  /**
   * F-2: a plotted point that is a teacher-COUNTED off-basis (denominator-mismatch)
   * point — carried with this non-strippable flag. Excluded/pending mismatched
   * points are NOT plotted (they remain in history/audit); a non-mismatched point
   * plots with offBasis=false.
   */
  readonly offBasis: boolean;
}

/**
 * A ⊘ (no-data) probe date — the chart renders it as a GAP (never a plotted 0).
 * Exposed so the UI positions the gap glyph without re-classifying ⊘ reasons.
 */
export interface NoDataMarker {
  readonly adminDate: IsoDate;
  readonly reason: NoDataReason;
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
  /** The F4 quarterly 5-point summary (M6a). */
  readonly quarterlySummary: QuarterlySummary;
  /**
   * The ⊘ probe dates (admin-date order) — the chart draws each as a gap, never a
   * plotted 0 (design §A.2). Excluded/pending mismatched SCORED points are NOT here
   * (they are not ⊘) — they stay in the history table, just not on the trend line.
   */
  readonly noDataMarkers: readonly NoDataMarker[];
  /**
   * The criterion / denominator-model change boundary (SME advisory): the admin
   * date on/after which the current model holds, or null when the goal never
   * changed. The trend chart must NOT fit an aim/trend line ACROSS this boundary —
   * it plots raw points fine, but segments the line at this date. The engine owns
   * the boundary (clampAfterFromRevisions); the UI only reads it.
   */
  readonly clampAfter: IsoDate | null;
}

// Excused ⊘ reasons (design §A.2). `no_time` is the fidelity gap (counted
// separately) and `behavior` is a soft flag (watch pattern) — neither is excused.
const EXCUSED: ReadonlySet<NoDataReason> = new Set<NoDataReason>([
  "absent",
  "testing",
  "no_school",
]);

interface NoDataTally {
  readonly noTimeCount: number;
  readonly excusedCount: number;
  readonly behaviorCount: number;
  readonly markers: NoDataMarker[];
}

/** Tally the ⊘ points by reason and collect the chart's gap markers (plot order). */
function tallyNoData(points: readonly ProgressDataPoint[]): NoDataTally {
  let noTimeCount = 0;
  let excusedCount = 0;
  let behaviorCount = 0;
  const markers: NoDataMarker[] = [];
  for (const p of [...points].sort(arcChronological)) {
    if (p.state !== "no_data" || p.no_data_reason === undefined) {
      continue;
    }
    const reason = p.no_data_reason;
    if (reason === "no_time") {
      noTimeCount += 1;
    } else if (reason === "behavior") {
      behaviorCount += 1;
    } else if (EXCUSED.has(reason)) {
      excusedCount += 1;
    }
    markers.push({ adminDate: p.admin_date, reason });
  }
  return { noTimeCount, excusedCount, behaviorCount, markers };
}

/** The plotted trend series: scored points in the computed math, valued per the goal's method. */
function buildTrend(goal: IEPGoal, points: readonly ProgressDataPoint[]): TrendPoint[] {
  return (
    points
      // Plot the points that participate: non-mismatched, or teacher-counted. An
      // excluded/pending mismatched point is never plotted (it stays in history).
      .filter((p) => p.state === "scored" && inComputedMath(p))
      .sort(arcChronological)
      .map((p) => {
        const computed = computeValue(
          goal.denominator_model,
          p.numerator ?? 0,
          p.denominator_used ?? 0,
        );
        return {
          dataPointId: p.data_point_id,
          adminDate: p.admin_date,
          value: computed.value,
          isPercent: computed.isPercent,
          offBasis: isCountedOffBasis(p),
        };
      })
  );
}

/** Build the Goal Detail read model for a goal from its (decrypted) points. */
export function buildGoalDetail(goal: IEPGoal, points: readonly ProgressDataPoint[]): GoalDetail {
  const mine = points.filter((p) => p.goal_id === goal.goal_id);
  const clampAfter = clampAfterFromRevisions(goal);
  const trend = buildTrend(goal, mine);
  const noData = tallyNoData(mine);
  const revisions = mine.flatMap((p) => p.revisions);

  return {
    goalId: goal.goal_id,
    status: goal.status,
    trend,
    consistency: consistencyWindow(goal, mine),
    noTimeCount: noData.noTimeCount,
    excusedCount: noData.excusedCount,
    behaviorCount: noData.behaviorCount,
    revisions,
    masteryCandidate: observeMastery(goal, mine),
    quarterlySummary: computeQuarterlySummary(
      goal,
      mine,
      clampAfter !== undefined ? { clampAfter } : {},
    ),
    noDataMarkers: noData.markers,
    clampAfter: clampAfter ?? null,
  };
}
