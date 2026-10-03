// TEACH-41 — IEP goal label: validator, number-aware order, cohort-scoped
// duplicates, audited setGoalLabel (and no F4 clamp). SYNTHETIC data only.

import {
  asTimestamp,
  type GoalStatus,
  type IEPGoal,
  newOpaqueId,
  type OpaqueId,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  canBeginMonitoring,
  clampAfterFromRevisions,
  compareGoalLabel,
  duplicateGoalLabels,
  GoalLabelError,
  goalLabelCohort,
  goalLabelConflicts,
  setGoalLabel,
  validateGoalLabel,
} from "./index.js";

function goal(
  studentId: OpaqueId,
  status: GoalStatus,
  label?: string,
  text = "synthetic goal",
): IEPGoal {
  return {
    goal_id: newOpaqueId(),
    student_id: studentId,
    goal_text: text,
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
    status,
    created_ts: asTimestamp(0),
    revisions: [],
    baseline_value: 40,
    baseline_source: "eval",
    ...(label !== undefined ? { goal_label: label } : {}),
  };
}

describe("validateGoalLabel", () => {
  it.each(["1", "2", "1a", "3.1", "10", "A", "ab.12c"])("accepts %s", (raw) => {
    expect(validateGoalLabel(raw)).toEqual({ ok: true, label: raw });
  });

  it("trims and keeps the typed case", () => {
    expect(validateGoalLabel("  2B ")).toEqual({ ok: true, label: "2B" });
  });

  it("blank (or whitespace) is no label, not an error", () => {
    expect(validateGoalLabel("")).toEqual({ ok: true, label: undefined });
    expect(validateGoalLabel("   ")).toEqual({ ok: true, label: undefined });
  });

  it.each(["1234567", "Goal 2", "#2", "2-a", "1,2", "é", "2/3"])("rejects %s", (raw) => {
    expect(validateGoalLabel(raw)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("compareGoalLabel", () => {
  const sort = (xs: (string | undefined)[]) => [...xs].sort(compareGoalLabel);

  it("is number-aware: 1 < 1a < 2 < 10", () => {
    expect(sort(["10", "2", "1a", "1"])).toEqual(["1", "1a", "2", "10"]);
  });

  it("puts unlabeled goals last", () => {
    expect(sort([undefined, "2", undefined, "1"])).toEqual(["1", "2", undefined, undefined]);
  });

  it("orders dotted labels after their parent: 3 < 3.1 < 3.2 < 4", () => {
    expect(sort(["4", "3.2", "3", "3.1"])).toEqual(["3", "3.1", "3.2", "4"]);
  });
});

describe("goalLabelCohort", () => {
  it("active + mastered = current IEP, proposed = next IEP, retired = none", () => {
    expect(goalLabelCohort("active")).toBe("current");
    expect(goalLabelCohort("mastered")).toBe("current");
    expect(goalLabelCohort("proposed")).toBe("next");
    expect(goalLabelCohort("retired")).toBeNull();
  });
});

describe("duplicateGoalLabels — cohort-scoped, case-insensitive", () => {
  const ab = newOpaqueId();

  it("flags BOTH goals of a same-cohort duplicate, each pointing at the other", () => {
    const g1 = goal(ab, "active", "2", "Add integers");
    const g2 = goal(ab, "mastered", "2", "Two-step equations");
    const g3 = goal(ab, "active", "1");
    const dups = duplicateGoalLabels([g1, g2, g3], ab);
    expect([...dups.keys()].sort()).toEqual([g1.goal_id, g2.goal_id].sort());
    expect(dups.get(g1.goal_id)).toEqual([g2]);
    expect(dups.get(g2.goal_id)).toEqual([g1]);
    expect(dups.has(g3.goal_id)).toBe(false);
  });

  it("compares case-insensitively (1a = 1A)", () => {
    const g1 = goal(ab, "active", "1a");
    const g2 = goal(ab, "active", "1A");
    expect(duplicateGoalLabels([g1, g2], ab).size).toBe(2);
  });

  it("current and next IEP are checked separately", () => {
    const active = goal(ab, "active", "2");
    const proposed = goal(ab, "proposed", "2");
    expect(duplicateGoalLabels([active, proposed], ab).size).toBe(0);
    const proposed2 = goal(ab, "proposed", "2");
    expect([...duplicateGoalLabels([active, proposed, proposed2], ab).keys()].sort()).toEqual(
      [proposed.goal_id, proposed2.goal_id].sort(),
    );
  });

  it("a retired goal never triggers it (its label stays frozen)", () => {
    const retired = goal(ab, "retired", "2");
    const active = goal(ab, "active", "2");
    expect(duplicateGoalLabels([retired, active], ab).size).toBe(0);
  });

  it("is per student, and unlabeled goals never collide", () => {
    const cd = newOpaqueId();
    expect(duplicateGoalLabels([goal(ab, "active", "2"), goal(cd, "active", "2")], ab).size).toBe(
      0,
    );
    expect(duplicateGoalLabels([goal(ab, "active"), goal(ab, "active")], ab).size).toBe(0);
  });

  it("the cue disappears once one label changes", () => {
    const g1 = goal(ab, "active", "2");
    const g2 = goal(ab, "active", "2");
    expect(duplicateGoalLabels([g1, g2], ab).size).toBe(2);
    const fixed = setGoalLabel(g2, "3", { who: "teacher", when: asTimestamp(1) });
    expect(duplicateGoalLabels([g1, fixed], ab).size).toBe(0);
  });
});

describe("goalLabelConflicts — a goal still being entered or adopted", () => {
  const ab = newOpaqueId();

  it("finds the saved same-cohort goal for an unsaved candidate", () => {
    const existing = goal(ab, "active", "2", "Add integers");
    expect(
      goalLabelConflicts([existing], { student_id: ab, status: "active", goal_label: "2" }),
    ).toEqual([existing]);
  });

  it("adopting proposed Goal N meets active Goal N (status active as the candidate)", () => {
    const active = goal(ab, "active", "2");
    const proposed = goal(ab, "proposed", "2");
    expect(goalLabelConflicts([active, proposed], proposed)).toEqual([]);
    expect(goalLabelConflicts([active, proposed], { ...proposed, status: "active" })).toEqual([
      active,
    ]);
  });

  it("no label → no conflict", () => {
    expect(
      goalLabelConflicts([goal(ab, "active", "2")], { student_id: ab, status: "active" }),
    ).toEqual([]);
  });
});

describe("setGoalLabel — audited", () => {
  const who = "teacher";
  const when = asTimestamp(1_700_000_000_000);

  it("sets a label and appends a who/when/old→new Revision", () => {
    const g = goal(newOpaqueId(), "active");
    const next = setGoalLabel(g, " 2 ", { who, when });
    expect(next.goal_label).toBe("2");
    expect(next.revisions).toEqual([
      { who, when, old: { goal_label: null }, new: { goal_label: "2" } },
    ]);
    expect(g.goal_label).toBeUndefined(); // pure
  });

  it("changes and clears a label, each audited", () => {
    const g = goal(newOpaqueId(), "active", "2");
    const changed = setGoalLabel(g, "3", { who, when });
    expect(changed.revisions.at(-1)).toEqual({
      who,
      when,
      old: { goal_label: "2" },
      new: { goal_label: "3" },
    });
    const cleared = setGoalLabel(changed, undefined, { who, when });
    expect("goal_label" in cleared).toBe(false);
    expect(cleared.revisions.at(-1)).toEqual({
      who,
      when,
      old: { goal_label: "3" },
      new: { goal_label: null },
    });
    expect(setGoalLabel(changed, "  ", { who, when }).goal_label).toBeUndefined();
  });

  it("an unchanged label writes no revision", () => {
    const g = goal(newOpaqueId(), "active", "2");
    expect(setGoalLabel(g, "2", { who, when })).toBe(g);
  });

  it("rejects an invalid label", () => {
    expect(() => setGoalLabel(goal(newOpaqueId(), "active"), "Goal 2", { who, when })).toThrow(
      GoalLabelError,
    );
  });

  it("a label revision is NOT an F4 quarterly clamp key", () => {
    const g = goal(newOpaqueId(), "active");
    const labelled = setGoalLabel(g, "2", { who, when });
    expect(clampAfterFromRevisions(labelled)).toBeUndefined();
  });

  it("the label stays out of the canBeginMonitoring gate", () => {
    const g = goal(newOpaqueId(), "active");
    expect(canBeginMonitoring(g).ok).toBe(true);
    expect(canBeginMonitoring(g).missing).not.toContain("goal_label");
  });
});
