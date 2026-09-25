// M8 — auto progress-statement + trend engine. Acceptance (phase1-spec §5, design
// §G R3-3). SYNTHETIC data only. Every expected figure is derived by hand here,
// independently of the implementation.

import {
  asTimestamp,
  type AccomMod,
  type DenominatorModel,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { computeAutoStatement, conditionPhrase, isoWeekId } from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;
const noBreaks = () => false;

function makeGoal(
  over?: Partial<{
    status: GoalStatus;
    accomMod: AccomMod;
    denominatorModel: DenominatorModel;
    baselineValue: number;
    criterionLevel: number;
    iepEnd: IsoDate;
    circumstance: string;
  }>,
): IEPGoal {
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "solve two-step equations",
    behavior: "b",
    circumstance: over?.circumstance ?? "given a grade-level equations probe",
    criterion_level: over?.criterionLevel ?? 80,
    criterion_consistency: { n_probes: 4, phrase: "4 of 5 consecutive probes" },
    method_general: "cbm",
    method_tool: "probe",
    frequency: "weekly",
    denominator_model: over?.denominatorModel ?? "percent_correct_over_total",
    baseline_value: over?.baselineValue ?? 50,
    baseline_source: "computed_from_baseline_points",
    accom_mod: over?.accomMod ?? "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: over?.status ?? "active",
    created_ts: asTimestamp(0),
    revisions: [],
    ...(over?.iepEnd !== undefined
      ? { iep_end_date: over.iepEnd }
      : { iep_end_date: iso("2027-05-29") }),
  };
}

/** A scored % point: numerator IS the percent (denominator 100) — synthetic, keeps the math legible. */
function scored(goal: IEPGoal, adminDate: string, percent: number): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso(adminDate),
    entry_ts: asTimestamp(0),
    state: "scored",
    numerator: percent,
    denominator_used: 100,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

// Eight weekly Mondays → eight distinct ISO weeks (≥4-week gate passes with no breaks).
const WEEKLY = [
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
];

function series(goal: IEPGoal, percents: readonly number[]): ProgressDataPoint[] {
  return percents.map((pct, i) => scored(goal, WEEKLY[i] ?? "2026-11-02", pct));
}

describe("structural FERPA guard — statement is incapable for proposed/baseline/non-% goals", () => {
  it("a proposed goal yields NO statement (null)", () => {
    const goal = makeGoal({ status: "proposed" });
    expect(
      computeAutoStatement(goal, "AB", series(goal, [52, 56, 60, 64, 68, 72, 76, 80]), {
        isNonInstructional: noBreaks,
      }),
    ).toBeNull();
  });

  it("a non-% (rubric) goal yields NO statement (null) — no %↔rubric coercion", () => {
    const goal = makeGoal({ denominatorModel: "rubric_score" });
    expect(
      computeAutoStatement(goal, "AB", series(goal, [52, 56, 60, 64, 68, 72, 76, 80]), {
        isNonInstructional: noBreaks,
      }),
    ).toBeNull();
  });
});

