// M5 — consistency window + mastery observation (design §A.3, §B "mastery
// framing"). "Consecutive" means consecutive SCORED PROBES in the shared
// oldest-first order (admin date, then entry time — compareArcOldestFirst), never
// weeks. Same-day probes are one group (TEACH-27): a day adds its whole count only
// when EVERY probe that day meets criterion; one below-criterion probe that day
// resets the run, whichever was entered first. A ⊘ (no-data) PAUSES the run (it
// is simply not a scored probe, so it neither counts nor resets); a
// denominator-mismatched point is EXCLUDED from the window unless the teacher
// elects it "counted" (F-2, flagged off-basis), and a criterion/denominator-model
// change CLAMPS the run first (hard, non-electable). Mastery is only OBSERVED
// here — the window being met flags a candidate for the ARC; the app never
// closes/retires the goal.

import type {
  IEPGoal,
  IsoDate,
  MasteryObservation,
  OpaqueId,
  ProgressDataPoint,
} from "@teacher-assistant/schema";
import { newOpaqueId } from "@teacher-assistant/schema";
import { compareArcOldestFirst } from "./comparators.js";
import { inComputedMath, isCountedOffBasis, isUnresolvedMismatch } from "./mismatch.js";
import { clampAfterFromRevisions } from "./quarterly.js";
import { percentCorrect } from "./value.js";

/**
 * One glyph in the recent-window glance (design R3 D2): a single scored probe from
 * the CLAMPED, disposition-aware window the run is computed over. The UI renders
 * these verbatim (● when `meets`, ○ otherwise; an off-basis ring when `offBasis`)
 * and re-derives NOTHING — so the glance can never blend pre/post-clamp probes or
 * re-classify criterion the way a UI-side `value >= criterion_level` slice would.
 */
export interface ConsistencyGlyph {
  /** The source probe's opaque id — a stable, unique identity for rendering. */
  readonly dataPointId: OpaqueId;
  /** The probe meets the criterion level (engine-classified, %-model). */
  readonly meets: boolean;
  /** A teacher-counted off-basis (denominator-mismatch) probe — flagged like the chart ring. */
  readonly offBasis: boolean;
  /**
   * This probe's admin date has both a met and a not-met probe in the window (so
   * the whole day reset the run). Data only — the UI does not render it yet.
   */
  readonly sameDayMixed: boolean;
}

export interface ConsistencyResult {
  /** Length of the current trailing run of consecutive scored probes meeting criterion. */
  readonly run: number;
  /** Required consecutive probes (goal.criterion_consistency.n_probes). */
  readonly required: number;
  readonly met: boolean;
  /**
   * The trailing `required` probes of the CLAMPED, in-computed-math window (oldest
   * → newest), each carrying its own `meets` + `offBasis` — the authoritative glance
   * the UI paints. Fewer than `required` when the (post-clamp) history is shorter.
   */
  readonly recentGlyphs: readonly ConsistencyGlyph[];
  /**
   * Admin date at which the window was FIRST-EVER satisfied (independent of the
   * current run — a later below-criterion probe can reset `run`/`met` while this
   * stays set). Consumers deciding mastery must check `met`, not this alone.
   */
  readonly windowMetDate?: ProgressDataPoint["admin_date"];
  /**
   * Count of mismatched points NOT in the run — resolved-excluded PLUS pending
   * (surfaced, never silently dropped). `unresolvedMismatches` is the pending subset.
   */
  readonly excludedMismatches: number;
  /** Mismatched points the teacher elected "counted" — IN the run, flagged off-basis. */
  readonly countedOffBasis: number;
  /** Mismatched points with no disposition yet — out of the run, surfaced as UNRESOLVED. */
  readonly unresolvedMismatches: number;
}

/**
 * Scored points for a goal that participate in the window, in the shared
 * oldest-first order (admin date, then entry time, then id):
 * CLAMPED FIRST at a criterion/denominator-model change (hard, non-electable),
 * then a mismatched point is kept only if the teacher elected it "counted"
 * (`inComputedMath`). A ⊘ never appears here (only scored probes).
 */
function scoredProbesInOrder(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
  clampAfter: IsoDate | undefined,
): ProgressDataPoint[] {
  return points
    .filter(
      (p) =>
        p.goal_id === goal.goal_id &&
        p.state === "scored" &&
        (clampAfter === undefined || p.admin_date >= clampAfter) &&
        inComputedMath(p),
    )
    .sort(compareArcOldestFirst);
}

/** One admin date's scored probes: how many there are and how many meet criterion. */
interface ProbeDay {
  readonly date: IsoDate;
  readonly count: number;
  readonly meets: number;
}

/** Collapse oldest-first probes into consecutive admin-date groups (the run's unit). */
function groupByAdminDate(
  probes: readonly ProgressDataPoint[],
  meets: (p: ProgressDataPoint) => boolean,
): ProbeDay[] {
  const days: ProbeDay[] = [];
  for (const p of probes) {
    const last = days[days.length - 1];
    const hit = meets(p) ? 1 : 0;
    if (last !== undefined && last.date === p.admin_date) {
      days[days.length - 1] = { date: last.date, count: last.count + 1, meets: last.meets + hit };
    } else {
      days.push({ date: p.admin_date, count: 1, meets: hit });
    }
  }
  return days;
}

