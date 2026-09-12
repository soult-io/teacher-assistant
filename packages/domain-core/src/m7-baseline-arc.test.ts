// M7 — baseline / proposed-goal track + ARC/IEP dates. Acceptance (phase1-spec §3,
// design §F.F3 / §G R3-4). SYNTHETIC data only.

import {
  asTimestamp,
  type BaselinePoint,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type OpaqueId,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  adoptGoal,
  AdoptionError,
  baselineReminder,
  canAdopt,
  closeGoalByArc,
  computeBaselineWindowStart,
  deriveBaseline,
  editArcDate,
  isIcExportable,
  markArcDateConfirmed,
} from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;
const noBreaks = () => false;

function makeGoal(over?: Partial<{ status: GoalStatus; arcDate: IsoDate }>): IEPGoal {
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "synthetic",
    behavior: "b",
    circumstance: "c",
    criterion_level: 80,
    criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "probe",
    frequency: "weekly",
    denominator_model: "percent_correct_over_total",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: over?.status ?? "proposed",
    created_ts: asTimestamp(0),
    revisions: [],
    ...(over?.arcDate !== undefined ? { arc_date: over.arcDate } : {}),
  };
}

function baselinePoint(goal: IEPGoal, numerator: number, condition: OpaqueId): BaselinePoint {
  return {
    baseline_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso("2026-08-10"),
    entry_ts: asTimestamp(0),
    numerator,
    denominator_used: 10,
    probe_condition_id: condition,
    scorer: "teacher",
  };
}

describe("baseline derivation (§F.F3)", () => {
  it("is usable only at ≥3 comparable points; mean by default, median-of-3 offered; labeled estimate", () => {
    const goal = makeGoal();
    const cond = newOpaqueId();
    const three = [
      baselinePoint(goal, 4, cond),
      baselinePoint(goal, 9, cond),
      baselinePoint(goal, 8, cond),
    ];
    const mean = deriveBaseline(goal, three);
    expect(mean.usable).toBe(true);
    expect(mean.value).toBeCloseTo(70); // (40+90+80)/3
    expect(mean.label).toBe("estimate");
    const median = deriveBaseline(goal, three, "median");
    expect(median.value).toBeCloseTo(80); // median of 40,80,90

    const two = deriveBaseline(goal, three.slice(0, 2));
    expect(two.usable).toBe(false);
    expect(two.value).toBeNull();
  });

  it("mixed probe conditions are not comparable (unusable)", () => {
    const goal = makeGoal();
    const pts = [
      baselinePoint(goal, 8, newOpaqueId()),
      baselinePoint(goal, 8, newOpaqueId()),
      baselinePoint(goal, 8, newOpaqueId()),
    ];
    const est = deriveBaseline(goal, pts);
    expect(est.comparable).toBe(false);
    expect(est.usable).toBe(false);
  });
});

describe("ARC adoption locks the baseline + flips active (§2.5)", () => {
  const cond = newOpaqueId();
  function threePts(goal: IEPGoal): BaselinePoint[] {
    return [
      baselinePoint(goal, 4, cond),
      baselinePoint(goal, 9, cond),
      baselinePoint(goal, 8, cond),
    ];
  }

  it("a proposed goal with ≥3 comparable points adopts → active, baseline locked, audited", () => {
    const goal = makeGoal({ status: "proposed" });
    const pts = threePts(goal);
    expect(canAdopt(goal, pts).ok).toBe(true);
    const adopted = adoptGoal(goal, pts, { who: "arc", when: asTimestamp(100) });
    expect(adopted.status).toBe("active");
    expect(adopted.baseline_value).toBeCloseTo(70);
    expect(adopted.baseline_source).toBe("computed_from_baseline_points");
    expect(adopted.revisions).toHaveLength(1);
    // Baseline points are separate entities — adoption never discards them.
    expect(pts).toHaveLength(3);
  });

  it("cannot adopt without a usable baseline, or when not proposed", () => {
    const goal = makeGoal({ status: "proposed" });
    expect(canAdopt(goal, []).reason).toBe("insufficient_baseline");
    expect(() => adoptGoal(goal, [], { who: "arc", when: asTimestamp(0) })).toThrow(AdoptionError);
    expect(canAdopt(makeGoal({ status: "active" }), threePts(goal)).reason).toBe("not_proposed");
  });

  it("a proposed goal cannot export to IC; after adoption it can", () => {
    const goal = makeGoal({ status: "proposed" });
    expect(isIcExportable(goal)).toBe(false); // HARD NO to IC until adoption
    const adopted = adoptGoal(goal, threePts(goal), { who: "arc", when: asTimestamp(0) });
    expect(isIcExportable(adopted)).toBe(true);
  });

  it("mastered/retired are explicit ARC actions (never auto); recorded with an audit revision", () => {
    const active = makeGoal({ status: "active" });
    const retired = closeGoalByArc(active, "retired", { who: "arc", when: asTimestamp(1) });
    expect(retired.status).toBe("retired");
    expect(retired.revisions).toHaveLength(1);
  });
});

describe("ARC dates + baseline window (§2.1)", () => {
  it("baseline window = arc_date − 6 INSTRUCTIONAL weeks (M4 primitive, not calendar weeks)", () => {
    const goal = makeGoal({ arcDate: iso("2026-10-05") }); // W41
    expect(computeBaselineWindowStart(goal, noBreaks)).toBe("2026-08-31"); // W36 Monday
  });

  it("editing arc_date recomputes the window, retains points, and flags the move", () => {
    const goal = makeGoal({ arcDate: iso("2026-10-05") });
    const points = [baselinePoint(goal, 8, newOpaqueId())]; // held separately — must survive
    const earlier = editArcDate(goal, iso("2026-09-28"), noBreaks); // W40
    expect(earlier.alert).toBe("compressed");
    expect(earlier.goal.baseline_window_start).toBe("2026-08-24"); // W35 Monday, recomputed
    expect(earlier.goal.arc_date).toBe("2026-09-28");
    expect(points).toHaveLength(1); // points never discarded on a date shift

    const later = editArcDate(goal, iso("2026-10-19"), noBreaks);
    expect(later.alert).toBe("extended");
  });

  it("marking confirmed is informational only (does not move the window)", () => {
    const goal = makeGoal({ arcDate: iso("2026-10-05") });
    const confirmed = markArcDateConfirmed(goal);
    expect(confirmed.arc_date_flag).toBe("confirmed");
    expect(confirmed.arc_date).toBe(goal.arc_date);
  });

  it("a baseline reminder carries no student payload beyond initials", () => {
    const goal = makeGoal({ arcDate: iso("2026-10-05") });
    const reminder = baselineReminder(goal, "AB", noBreaks);
    expect(Object.keys(reminder).sort()).toEqual(["goalId", "initials", "windowStart"]);
    expect(reminder.initials).toBe("AB");
    // no goal_text / score fields
    expect(JSON.stringify(reminder)).not.toContain("synthetic");
  });
});
