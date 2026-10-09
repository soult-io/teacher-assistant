// TEACH-46 — baseline points: no accidental 0, audited Fix / Remove / Keep.
// Encodes the ky-sped-lbd-sdi-sme ruling 2026-10-09 (C1–C8, required tests E1–E13;
// the UI half of E1/E2/E4/E9/E10 and the sync test E13 live in apps/pwa).
// SYNTHETIC data only.

import {
  asTimestamp,
  BASELINE_REMOVE_REASONS,
  type BaselinePoint,
  type BaselineRemoveReason,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type ProbeDefinition,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import * as domain from "./index.js";
import {
  adoptGoal,
  BaselineEditError,
  baselineCorrectionAfterArc,
  baselineHistory,
  baselineTotalPrefill,
  buildIcExport,
  canAdopt,
  captureScoredPoint,
  checkBaselineScore,
  computeAutoStatement,
  createBaselinePoint,
  deriveBaseline,
  fixBaselinePoint,
  keepBaselineTotal,
  needsTotalDecision,
  parseBaselineCount,
  removeBaselinePoint,
  takesBaselineScore,
} from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;
const T = { who: "teacher", when: asTimestamp(1_000) } as const;

function makeGoal(over: Partial<IEPGoal> = {}): IEPGoal {
  const goalId = newOpaqueId();
  return {
    goal_id: goalId,
    student_id: newOpaqueId(),
    goal_text: "synthetic",
    goal_label: "1",
    behavior: "b",
    circumstance: "c",
    criterion_level: 80,
    criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "probe",
    frequency: "weekly",
    denominator_model: "percent_correct_over_total",
    denominator_basis: "fixed",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: "proposed",
    probe_definition_id: newOpaqueId(),
    created_ts: asTimestamp(0),
    revisions: [],
    ...over,
  };
}

function probeFor(goal: IEPGoal, expected = 10): ProbeDefinition {
  return {
    probe_definition_id: goal.probe_definition_id ?? newOpaqueId(),
    goal_id: goal.goal_id,
    expected_denominator: expected,
    condition: "c",
  };
}

function add(
  goal: IEPGoal,
  numerator: number,
  denominator = 10,
  day = "2026-08-10",
): BaselinePoint {
  return createBaselinePoint({
    goal,
    probe: probeFor(goal),
    adminDate: iso(day),
    numerator,
    denominator,
    who: "teacher",
    entryTs: asTimestamp(0),
  });
}

/** Three counted points 20% / 40% / 60% → mean 40. */
function threePoints(goal: IEPGoal): BaselinePoint[] {
  return [add(goal, 2), add(goal, 4), add(goal, 6)];
}

describe("E1 — the score check: empty is refused, 0 is accepted", () => {
  it("parses only plain whole numbers", () => {
    expect(parseBaselineCount("")).toBeUndefined();
    expect(parseBaselineCount("0")).toBe(0);
    expect(parseBaselineCount("7")).toBe(7);
    expect(parseBaselineCount("1.5")).toBeUndefined();
    expect(parseBaselineCount("-1")).toBeUndefined();
    expect(parseBaselineCount("2e1")).toBeUndefined();
  });

  it("accepts 0 ≤ n ≤ d with d ≥ 1; rejects missing n, n > d, d = 0 and non-integers", () => {
    expect(checkBaselineScore(0, 5)).toBeNull();
    expect(checkBaselineScore(5, 5)).toBeNull();
    expect(checkBaselineScore(undefined, 5)).toBe("numerator_missing");
    expect(checkBaselineScore(-1, 5)).toBe("numerator_missing");
    expect(checkBaselineScore(1.5, 5)).toBe("numerator_missing");
    expect(checkBaselineScore(6, 5)).toBe("over_total");
    expect(checkBaselineScore(0, 0)).toBe("total_missing");
    expect(checkBaselineScore(1, 2.5)).toBe("total_missing");
    expect(checkBaselineScore(1, undefined)).toBe("total_missing");
  });

  it("createBaselinePoint stores a typed 0 and refuses an invalid score", () => {
    const goal = makeGoal();
    expect(add(goal, 0).numerator).toBe(0);
    expect(() => add(goal, 11)).toThrow(BaselineEditError);
    expect(() => add(goal, 1, 0)).toThrow(BaselineEditError);
    expect(() => add(goal, 0.5)).toThrow(BaselineEditError);
  });

  it("creates points only on a proposed goal, recorded with an empty audit trail", () => {
    const goal = makeGoal();
    const p = add(goal, 3);
    expect(p.status).toBe("recorded");
    expect(p.revisions).toEqual([]);
    expect(p.scorer).toBe("teacher");
    expect(() => add({ ...goal, status: "active" }, 3)).toThrow(BaselineEditError);
  });
});

describe("E2 — the 'of N' prefill follows C7 (no hardcoded 5)", () => {
  it("prefills the probe's expected total on a fixed-total goal", () => {
    const goal = makeGoal();
    expect(baselineTotalPrefill(goal, probeFor(goal, 12))).toBe(12);
    expect(baselineTotalPrefill(goal, probeFor(goal, 7))).toBe(7);
  });

  it("is empty on a variable-total goal or with no probe", () => {
    const goal = makeGoal({ denominator_basis: "variable" });
    expect(baselineTotalPrefill(goal, probeFor(goal, 12))).toBeUndefined();
    expect(baselineTotalPrefill(makeGoal(), undefined)).toBeUndefined();
  });

  it("ignores another goal's probe", () => {
    expect(baselineTotalPrefill(makeGoal(), probeFor(makeGoal(), 12))).toBeUndefined();
  });

  it("a non-percent goal takes no '# correct of N' score", () => {
    const goal = makeGoal({ denominator_model: "frequency_count" });
    expect(takesBaselineScore(goal)).toBe(false);
    expect(baselineTotalPrefill(goal, probeFor(goal, 12))).toBeUndefined();
    expect(takesBaselineScore(makeGoal())).toBe(true);
  });
});

describe("E3 — Fix appends a Revision and the estimate recomputes", () => {
  it("records who/when/old/new, resyncs computed_value, and moves the estimate", () => {
    const goal = makeGoal();
    const points = threePoints(goal);
    expect(deriveBaseline(goal, points).value).toBeCloseTo(40);
    const [first, ...rest] = points;
    if (first === undefined) throw new Error("seed");
    const fixed = fixBaselinePoint(first, goal, { numerator: 8 }, T);
    expect(fixed.numerator).toBe(8);
    expect(fixed.computed_value).toBeCloseTo(0.8);
    expect(fixed.revisions).toEqual([
      {
        who: "teacher",
        when: T.when,
        old: { numerator: 2, denominator_used: 10 },
        new: { numerator: 8, denominator_used: 10 },
      },
    ]);
    // (80 + 40 + 60) / 3 = 60
    expect(deriveBaseline(goal, [fixed, ...rest]).value).toBeCloseTo(60);
    expect(fixed.corrected_after_adoption).toBeUndefined();
  });

  it("can change the admin date, and refuses an invalid fix", () => {
    const goal = makeGoal();
    const p = add(goal, 2);
    const moved = fixBaselinePoint(p, goal, { admin_date: iso("2026-08-12") }, T);
    expect(moved.admin_date).toBe("2026-08-12");
    expect(moved.revisions[0]?.old).toEqual({
      numerator: 2,
      denominator_used: 10,
      admin_date: "2026-08-10",
    });
    expect(() => fixBaselinePoint(p, goal, { numerator: 11 }, T)).toThrow(BaselineEditError);
    expect(() => fixBaselinePoint(p, goal, { denominator_used: 0 }, T)).toThrow(BaselineEditError);
  });

  it("a no-op fix appends nothing", () => {
    const goal = makeGoal();
    const p = add(goal, 2);
    expect(fixBaselinePoint(p, goal, { numerator: 2 }, T)).toBe(p);
  });

  it("History lists the fix as was a/b, now c/d", () => {
    const goal = makeGoal();
    const fixed = fixBaselinePoint(add(goal, 2), goal, { numerator: 3, denominator_used: 5 }, T);
    expect(baselineHistory(fixed)).toEqual([
      { kind: "fixed", when: T.when, was: [2, 10], now: [3, 5] },
    ]);
  });
});

describe("E4 — Remove: closed reasons, point kept, excluded, shown in History", () => {
  it("rejects a missing or unknown reason in the type and at runtime", () => {
    const goal = makeGoal();
    const p = add(goal, 2);
    // @ts-expect-error — a free-text reason is not a BaselineRemoveReason.
    expect(() => removeBaselinePoint(p, goal, "typo by me", T)).toThrow(BaselineEditError);
    // @ts-expect-error — the reason is required.
    expect(() => removeBaselinePoint(p, goal, undefined, T)).toThrow(BaselineEditError);
    // @ts-expect-error — "other" is deliberately not on the list.
    expect(() => removeBaselinePoint(p, goal, "other", T)).toThrow(BaselineEditError);
  });

  it("the list is exactly the four ruled reasons", () => {
    expect([...BASELINE_REMOVE_REASONS]).toEqual([
      "entered_by_mistake",
      "duplicate",
      "wrong_student_or_goal",
      "probe_not_per_goal_condition",
    ]);
  });

  it.each(BASELINE_REMOVE_REASONS)("removing with %s keeps the point and excludes it", (reason) => {
    const goal = makeGoal();
    const [a, b, c] = threePoints(goal);
    if (a === undefined || b === undefined || c === undefined) throw new Error("seed");
    const extra = add(goal, 0); // the accidental 0
    const removed = removeBaselinePoint(extra, goal, reason, T);
    expect(removed).toMatchObject({
      baseline_point_id: extra.baseline_point_id,
      numerator: 0,
      denominator_used: 10,
      status: "removed",
      removed_reason: reason,
      removed_ts: T.when,
      removed_by: "teacher",
    });
    expect(removed.revisions).toEqual([
      {
        who: "teacher",
        when: T.when,
        old: { status: "recorded" },
        new: { status: "removed", removed_reason: reason },
      },
    ]);
    const est = deriveBaseline(goal, [a, b, c, removed]);
    expect(est.n).toBe(3);
    expect(est.value).toBeCloseTo(40);
    expect(est.pointIds).not.toContain(extra.baseline_point_id);
    expect(baselineHistory(removed)).toEqual([
      { kind: "removed", when: T.when, reason, was: [0, 10] },
    ]);
  });

  it("a removed point cannot be fixed, removed again or kept", () => {
    const goal = makeGoal();
    const removed = removeBaselinePoint(add(goal, 2), goal, "duplicate", T);
    expect(() => fixBaselinePoint(removed, goal, { numerator: 3 }, T)).toThrow(BaselineEditError);
    expect(() => removeBaselinePoint(removed, goal, "duplicate", T)).toThrow(BaselineEditError);
  });

  it("refuses a point from another goal", () => {
    const goal = makeGoal();
    expect(() => removeBaselinePoint(add(makeGoal(), 2), goal, "duplicate", T)).toThrow(
      BaselineEditError,
    );
  });
});

describe("E5 — dropping below 3 counted points blocks adoption", () => {
  it("canAdopt returns insufficient_baseline after a remove", () => {
    const goal = makeGoal();
    const [a, b, c] = threePoints(goal);
    if (a === undefined || b === undefined || c === undefined) throw new Error("seed");
    expect(canAdopt(goal, [a, b, c]).ok).toBe(true);
    const removed = removeBaselinePoint(c, goal, "entered_by_mistake", T);
    expect(canAdopt(goal, [a, b, removed])).toEqual({ ok: false, reason: "insufficient_baseline" });
    expect(deriveBaseline(goal, [a, b, removed])).toMatchObject({
      n: 2,
      usable: false,
      value: null,
    });
  });
});

describe("E6 — no delete path exists at any layer", () => {
  it("domain-core exports no delete/purge for baseline points", () => {
    const names = Object.keys(domain).filter((k) => /baseline/i.test(k));
    expect(names.filter((k) => /delete|purge|drop|destroy|erase/i.test(k))).toEqual([]);
  });

  it("removal returns the same point id with its values intact", () => {
    const goal = makeGoal();
    const p = add(goal, 4);
    const r = removeBaselinePoint(p, goal, "duplicate", T);
    expect(r.baseline_point_id).toBe(p.baseline_point_id);
    expect([r.numerator, r.denominator_used, r.admin_date]).toEqual([4, 10, p.admin_date]);
  });
});

/** Four weekly monitoring points so the goal has an IC export row and a statement. */
function monitoring(goal: IEPGoal): ProgressDataPoint[] {
  return ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"].map((d, i) =>
    captureScoredPoint({
      goalId: goal.goal_id,
      studentId: goal.student_id,
      adminDate: iso(d),
      entryTs: asTimestamp(i),
      numerator: 5 + i,
      denominatorUsed: 10,
      setting: "math_resource",
      scorer: "teacher",
    }),
  );
}