describe("ON-TREND variant (§G R3-3)", () => {
  // y = 52,56,60,64,68,72,76,80 at x = 0,7,…,49 (weekly). Monotone rise, slope > 0,
  // projects far above 80 at the 2027-05-29 horizon → trend on-track. Last four
  // (68,72,76,80) sit far above the baseline-anchored aim line → four-point "above".
  // F4 most-recent-5 = 64,68,72,76,80 → avg 72. Prior five (here the earlier three)
  // = 52,56,60 → avg 56. delta_baseline = 72−50 = 22. delta_prior = 72−56 = 16.
  const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
  const stmt = computeAutoStatement(goal, "AB", series(goal, [52, 56, 60, 64, 68, 72, 76, 80]), {
    isNonInstructional: noBreaks,
  });

  it("is on_track with the exact §G R3-3 wording and hand-derived figures", () => {
    expect(stmt).not.toBeNull();
    if (stmt === null) return;
    expect(stmt.variant).toBe("on_track");
    expect(stmt.onTrack).toBe(true);
    expect(stmt.slots.avgRecent).toBe(72);
    expect(stmt.slots.nUsed).toBe(5);
    expect(stmt.slots.priorPeriodAvg).toBe(56);
    expect(stmt.slots.deltaBaseline).toBe(22); // percentage-POINT subtraction, not relative %
    expect(stmt.slots.deltaPrior).toBe(16);
    expect(stmt.slots.totalPoints).toBe(8);
    expect(stmt.text).toContain(
      "According to the 5 most recent data points (2026-09-28 to 2026-10-26), AB is averaging 72% accuracy on solve two-step equations, given a grade-level equations probe.",
    );
    expect(stmt.text).toContain(
      "This is a 22-point increase from the baseline of 50% and a 16-point increase from the previous reporting period (56%).",
    );
    expect(stmt.text).toContain(
      "is on track to meet the goal criterion of 80% (4 of 5 consecutive probes) by the end of the IEP period (2027-05-29).",
    );
    expect(stmt.label).toBe("Draft progress statement — review before copying to IC");
  });

  it("never makes an absolute promise or names a predicted mastery date", () => {
    if (stmt === null) throw new Error("unreachable");
    expect(stmt.text).not.toContain("will meet the goal");
    expect(stmt.text.toLowerCase()).toContain("on track"); // defensible projection, not a guarantee
  });
});

describe("NOT-ON-TREND variant (§G R3-3)", () => {
  // Flat-low near baseline: trend projects well below 80; last four below the aim line.
  const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
  const stmt = computeAutoStatement(goal, "CD", series(goal, [48, 50, 47, 49, 46, 48, 45, 47]), {
    isNonInstructional: noBreaks,
  });

  it("is not_on_track with the adjusted-SDI closing and no mastery guarantee", () => {
    expect(stmt).not.toBeNull();
    if (stmt === null) return;
    expect(stmt.variant).toBe("not_on_track");
    expect(stmt.onTrack).toBe(false);
    expect(stmt.text).toContain(
      "is not yet on track to meet the goal criterion of 80% by 2027-05-29",
    );
    expect(stmt.text).toContain("specially designed instruction");
    expect(stmt.text).not.toContain("will meet the goal");
  });
});

describe("HARD sufficiency gate → INDETERMINATE (§G R3-3)", () => {
  it("fewer than 8 scored points is ALWAYS indeterminate — no trend claim", () => {
    const goal = makeGoal();
    const stmt = computeAutoStatement(goal, "EF", series(goal, [60, 64, 68, 72, 76, 80, 82]), {
      isNonInstructional: noBreaks,
    });
    expect(stmt?.variant).toBe("indeterminate");
    expect(stmt?.indeterminateReason).toBe("below_point_gate");
    expect(stmt?.onTrack).toBeNull();
    expect(stmt?.text).not.toContain("on track");
    expect(stmt?.text).toContain(
      "additional data are needed to establish a reliable trend toward 80%",
    );
  });

  it("8 points but fewer than 4 INSTRUCTIONAL weeks is indeterminate", () => {
    const goal = makeGoal();
    // 8 points clustered in 3 ISO weeks (2026-W37/W38/W39) → week gate fails.
    const dates = [
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-21",
      "2026-09-22",
    ];
    const pts = dates.map((d, i) => scored(goal, d, 60 + i));
    const stmt = computeAutoStatement(goal, "GH", pts, { isNonInstructional: noBreaks });
    expect(stmt?.variant).toBe("indeterminate");
    expect(stmt?.indeterminateReason).toBe("below_week_gate");
    expect(stmt?.text).not.toContain("on track");
  });

  it("DF-3: the descriptive accom/mod detail NEVER enters the statement (category drives it, slot-only)", () => {
    // The teacher-authored `accom_mod_detail` free text must not leak into the M8
    // narrative (FERPA: slot-only). The condition phrase is driven by the CATEGORY.
    const goal: IEPGoal = {
      ...makeGoal({ accomMod: "accommodation" }),
      accom_mod_detail: "read-aloud SECRETPHRASE with extended time",
    };
    const stmt = computeAutoStatement(goal, "AB", series(goal, [52, 56, 60, 64, 68, 72, 76, 80]), {
      isNonInstructional: noBreaks,
    });
    expect(stmt?.text).toContain("with accommodations"); // category → condition phrase
    expect(stmt?.text).not.toContain("SECRETPHRASE"); // the descriptive detail is never narrated
  });

  it("DM-2: the ≥4-week gate CONSUMES the instructional-weeks calendar (break weeks excluded)", () => {
    // The SAME 8-point on-track series: with no breaks it clears the week gate...
    const goal = makeGoal();
    const pts = series(goal, [52, 56, 60, 64, 68, 72, 76, 80]);
    expect(computeAutoStatement(goal, "AB", pts, { isNonInstructional: noBreaks })?.variant).toBe(
      "on_track",
    );
    // ...but marking all but the first three monitored ISO weeks as calendar breaks
    // leaves only 3 instructional weeks (< 4), so the gate MUST fall to INDETERMINATE.
    // This proves the projection reads the calendar rather than counting every week —
    // a `() => false` default (every week instructional) would wrongly keep it on_track.
    const instructional = new Set(WEEKLY.slice(0, 3).map((d) => isoWeekId(d)));
    const withBreaks = computeAutoStatement(goal, "AB", pts, {
      isNonInstructional: (w) => !instructional.has(w),
    });
    expect(withBreaks?.variant).toBe("indeterminate");
    expect(withBreaks?.indeterminateReason).toBe("below_week_gate");
  });
});

