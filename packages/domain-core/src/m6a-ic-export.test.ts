// M6a — IEP % → IC export + F4 quarterly summary. Acceptance (PRD §5 export,
// design §F.F4 / FERPA Item-3a). SYNTHETIC data only.

import {
  asTimestamp,
  type DenominatorModel,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type NoDataReason,
  type ProgressDataPoint,
  type Revision,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  buildIcExport,
  clampAfterFromRevisions,
  computeQuarterlySummary,
  isIcExportable,
} from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;

function makeGoal(
  over?: Partial<{
    status: GoalStatus;
    withBaseline: boolean;
    model: DenominatorModel;
    criterion: number;
    revisions: readonly Revision[];
  }>,
): IEPGoal {
  const withBaseline = over?.withBaseline ?? true;
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "synthetic",
    behavior: "b",
    circumstance: "c",
    criterion_level: over?.criterion ?? 80,
    criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "probe",
    frequency: "weekly",
    denominator_model: over?.model ?? "percent_correct_over_total",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: over?.status ?? "active",
    created_ts: asTimestamp(0),
    revisions: over?.revisions ?? [],
    ...(withBaseline ? { baseline_value: 40, baseline_source: "eval" as const } : {}),
  };
}

function scored(
  goal: IEPGoal,
  date: string,
  numerator: number,
  mismatch = false,
): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso(date),
    entry_ts: asTimestamp(0),
    state: "scored",
    numerator,
    denominator_used: 10,
    computed_value: numerator / 10,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
    ...(mismatch ? { denominator_mismatch: true } : {}),
  };
}

function noData(goal: IEPGoal, date: string, reason: NoDataReason): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso(date),
    entry_ts: asTimestamp(0),
    state: "no_data",
    no_data_reason: reason,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

describe("F4 quarterly summary (§6.1)", () => {
  const goal = makeGoal();

  // scored(goal, date, N) = N #correct on a 10-item probe → N*10 percent.
  it("averages the most-recent-5 SCORED points by admin-date", () => {
    const pts = [
      scored(goal, "2026-09-01", 4),
      scored(goal, "2026-09-08", 5),
      scored(goal, "2026-09-15", 6),
      scored(goal, "2026-09-22", 7),
      scored(goal, "2026-09-29", 8),
      scored(goal, "2026-10-06", 9),
      scored(goal, "2026-10-13", 10),
    ];
    const q = computeQuarterlySummary(goal, pts);
    expect(q.n).toBe(5);
    expect(q.average).toBeCloseTo(80); // last 5: 60,70,80,90,100 → 80
    expect(q.dateRange).toEqual({ start: "2026-09-15", end: "2026-10-13" });
    expect(q.label).toBe("quarterly progress summary");
  });

  it("excludes ⊘ from the average but reports the no-data count spanned", () => {
    const pts = [
      scored(goal, "2026-09-01", 6),
      noData(goal, "2026-09-08", "absent"),
      scored(goal, "2026-09-15", 8),
    ];
    const q = computeQuarterlySummary(goal, pts);
    expect(q.n).toBe(2);
    expect(q.average).toBeCloseTo(70); // (60+80)/2
    expect(q.noDataCountSpanned).toBe(1); // the ⊘ falls within [09-01, 09-15]
  });

  it("with <5 scored, averages what exists and labels n (never pads with zeros)", () => {
    const q = computeQuarterlySummary(goal, [scored(goal, "2026-09-01", 7)]);
    expect(q.n).toBe(1);
    expect(q.average).toBeCloseTo(70);
  });

  it("clamps the window at a criterion/denominator-model change", () => {
    const pts = [
      scored(goal, "2026-09-01", 4), // before the change — excluded
      scored(goal, "2026-09-15", 9),
      scored(goal, "2026-09-22", 10),
    ];
    const q = computeQuarterlySummary(goal, pts, { clampAfter: iso("2026-09-10") });
    expect(q.n).toBe(2);
    expect(q.average).toBeCloseTo(95); // (90+100)/2
    expect(q.dateRange?.start).toBe("2026-09-15");
  });

  it("excludes + surfaces a mismatched point (not single-denominator)", () => {
    const pts = [scored(goal, "2026-09-01", 8), scored(goal, "2026-09-08", 6, true)];
    const q = computeQuarterlySummary(goal, pts);
    expect(q.n).toBe(1);
    expect(q.excludedMismatches).toBe(1);
    expect(q.mixedDenominator).toBe(true);
  });
});