describe("E7 — a fix after adoption never touches the IEP baseline", () => {
  it("leaves baseline_value, the statement and the IC export unchanged, and sets the flag", () => {
    const proposed = makeGoal();
    const points = threePoints(proposed);
    const adopted = adoptGoal(proposed, points, { who: "teacher", when: asTimestamp(5) });
    expect(adopted.baseline_value).toBeCloseTo(40);
    const mon = monitoring(adopted);
    const opts = { isNonInstructional: () => false };
    const statementBefore = computeAutoStatement(adopted, "GH", mon, opts);
    const exportBefore = buildIcExport([adopted], mon);
    expect(statementBefore?.text).toContain("baseline");

    const [first, ...rest] = points;
    if (first === undefined) throw new Error("seed");
    const fixed = fixBaselinePoint(first, adopted, { numerator: 8 }, T);
    expect(fixed.corrected_after_adoption).toBe(true);
    // The fix returns a point only; the goal is a separate record and is not rewritten.
    expect(adopted.baseline_value).toBeCloseTo(40);
    expect(computeAutoStatement(adopted, "GH", mon, opts)).toEqual(statementBefore);
    expect(buildIcExport([adopted], mon)).toEqual(exportBefore);

    // The "Fixed after ARC" numbers: IEP stays 40; over the adopted points it would be 60.
    expect(baselineCorrectionAfterArc(adopted, [fixed, ...rest])).toEqual({
      iepValue: adopted.baseline_value,
      estimate: 60,
    });
    expect(baselineCorrectionAfterArc(adopted, points)).toBeNull();
  });

  it("the would-be estimate uses the adopted method (median)", () => {
    const proposed = makeGoal();
    const points = threePoints(proposed);
    const adopted = adoptGoal(proposed, points, {
      who: "teacher",
      when: asTimestamp(5),
      method: "median",
    });
    const [first, ...rest] = points;
    if (first === undefined) throw new Error("seed");
    const fixed = fixBaselinePoint(first, adopted, { numerator: 10 }, T);
    // 100 / 40 / 60 → median 60
    expect(baselineCorrectionAfterArc(adopted, [fixed, ...rest])?.estimate).toBe(60);
  });

  it("after adoption a point may be fixed but not removed (no re-lock path)", () => {
    const proposed = makeGoal();
    const points = threePoints(proposed);
    const adopted = adoptGoal(proposed, points, { who: "teacher", when: asTimestamp(5) });
    const [first] = points;
    if (first === undefined) throw new Error("seed");
    expect(() => removeBaselinePoint(first, adopted, "duplicate", T)).toThrow(BaselineEditError);
    const names = Object.keys(domain);
    expect(names.filter((k) => /re-?lock|relock|readopt/i.test(k))).toEqual([]);
  });
});