describe("four-point noise cross-check → INDETERMINATE (§G R3-3)", () => {
  it("last four straddling the aim line is indeterminate (too noisy to claim)", () => {
    const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
    // Last four = 40,75,45,70 → some below, some above the aim line → straddle.
    const stmt = computeAutoStatement(goal, "IJ", series(goal, [52, 56, 60, 64, 40, 75, 45, 70]), {
      isNonInstructional: noBreaks,
    });
    expect(stmt?.variant).toBe("indeterminate");
    expect(stmt?.indeterminateReason).toBe("fourpoint_straddle");
  });

  it("trend and four-point disagreeing is indeterminate", () => {
    const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
    // Flat at 60: four-point reads "above" the (low, baseline-anchored) aim line,
    // but the zero-slope trend projects 60 < 80 → the two disagree.
    const stmt = computeAutoStatement(goal, "KL", series(goal, [60, 60, 60, 60, 60, 60, 60, 60]), {
      isNonInstructional: noBreaks,
    });
    expect(stmt?.variant).toBe("indeterminate");
    expect(stmt?.indeterminateReason).toBe("trend_fourpoint_disagree");
  });
});

describe("mismatched points excluded; sub-gate after exclusion is indeterminate", () => {
  it("denominator-mismatched points are excluded from the trend and surfaced", () => {
    const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
    const pts = series(goal, [52, 56, 60, 64, 68, 72, 76, 80]);
    // Flip one point to a denominator mismatch — it must leave the comparable set (7 < 8).
    const flagged = pts[3];
    if (flagged !== undefined) {
      pts[3] = { ...flagged, denominator_mismatch: true };
    }
    const stmt = computeAutoStatement(goal, "MN", pts, { isNonInstructional: noBreaks });
    expect(stmt?.excludedMismatches).toBe(1);
    expect(stmt?.slots.totalPoints).toBe(7);
    expect(stmt?.variant).toBe("indeterminate");
    expect(stmt?.indeterminateReason).toBe("insufficient_after_exclusion");
  });
});

