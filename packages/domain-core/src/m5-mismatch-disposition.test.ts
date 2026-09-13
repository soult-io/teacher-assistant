// F-2 — teacher-elected denominator-mismatch disposition (design §B). A
// mismatched scored point keeps denominator_mismatch=true; the SEPARATE
// mismatch_window_disposition ("counted" | "excluded" | absent=pending) decides
// what the consistency window + F4 quarterly + goal-detail trend do with it. The
// M8 auto-statement HARD-excludes every mismatched point regardless.

import {
  asTimestamp,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type ProgressDataPoint,
  type Revision,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  applyEdit,
  buildGoalDetail,
  captureScoredPoint,
  computeAutoStatement,
  computeQuarterlySummary,
  consistencyWindow,
  inComputedMath,
  isCountedOffBasis,
  isResolvedExcluded,
  isUnresolvedMismatch,
} from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;
const noBreaks = () => false;

function makeGoal(over: Partial<IEPGoal> = {}): IEPGoal {
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "solve two-step equations",
    behavior: "b",
    circumstance: "given a 5-item probe",
    criterion_level: 80,
    criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "5-item probe",
    frequency: "weekly",
    denominator_model: "percent_correct_over_total",
    baseline_value: 50,
    baseline_source: "computed_from_baseline_points",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: "active",
    created_ts: asTimestamp(0),
    iep_end_date: iso("2027-05-29"),
    revisions: [],
    ...over,
  };
}

/** A scored % point (numerator IS the percent, denominator 100). */
function pt(
  goal: IEPGoal,
  date: string,
  percent: number,
  over: Partial<ProgressDataPoint> = {},
): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso(date),
    entry_ts: asTimestamp(0),
    state: "scored",
    numerator: percent,
    denominator_used: 100,
    computed_value: percent / 100,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
    ...over,
  };
}

const MISMATCH = { denominator_mismatch: true, denominator_original: 90 } as const;
const counted: Partial<ProgressDataPoint> = {
  ...MISMATCH,
  mismatch_acknowledged: true,
  mismatch_window_disposition: "counted",
};
const excluded: Partial<ProgressDataPoint> = {
  ...MISMATCH,
  mismatch_acknowledged: true,
  mismatch_window_disposition: "excluded",
};
const pending: Partial<ProgressDataPoint> = { ...MISMATCH }; // no disposition

describe("captureScoredPoint — F-2 election", () => {
  const base = {
    goalId: newOpaqueId(),
    studentId: newOpaqueId(),
    adminDate: iso("2026-09-14"),
    entryTs: asTimestamp(0),
    setting: "math_resource",
    scorer: "teacher",
  } as const;

  it("stores the ack + disposition on a genuine mismatch", () => {
    const p = captureScoredPoint({
      ...base,
      numerator: 5,
      denominatorUsed: 6,
      expectedDenominator: 5,
      mismatchAcknowledged: true,
      mismatchWindowDisposition: "counted",
    });
    expect(p.denominator_mismatch).toBe(true);
    expect(p.mismatch_acknowledged).toBe(true);
    expect(p.mismatch_window_disposition).toBe("counted");
  });

  it("ignores a disposition when there is no actual mismatch", () => {
    const p = captureScoredPoint({
      ...base,
      numerator: 5,
      denominatorUsed: 5,
      expectedDenominator: 5,
      mismatchWindowDisposition: "counted",
    });
    expect(p.denominator_mismatch).toBe(false);
    expect(p.mismatch_window_disposition).toBeUndefined();
  });

  it("leaves a mismatch pending when no disposition is chosen", () => {
    const p = captureScoredPoint({
      ...base,
      numerator: 5,
      denominatorUsed: 6,
      expectedDenominator: 5,
    });
    expect(p.denominator_mismatch).toBe(true);
    expect(p.mismatch_window_disposition).toBeUndefined();
    expect(p.mismatch_acknowledged).toBeUndefined();
  });
});