describe("IC weekly export block (§9.1a)", () => {
  it("emits one scored value per week + ⊘ rows with reason; in-progress excluded", () => {
    const goal = makeGoal();
    const queued: ProgressDataPoint = { ...scored(goal, "2026-09-22", 5), state: "queued" };
    const [exp] = buildIcExport(
      [goal],
      [scored(goal, "2026-09-08", 7), noData(goal, "2026-09-15", "absent"), queued],
    );
    expect(exp?.weekly).toHaveLength(2); // scored + ⊘, not the queued placeholder
    expect(exp?.weekly[0]).toMatchObject({
      numerator: 7,
      denominator: 10,
      percent: 70,
      state: "scored",
    });
    expect(exp?.weekly[1]).toMatchObject({
      state: "no_data",
      noDataReason: "absent",
      percent: null,
    });
  });
});

describe("STRUCTURAL IC-export guard (FERPA Item-3a)", () => {
  it("only active + baselined + criterion'd goals are exportable", () => {
    expect(isIcExportable(makeGoal({ status: "active" }))).toBe(true);
    expect(isIcExportable(makeGoal({ status: "proposed" }))).toBe(false);
    expect(isIcExportable(makeGoal({ status: "mastered" }))).toBe(false);
    expect(isIcExportable(makeGoal({ status: "retired" }))).toBe(false);
    expect(isIcExportable(makeGoal({ status: "active", withBaseline: false }))).toBe(false);
  });

  it("a proposed goal WITH points is unreachable by the exporter", () => {
    const proposed = makeGoal({ status: "proposed" });
    const active = makeGoal({ status: "active" });
    const exports = buildIcExport(
      [proposed, active],
      [scored(proposed, "2026-09-08", 9), scored(active, "2026-09-08", 8)],
    );
    expect(exports.map((e) => e.goalId)).toEqual([active.goal_id]); // proposed absent
  });
});

describe("SME PASS-WITH-CHANGES regressions (M6a PR#16)", () => {
  it("Change 1: clampAfterFromRevisions derives the boundary from a criterion/denominator change", () => {
    const critRev: Revision = {
      who: "arc",
      when: asTimestamp(Date.UTC(2026, 8, 10)), // 2026-09-10
      old: { criterion_level: 70 },
      new: { criterion_level: 80 },
    };
    expect(clampAfterFromRevisions(makeGoal({ revisions: [critRev] }))).toBe("2026-09-10");

    const denomRev: Revision = {
      who: "arc",
      when: asTimestamp(Date.UTC(2026, 8, 5)),
      old: { denominator_model: "rubric_score" },
      new: { denominator_model: "percent_correct_over_total" },
    };
    expect(clampAfterFromRevisions(makeGoal({ revisions: [denomRev] }))).toBe("2026-09-05");

    // An unrelated edit (e.g. a point fix) does not clamp.
    const unrelated: Revision = {
      who: "teacher",
      when: asTimestamp(0),
      old: { numerator: 7 },
      new: { numerator: 9 },
    };
    expect(clampAfterFromRevisions(makeGoal({ revisions: [unrelated] }))).toBeUndefined();
  });

  it("Change 1: the F4 average clamps at a mid-window criterion change (never blends across it)", () => {
    const goal = makeGoal({
      revisions: [
        {
          who: "arc",
          when: asTimestamp(Date.UTC(2026, 8, 10)),
          old: { criterion_level: 70 },
          new: { criterion_level: 80 },
        },
      ],
    });
    const [exp] = buildIcExport(
      [goal],
      [
        scored(goal, "2026-09-01", 4), // pre-change (40%) — must be excluded
        scored(goal, "2026-09-15", 9), // post-change
        scored(goal, "2026-09-22", 10),
      ],
    );
    expect(exp?.quarterly.n).toBe(2);
    expect(exp?.quarterly.average).toBeCloseTo(95); // (90+100)/2, not blended with 40
    expect(exp?.quarterly.clampedAtChange).toBe(true);
    expect(exp?.quarterly.dateRange?.start).toBe("2026-09-15");
  });

  it("Change 2: a non-% active+baselined goal is excluded from the %-engine export (no coercion)", () => {
    const rubric = makeGoal({ model: "rubric_score" });
    expect(isIcExportable(rubric)).toBe(false);
    expect(buildIcExport([rubric], [scored(rubric, "2026-09-08", 3)])).toEqual([]);
  });

  it("minor: a goal with criterion_level 0 is not exportable", () => {
    expect(isIcExportable(makeGoal({ criterion: 0 }))).toBe(false);
  });
});