describe("E8 — the adoption Revision records method and point ids (C6)", () => {
  it("stores baseline_method and the ids of the counted points only", () => {
    const goal = makeGoal();
    const points = threePoints(goal);
    const removed = removeBaselinePoint(add(goal, 0), goal, "entered_by_mistake", T);
    const adopted = adoptGoal(goal, [...points, removed], {
      who: "teacher",
      when: asTimestamp(5),
      method: "median",
    });
    const rev = adopted.revisions.at(-1);
    expect(rev?.new).toMatchObject({
      status: "active",
      baseline_method: "median",
      baseline_point_ids: points.map((p) => p.baseline_point_id),
    });
  });

  it("defaults the stored method to mean", () => {
    const goal = makeGoal();
    const adopted = adoptGoal(goal, threePoints(goal), { who: "teacher", when: asTimestamp(5) });
    expect(adopted.revisions.at(-1)?.new).toMatchObject({ baseline_method: "mean" });
  });
});

describe("E9 — a mismatched total is not comparable until Keep", () => {
  it("flags the mismatch, keeps the original, and counts only after Keep", () => {
    const goal = makeGoal();
    const [a, b] = threePoints(goal);
    if (a === undefined || b === undefined) throw new Error("seed");
    const odd = add(goal, 3, 8); // probe has 10 items
    expect(odd).toMatchObject({ denominator_original: 10, denominator_mismatch: true });
    expect(needsTotalDecision(odd)).toBe(true);
    expect(deriveBaseline(goal, [a, b, odd]).n).toBe(2);
    expect(canAdopt(goal, [a, b, odd]).reason).toBe("insufficient_baseline");

    const kept = keepBaselineTotal(odd, goal, T);
    expect(kept.mismatch_kept).toBe(true);
    expect(kept.revisions.at(-1)).toEqual({
      who: "teacher",
      when: T.when,
      old: { mismatch_kept: false },
      new: { mismatch_kept: true },
    });
    expect(needsTotalDecision(kept)).toBe(false);
    expect(deriveBaseline(goal, [a, b, kept]).n).toBe(3);
    expect(canAdopt(goal, [a, b, kept]).ok).toBe(true);
  });

  it("'Use N' (a fix back to the probe total) clears the flag", () => {
    const goal = makeGoal();
    const odd = add(goal, 3, 8);
    const used = fixBaselinePoint(odd, goal, { denominator_used: 10 }, T);
    expect(used.denominator_mismatch).toBe(false);
    expect(used.denominator_original).toBe(10);
    expect(needsTotalDecision(used)).toBe(false);
  });

  it("changing a kept total to another odd total needs a fresh Keep", () => {
    const goal = makeGoal();
    const kept = keepBaselineTotal(add(goal, 3, 8), goal, T);
    const refixed = fixBaselinePoint(kept, goal, { denominator_used: 9 }, T);
    expect(refixed.mismatch_kept).toBeUndefined();
    expect(needsTotalDecision(refixed)).toBe(true);
    // Fixing only the numerator keeps the decision.
    expect(fixBaselinePoint(kept, goal, { numerator: 4 }, T).mismatch_kept).toBe(true);
  });

  it("a variable-total goal never flags a mismatch; Keep on a matched point is refused", () => {
    const goal = makeGoal({ denominator_basis: "variable" });
    const p = add(goal, 3, 8);
    expect(p.denominator_mismatch).toBeUndefined();
    expect(() => keepBaselineTotal(p, goal, T)).toThrow(BaselineEditError);
  });
});

