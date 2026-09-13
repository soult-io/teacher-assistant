import { canBeginMonitoring } from "@teacher-assistant/domain-core";
import { newOpaqueId } from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { assembleGoal, emptyForm, makeStudent, type NewGoalForm, nowTs } from "./assemble.js";

function filledDraft(over?: Partial<NewGoalForm>): NewGoalForm {
  return {
    ...emptyForm(),
    path: "draft",
    initials: "ab",
    behavior: "solve two-step equations",
    circumstance: "given a 5-item probe",
    level: "80",
    consistency: "4",
    methodTool: "curriculum probe",
    total: "5",
    accomMod: "none",
    ...over,
  };
}

describe("assembleGoal (U5 create)", () => {
  it("a DRAFT builds a PROPOSED goal with no baseline, linked to its probe", () => {
    const { goal, probe } = assembleGoal(filledDraft(), newOpaqueId(), nowTs());
    expect(goal.status).toBe("proposed");
    expect(goal.baseline_value).toBeUndefined();
    expect(goal.baseline_source).toBeUndefined();
    expect(goal.probe_definition_id).toBe(probe.probe_definition_id);
    expect(probe.expected_denominator).toBe(5);
    // goal_text carries the initials (stranger test: audience = initials only).
    expect(goal.goal_text).toContain("ab");
  });

  it("an ADOPT builds an ACTIVE goal with the baseline locked in", () => {
    const { goal } = assembleGoal(
      filledDraft({ path: "adopt", baseline: "20" }),
      newOpaqueId(),
      nowTs(),
    );
    expect(goal.status).toBe("active");
    expect(goal.baseline_value).toBe(20);
    expect(goal.baseline_source).toBe("eval");
    // A baselined active goal clears the engine's baseline-mandatory gate.
    expect(canBeginMonitoring(goal).ok).toBe(true);
  });

  it("a blank OR non-numeric baseline stays undefined (never a stray 0% that fakes the gate)", () => {
    for (const bad of ["", "   ", "x", "n/a"]) {
      const { goal } = assembleGoal(
        filledDraft({ path: "adopt", baseline: bad }),
        newOpaqueId(),
        nowTs(),
      );
      expect(goal.baseline_value).toBeUndefined();
      expect(canBeginMonitoring(goal).ok).toBe(false); // baseline-mandatory gate blocks
    }
  });

  it("carries method_general + the descriptive accom/mod detail from the form (method not hardcoded)", () => {
    const { goal } = assembleGoal(
      filledDraft({
        methodGeneral: "direct",
        accomMod: "accommodation",
        accomDetail: "read-aloud + extended time",
      }),
      newOpaqueId(),
      nowTs(),
    );
    expect(goal.method_general).toBe("direct"); // was hardcoded "cbm" before the restore
    expect(goal.accom_mod).toBe("accommodation"); // the category (drives M8)
    expect(goal.accom_mod_detail).toBe("read-aloud + extended time"); // the descriptive label
    // The descriptive accom text is NOT part of the composed goal_text (stranger-test surface).
    expect(goal.goal_text).not.toContain("read-aloud");
  });

  it("omits accom_mod_detail when the field is blank", () => {
    const { goal } = assembleGoal(filledDraft({ accomDetail: "   " }), newOpaqueId(), nowTs());
    expect(goal.accom_mod_detail).toBeUndefined();
  });

  it("a VARIABLE basis is carried onto the goal (F-2 escape valve)", () => {
    const { goal } = assembleGoal(
      filledDraft({ denominatorBasis: "variable" }),
      newOpaqueId(),
      nowTs(),
    );
    expect(goal.denominator_basis).toBe("variable");
  });

  it("the default basis is FIXED (deliberate, never defaulted to variable)", () => {
    expect(emptyForm().denominatorBasis).toBe("fixed");
    const { goal } = assembleGoal(filledDraft(), newOpaqueId(), nowTs());
    expect(goal.denominator_basis).toBe("fixed");
  });

  it("makeStudent upper-cases the initials and carries a color token", () => {
    const s = makeStudent("ab", "--s-ab");
    expect(s.initials).toBe("AB");
    expect(s.color_token).toBe("--s-ab");
    expect(s.active).toBe(true);
  });
});