describe("condition_phrase derives from circumstance + accom/mod — NEVER 'independently'", () => {
  it("a modification goal is never described as independent", () => {
    const goal = makeGoal({
      accomMod: "modification",
      circumstance: "given a modified equations probe",
    });
    expect(conditionPhrase(goal)).toBe("given a modified equations probe, with modifications");
    expect(conditionPhrase(goal).toLowerCase()).not.toContain("independently");
    const stmt = computeAutoStatement(goal, "OP", series(goal, [52, 56, 60, 64, 68, 72, 76, 80]), {
      isNonInstructional: noBreaks,
    });
    expect(stmt?.text.toLowerCase()).not.toContain("independently");
    expect(stmt?.text).toContain("with modifications");
  });

  it("an accommodation goal reads 'with accommodations'; a 'none' goal adds no posture word", () => {
    const accom = makeGoal({ accomMod: "accommodation", circumstance: "given an equations probe" });
    expect(conditionPhrase(accom)).toBe("given an equations probe, with accommodations");
    const none = makeGoal({ accomMod: "none", circumstance: "given an equations probe" });
    expect(conditionPhrase(none)).toBe("given an equations probe");
    expect(conditionPhrase(none).toLowerCase()).not.toContain("independently");
  });
});

describe("no averaging across a criterion / denominator change (reuse of the M6a clamp)", () => {
  it("clamps the window at a criterion-level change and flags it", () => {
    const goal: IEPGoal = {
      ...makeGoal({ baselineValue: 50, criterionLevel: 80 }),
      // A criterion change on 2026-10-05 — points before it must not blend in.
      revisions: [
        {
          who: "arc",
          when: asTimestamp(Date.parse("2026-10-05T00:00:00Z")),
          old: { criterion_level: 70 },
          new: { criterion_level: 80 },
        },
      ],
    };
    const stmt = computeAutoStatement(goal, "QR", series(goal, [52, 56, 60, 64, 68, 72, 76, 80]), {
      isNonInstructional: noBreaks,
    });
    expect(stmt?.clampedAtChange).toBe(true);
    // Only points on/after 2026-10-05 remain: 68,72,76,80 → 4 < 8 → indeterminate.
    expect(stmt?.slots.totalPoints).toBe(4);
    expect(stmt?.variant).toBe("indeterminate");
  });
});

// Thirteen weekly Mondays → thirteen distinct ISO weeks, to exercise the prior-period
// window when there are well more than 8 comparable points.
const THIRTEEN_WEEKLY = [
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
  "2026-11-02",
  "2026-11-09",
  "2026-11-16",
  "2026-11-23",
  "2026-11-30",
];

describe("prior reporting period with > 8 comparable points (full 5-point windows)", () => {
  it("averages the most-recent 5 and the 5 immediately before it, with no overlap", () => {
    const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
    // y = 40,44,…,88. F4 window = last 5 (72,76,80,84,88) → avg 80. Prior 5 = the five
    // BEFORE that (52,56,60,64,68) → avg 60. Neither window touches the other.
    const pts = THIRTEEN_WEEKLY.map((d, i) => scored(goal, d, 40 + i * 4));
    const stmt = computeAutoStatement(goal, "ST", pts, { isNonInstructional: noBreaks });
    expect(stmt?.slots.nUsed).toBe(5);
    expect(stmt?.slots.avgRecent).toBe(80);
    expect(stmt?.slots.priorPeriodAvg).toBe(60);
    expect(stmt?.slots.totalPoints).toBe(13);
    expect(stmt?.slots.deltaPrior).toBe(20); // 80 − 60
    expect(stmt?.variant).toBe("on_track");
  });
});

describe("no scored data → INDETERMINATE with the no-data wording (no fabricated average)", () => {
  it("emits the no-scored-data statement and no averaging sentence", () => {
    const goal = makeGoal();
    const noData: ProgressDataPoint[] = THIRTEEN_WEEKLY.slice(0, 5).map((d) => ({
      data_point_id: newOpaqueId(),
      goal_id: goal.goal_id,
      student_id: goal.student_id,
      admin_date: iso(d),
      entry_ts: asTimestamp(0),
      state: "no_data",
      no_data_reason: "absent",
      setting: "math_resource",
      scorer: "teacher",
      revisions: [],
    }));
    const stmt = computeAutoStatement(goal, "UV", noData, { isNonInstructional: noBreaks });
    expect(stmt?.variant).toBe("indeterminate");
    expect(stmt?.indeterminateReason).toBe("no_scored_data");
    expect(stmt?.slots.avgRecent).toBeNull();
    expect(stmt?.text).toContain("No scored data points have been collected this period");
    expect(stmt?.text).not.toContain("averaging");
  });
});