describe("E10 — the para cannot Fix, Remove or Keep (domain layer)", () => {
  it("every edit refuses a non-teacher author at runtime", () => {
    const goal = makeGoal();
    const p = add(goal, 3, 8);
    const para = { who: "para" as never, when: T.when };
    expect(() => fixBaselinePoint(p, goal, { numerator: 1 }, para)).toThrow(/teacher_only/);
    expect(() => removeBaselinePoint(p, goal, "duplicate", para)).toThrow(/teacher_only/);
    expect(() => keepBaselineTotal(p, goal, para)).toThrow(/teacher_only/);
    expect(() =>
      createBaselinePoint({
        goal,
        probe: probeFor(goal),
        adminDate: iso("2026-08-10"),
        numerator: 1,
        denominator: 10,
        who: "para" as never,
        entryTs: asTimestamp(0),
      }),
    ).toThrow(/teacher_only/);
  });
});

describe("E11 — baseline revisions never reach the IC export or the auto-statement", () => {
  it("neither takes baseline points, and their output carries no baseline revision value", () => {
    // Structural: both consumers read (goal, monitoring points) only.
    expect(buildIcExport.length).toBe(2);
    expect(computeAutoStatement.length).toBe(4);
    const proposed = makeGoal();
    const points = threePoints(proposed);
    const adopted = adoptGoal(proposed, points, { who: "teacher", when: asTimestamp(5) });
    const [first] = points;
    if (first === undefined) throw new Error("seed");
    // A distinctive fixed value (97/97) that must not appear anywhere downstream.
    fixBaselinePoint(first, adopted, { numerator: 97, denominator_used: 97 }, T);
    const mon = monitoring(adopted);
    const ic = buildIcExport([adopted], mon);
    const statement = computeAutoStatement(adopted, "GH", mon, { isNonInstructional: () => false });
    // Numbers only — the outputs also carry random opaque ids, which may contain "97".
    const numbers: number[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "number") numbers.push(v);
      else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) walk(x);
    };
    walk([ic, statement]);
    expect(numbers).not.toContain(97);
    expect(statement?.text).not.toMatch(/\b97\b/);
    const out = JSON.stringify([ic, statement]);
    expect(out).not.toContain("corrected_after_adoption");
    expect(out).not.toContain("baseline_point_ids");
    // A proposed goal produces neither (the M6a structural guard).
    expect(buildIcExport([proposed], mon)).toEqual([]);
    expect(computeAutoStatement(proposed, "GH", mon, { isNonInstructional: () => false })).toBe(
      null,
    );
  });
});