describe("mismatch disposition predicates", () => {
  const goal = makeGoal();
  it("classify each state", () => {
    expect(isCountedOffBasis(pt(goal, "2026-09-01", 84, counted))).toBe(true);
    expect(isResolvedExcluded(pt(goal, "2026-09-01", 84, excluded))).toBe(true);
    expect(isUnresolvedMismatch(pt(goal, "2026-09-01", 84, pending))).toBe(true);
    // In-math = clean OR counted; excluded + pending are out.
    expect(inComputedMath(pt(goal, "2026-09-01", 84, counted))).toBe(true);
    expect(inComputedMath(pt(goal, "2026-09-01", 84))).toBe(true); // clean
    expect(inComputedMath(pt(goal, "2026-09-01", 84, excluded))).toBe(false);
    expect(inComputedMath(pt(goal, "2026-09-01", 84, pending))).toBe(false);
  });
});

describe("REQUIRED-1: a pending mismatch is never silently counted nor silently hidden", () => {
  const goal = makeGoal();
  const points = [
    pt(goal, "2026-09-07", 90), // clean ≥80
    pt(goal, "2026-09-14", 88), // clean ≥80
    pt(goal, "2026-09-21", 84, pending), // mismatch, no disposition
  ];

  it("consistency: out of the run, surfaced unresolved", () => {
    const r = consistencyWindow(goal, points);
    expect(r.run).toBe(2); // only the two clean points
    expect(r.countedOffBasis).toBe(0);
    expect(r.unresolvedMismatches).toBe(1); // surfaced, not hidden
    expect(r.excludedMismatches).toBe(1); // not-counted total
  });

  it("quarterly: not averaged, surfaced unresolved", () => {
    const q = computeQuarterlySummary(goal, points);
    expect(q.n).toBe(2); // pending not averaged
    expect(q.countedOffBasis).toBe(0);
    expect(q.unresolvedMismatches).toBe(1);
  });

  it("goal-detail: not plotted (stays in the raw points/history)", () => {
    const detail = buildGoalDetail(goal, points);
    expect(detail.trend).toHaveLength(2); // pending mismatch not plotted
    expect(detail.trend.every((t) => t.offBasis === false)).toBe(true);
  });
});

describe("REQUIRED-2: a counted point does NOT clear the M8 ≥8 gate or enter the projection", () => {
  const goal = makeGoal();
  // 7 clean weekly points + 1 counted mismatch = 8 in-math for the window, but
  // only 7 comparable for the M8 statement (it hard-excludes the mismatch).
  const weeks = ["09-07", "09-14", "09-21", "09-28", "10-05", "10-12", "10-19"];
  const clean = weeks.map((d, i) => pt(goal, `2026-${d}`, 82 + i));
  const withCounted = [...clean, pt(goal, "2026-10-26", 84, counted)];

  it("auto-statement stays INDETERMINATE (7 comparable < 8), counted excluded", () => {
    const stmt = computeAutoStatement(goal, "AB", withCounted, { isNonInstructional: noBreaks });
    expect(stmt?.variant).toBe("indeterminate");
  });

  it("but 8 CLEAN points DO clear the gate (proves the counted point was the difference)", () => {
    const eightClean = [...clean, pt(goal, "2026-10-26", 84)];
    const stmt = computeAutoStatement(goal, "AB", eightClean, { isNonInstructional: noBreaks });
    expect(stmt?.variant).not.toBe("indeterminate");
  });

  it("the SAME counted point IS in the consistency + quarterly math", () => {
    expect(consistencyWindow(goal, withCounted).countedOffBasis).toBe(1);
    expect(computeQuarterlySummary(goal, withCounted).countedOffBasis).toBe(1);
  });

  it("M8's DISPLAYED average also hard-excludes the counted point (§G R3-3 step 4)", () => {
    // 8 clean points all at 80, plus a most-recent COUNTED point at 100.
    const clean80 = ["09-07", "09-14", "09-21", "09-28", "10-05", "10-12", "10-19", "10-26"].map(
      (d) => pt(goal, `2026-${d}`, 80),
    );
    const points = [...clean80, pt(goal, "2026-11-02", 100, counted)];
    const stmt = computeAutoStatement(goal, "AB", points, { isNonInstructional: noBreaks });
    expect(stmt?.variant).not.toBe("indeterminate"); // 8 clean clear the gate
    // The F4 window is the 5 most-recent CLEAN points (all 80) — the counted 100
    // is NOT blended in (would be 84 if it were).
    expect(stmt?.slots.avgRecent).toBe(80);
  });
});