describe("condition-mismatched points are excluded from BOTH the displayed average and the trend", () => {
  it("a different-condition outlier does not pollute avg_recent, and is surfaced", () => {
    const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
    const condA = newOpaqueId();
    const condB = newOpaqueId();
    // Eight clean, on-condition points (52..80) → avg_recent 72, on-track.
    const clean = WEEKLY.map((d, i) => ({
      ...scored(goal, d, 52 + i * 4),
      probe_condition_id: condA,
    }));
    // One most-recent OFF-condition outlier (5%) — must not touch the average or the trend.
    const outlier = { ...scored(goal, "2026-11-02", 5), probe_condition_id: condB };
    const stmt = computeAutoStatement(goal, "WX", [...clean, outlier], {
      isNonInstructional: noBreaks,
      expectedConditionId: condA,
    });
    expect(stmt?.excludedMismatches).toBe(1);
    expect(stmt?.slots.avgRecent).toBe(72); // the 5% outlier is excluded from display
    expect(stmt?.slots.totalPoints).toBe(8); // …and from the trend
    expect(stmt?.variant).toBe("on_track");
  });
});

describe("a counted mismatch in the last 5 does not shift the prior-period boundary (TEACH-30)", () => {
  // Clean W1–W8 = 50,55,…,85. F4 window = last 5 clean (65,70,75,80,85) → avg 75.
  // Prior = the clean points before it (50,55,60) → avg 55. delta_prior = 75 − 55 = 20.
  // C = 100 is denominator-mismatched with a "counted" disposition: M8 hard-excludes it
  // from both windows, so any leak would move avgRecent or priorPeriodAvg off 75/55.
  it.each([
    ["between W6 and W7 (inside the recent window)", "2026-10-15"],
    ["between W2 and W3 (inside the prior window)", "2026-09-17"],
  ])("C dated %s", (_label, cDate) => {
    const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
    const clean = series(goal, [50, 55, 60, 65, 70, 75, 80, 85]);
    const counted: ProgressDataPoint = {
      ...scored(goal, cDate, 100),
      denominator_mismatch: true,
      mismatch_window_disposition: "counted",
    };
    const stmt = computeAutoStatement(goal, "YZ", [...clean, counted], {
      isNonInstructional: noBreaks,
    });
    expect(stmt).not.toBeNull();
    if (stmt === null) return;
    expect(stmt.slots.nUsed).toBe(5);
    expect(stmt.slots.nUsed).toBe(Math.min(5, stmt.slots.totalPoints));
    expect(stmt.slots.avgRecent).toBe(75);
    expect(stmt.slots.priorPeriodAvg).toBe(55);
    expect(stmt.slots.deltaPrior).toBe(20);
    expect(stmt.slots.totalPoints).toBe(8);
    expect(stmt.excludedMismatches).toBe(1);
  });
});

describe("the F4 window is the tail of the comparable points (prior window = the 5 before it)", () => {
  // Clean y_i = 40 + 4i at weekly dates. For len points: nUsed = min(5, len); the prior
  // window is indices [max(0, len−10), len−5), empty (null) when len ≤ 5. The mean of
  // y over indices a..b−1 is 40 + 2(a + b − 1), always an integer here.
  it.each(Array.from({ length: 11 }, (_, len) => len))("len = %i", (len) => {
    const goal = makeGoal({ baselineValue: 50, criterionLevel: 80 });
    const pts = THIRTEEN_WEEKLY.slice(0, len).map((d, i) => scored(goal, d, 40 + i * 4));
    const stmt = computeAutoStatement(goal, "ST", pts, { isNonInstructional: noBreaks });
    expect(stmt).not.toBeNull();
    if (stmt === null) return;
    expect(stmt.slots.totalPoints).toBe(len);
    expect(stmt.slots.nUsed).toBe(Math.min(5, len));
    const a = Math.max(0, len - 10);
    const b = len - 5;
    expect(stmt.slots.priorPeriodAvg).toBe(b <= 0 ? null : 40 + 2 * (a + b - 1));
  });
});