// TEACH-41 — the IEP goal label in the IC export engine: carried per card, the
// cards sorted per student in IEP order, a duplicate flagged, never a blocker.
describe("M6a — IC export goal label (TEACH-41)", () => {
  const forStudent = (
    studentId: IEPGoal["student_id"],
    over: Partial<Pick<IEPGoal, "goal_label" | "status">> = {},
  ): IEPGoal => ({ ...makeGoal(), student_id: studentId, ...over });

  it("carries goalLabel (null when unlabeled) and sorts studentId → label (1 < 1a < 2 < 10, none last) → goalId", () => {
    const [s1, s2] = [newOpaqueId(), newOpaqueId()].sort();
    const s1None = forStudent(s1 as IEPGoal["student_id"]);
    const s1Ten = forStudent(s1 as IEPGoal["student_id"], { goal_label: "10" });
    const s1Two = forStudent(s1 as IEPGoal["student_id"], { goal_label: "2" });
    const s1OneA = forStudent(s1 as IEPGoal["student_id"], { goal_label: "1a" });
    const s1One = forStudent(s1 as IEPGoal["student_id"], { goal_label: "1" });
    const s2One = forStudent(s2 as IEPGoal["student_id"], { goal_label: "1" });
    const out = buildIcExport([s2One, s1None, s1Ten, s1Two, s1OneA, s1One], []);
    expect(out.map((e) => [e.studentId, e.goalLabel])).toEqual([
      [s1, "1"],
      [s1, "1a"],
      [s1, "2"],
      [s1, "10"],
      [s1, null],
      [s2, "1"],
    ]);
  });

  it("two unlabeled goals of one student fall back to goalId order", () => {
    const s = newOpaqueId();
    const a = forStudent(s);
    const b = forStudent(s);
    const out = buildIcExport([b, a], []);
    expect(out.map((e) => e.goalId)).toEqual([a.goal_id, b.goal_id].sort());
  });

  it("flags duplicateLabel on BOTH same-cohort goals, counting a mastered (non-exported) goal", () => {
    const s = newOpaqueId();
    const one = forStudent(s, { goal_label: "1" });
    const twoA = forStudent(s, { goal_label: "2" });
    const twoB = forStudent(s, { goal_label: "2" });
    const out = buildIcExport([one, twoA, twoB], []);
    expect(out.map((e) => [e.goalLabel, e.duplicateLabel])).toEqual([
      ["1", false],
      ["2", true],
      ["2", true],
    ]);
    const mastered = forStudent(s, { goal_label: "1", status: "mastered" });
    const [first] = buildIcExport([one, mastered], []);
    expect(first?.duplicateLabel).toBe(true);
  });

  it("a proposed or retired goal with the same label is no duplicate", () => {
    const s = newOpaqueId();
    const active = forStudent(s, { goal_label: "2" });
    const proposed = forStudent(s, { goal_label: "2", status: "proposed" });
    const retired = forStudent(s, { goal_label: "2", status: "retired" });
    const out = buildIcExport([active, proposed, retired], []);
    expect(out).toHaveLength(1);
    expect(out[0]?.duplicateLabel).toBe(false);
  });

  it("a missing label never blocks export", () => {
    const g = makeGoal();
    expect(g.goal_label).toBeUndefined();
    expect(isIcExportable(g)).toBe(true);
    expect(buildIcExport([g], [])).toHaveLength(1);
  });
});