// MVP is %-only (design C1); the consistency window compares each probe's percent
// to criterion_level. A non-% model is out of MVP scope and has no defined window.
function meetsCriterion(goal: IEPGoal, p: ProgressDataPoint): boolean {
  return percentCorrect(p.numerator ?? 0, p.denominator_used ?? 0) >= goal.criterion_level;
}

/**
 * The consistency window for a goal: the current consecutive run of scored probes
 * meeting the criterion level, grouped by admin date. A day whose probes ALL meet
 * criterion adds its count; a day with ANY below-criterion probe resets the run to
 * 0 (its passing probes do not start a new run). A ⊘ never appears here (only
 * scored probes), so it pauses rather than breaks; mismatched points are excluded
 * (and counted).
 */
export function consistencyWindow(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
): ConsistencyResult {
  const required = goal.criterion_consistency.n_probes;
  // MVP is %-only (design C1). The %-vs-criterion window is defined ONLY for the
  // percent model; a non-% goal (rubric/count/duration) gets no coerced window —
  // it never reports met / a mastery candidate (its window is out of MVP scope).
  if (goal.denominator_model !== "percent_correct_over_total") {
    return {
      run: 0,
      required,
      met: false,
      recentGlyphs: [],
      excludedMismatches: 0,
      countedOffBasis: 0,
      unresolvedMismatches: 0,
    };
  }
  // Clamp FIRST (hard, non-electable), then the disposition decides survivors.
  const clampAfter = clampAfterFromRevisions(goal);
  const probes = scoredProbesInOrder(goal, points, clampAfter);
  const days = groupByAdminDate(probes, (p) => meetsCriterion(goal, p));
  const mixedDays = new Set(
    days.filter((d) => d.meets > 0 && d.meets < d.count).map((d) => d.date),
  );
  // The glance: the trailing `required` probes of exactly this clamped window, each
  // engine-classified. The UI paints these — it never slices the raw trend or
  // re-tests the criterion (which would blend across the clamp boundary, R3 DM-1).
  const recentGlyphs: ConsistencyGlyph[] = probes
    .slice(Math.max(0, probes.length - required))
    .map((p) => ({
      dataPointId: p.data_point_id,
      meets: meetsCriterion(goal, p),
      offBasis: isCountedOffBasis(p),
      sameDayMixed: mixedDays.has(p.admin_date),
    }));
  // Mismatch counts are scoped to the clamped region (a mismatched point before
  // the model-change boundary is dropped by the clamp, not surfaced here).
  const clampedScored = points.filter(
    (p) =>
      p.goal_id === goal.goal_id &&
      p.state === "scored" &&
      (clampAfter === undefined || p.admin_date >= clampAfter),
  );
  const countedOffBasis = clampedScored.filter(isCountedOffBasis).length;
  const unresolvedMismatches = clampedScored.filter(isUnresolvedMismatch).length;
  // "Not counted" = a mismatched point that is excluded or still pending — exactly
  // the complement of inComputedMath (a clean point is always in the math).
  const excludedMismatches = clampedScored.filter((p) => !inComputedMath(p)).length;

  let run = 0;
  let windowMetDate: ProgressDataPoint["admin_date"] | undefined;
  for (const day of days) {
    run = day.meets === day.count ? run + day.count : 0;
    if (run >= required && windowMetDate === undefined) {
      windowMetDate = day.date; // first day the window was satisfied
    }
  }

  return {
    run,
    required,
    met: run >= required,
    recentGlyphs,
    excludedMismatches,
    countedOffBasis,
    unresolvedMismatches,
    ...(windowMetDate !== undefined ? { windowMetDate } : {}),
  };
}

/** An app-observed mastery candidate — the window is met, flagged for ARC review. Never closes the goal. */
export interface MasteryCandidate {
  readonly goalId: OpaqueId;
  readonly windowMetDate: ProgressDataPoint["admin_date"];
}

/**
 * Observe (never decide) mastery: returns a candidate iff the consistency window
 * is met. The app OBSERVES; the teacher/ARC closes the goal — this never mutates
 * goal status.
 */
export function observeMastery(
  goal: IEPGoal,
  points: readonly ProgressDataPoint[],
): MasteryCandidate | null {
  const result = consistencyWindow(goal, points);
  if (!result.met || result.windowMetDate === undefined) {
    return null;
  }
  return { goalId: goal.goal_id, windowMetDate: result.windowMetDate };
}

/**
 * Teacher acknowledgement of an observed window → a MasteryObservation flagged for
 * ARC. This records the observation; it does NOT transition the goal to mastered
 * (that is an ARC action).
 */
export function acknowledgeMastery(candidate: MasteryCandidate): MasteryObservation {
  return {
    observation_id: newOpaqueId(),
    goal_id: candidate.goalId,
    window_met_date: candidate.windowMetDate,
    acknowledged_by: "teacher",
    flagged_for_arc: true,
  };
}