describe("REQUIRED-3: clamp runs BEFORE disposition (a counted point across a model change is still dropped)", () => {
  const changeTs = asTimestamp(new Date("2026-09-15T00:00:00Z").getTime());
  const rev: Revision = {
    who: "teacher",
    when: changeTs,
    old: { criterion_level: 70 },
    new: { criterion_level: 80 },
  };
  const goal = makeGoal({ revisions: [rev] }); // clampAfter = 2026-09-15
  const points = [
    pt(goal, "2026-09-01", 95, counted), // COUNTED but BEFORE the clamp boundary
    pt(goal, "2026-09-22", 90), // after the boundary, clean
    pt(goal, "2026-09-29", 88), // after the boundary, clean
  ];

  it("consistency: the pre-change counted point is clamped out (hard wins over election)", () => {
    const r = consistencyWindow(goal, points);
    expect(r.run).toBe(2); // only the two post-change clean points
    expect(r.countedOffBasis).toBe(0); // the counted point is before the clamp → not surfaced in-window
  });

  it("quarterly: the pre-change counted point is not averaged", () => {
    const q = computeQuarterlySummary(goal, points, {
      clampAfter: iso("2026-09-15"),
    });
    expect(q.n).toBe(2);
    expect(q.countedOffBasis).toBe(0);
  });
});

describe("REQUIRED-4: the off-basis flag is non-strippable on a counted point", () => {
  const goal = makeGoal();
  const points = [
    pt(goal, "2026-09-07", 90),
    pt(goal, "2026-09-14", 84, counted), // in-math, off-basis
  ];

  it("consistency surfaces it as counted off-basis", () => {
    expect(consistencyWindow(goal, points).countedOffBasis).toBe(1);
  });

  it("quarterly flags the average as mixed with a counted off-basis point", () => {
    const q = computeQuarterlySummary(goal, points);
    expect(q.countedOffBasis).toBe(1);
    expect(q.mixedDenominator).toBe(true);
  });

  it("goal-detail plots it with offBasis=true", () => {
    const detail = buildGoalDetail(goal, points);
    const plotted = detail.trend.find((t) => t.adminDate === iso("2026-09-14"));
    expect(plotted?.offBasis).toBe(true);
  });
});

describe("an excluded point is out of the math but retained (audit)", () => {
  const goal = makeGoal();
  const points = [pt(goal, "2026-09-07", 90), pt(goal, "2026-09-14", 84, excluded)];

  it("not in the run/average/plot, but the original denominator is retained", () => {
    expect(consistencyWindow(goal, points).run).toBe(1);
    expect(computeQuarterlySummary(goal, points).n).toBe(1);
    expect(buildGoalDetail(goal, points).trend).toHaveLength(1);
    const kept = points[1];
    expect(kept?.denominator_original).toBe(90); // never overwritten — visible in audit
  });
});

describe("a corrective [Fix] that clears the mismatch drops the stale disposition", () => {
  it("applyEdit restoring the probe total clears counted/acknowledged", () => {
    const counted = captureScoredPoint({
      goalId: newOpaqueId(),
      studentId: newOpaqueId(),
      adminDate: iso("2026-09-14"),
      entryTs: asTimestamp(0),
      numerator: 5,
      denominatorUsed: 6,
      expectedDenominator: 5,
      mismatchWindowDisposition: "counted",
      setting: "math_resource",
      scorer: "teacher",
    });
    expect(counted.mismatch_window_disposition).toBe("counted");

    const fixed = applyEdit(counted, { denominator_used: 5 }, "teacher", asTimestamp(1));
    expect(fixed.denominator_mismatch).toBe(false); // mismatch resolved
    expect(fixed.mismatch_window_disposition).toBeUndefined(); // stale election dropped
    expect(fixed.mismatch_acknowledged).toBeUndefined();
  });
});