describe("E12 — revisions carry no free text", () => {
  it("every revision field is a number, a date, a role or a closed enum", () => {
    const goal = makeGoal();
    let p = add(goal, 3, 8);
    p = keepBaselineTotal(p, goal, T);
    p = fixBaselinePoint(p, goal, { numerator: 4, admin_date: iso("2026-08-11") }, T);
    p = removeBaselinePoint(p, goal, "probe_not_per_goal_condition", T);
    const allowedStrings = new Set<string>([
      "teacher",
      "recorded",
      "removed",
      "2026-08-10",
      "2026-08-11",
      ...BASELINE_REMOVE_REASONS,
    ]);
    const leaves: unknown[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "object" && v !== null) {
        for (const x of Object.values(v)) walk(x);
      } else {
        leaves.push(v);
      }
    };
    walk(p.revisions);
    for (const leaf of leaves) {
      if (typeof leaf === "string") {
        expect(allowedStrings.has(leaf)).toBe(true);
      } else {
        expect(["number", "boolean"]).toContain(typeof leaf);
      }
    }
    expect(p.revisions).toHaveLength(3);
  });

  it("the remove reason parameter is typed to the closed list", () => {
    const reason: BaselineRemoveReason = "duplicate";
    expect(BASELINE_REMOVE_REASONS).toContain(reason);
  });
});

describe("legacy points (stored before TEACH-46) still count", () => {
  it("a point with no status or flags counts as recorded", () => {
    const goal = makeGoal();
    const legacy = threePoints(goal).map((p) => {
      const { status: _s, denominator_original: _o, denominator_mismatch: _m, ...rest } = p;
      return rest as BaselinePoint;
    });
    expect(deriveBaseline(goal, legacy).n).toBe(3);
  });
});
