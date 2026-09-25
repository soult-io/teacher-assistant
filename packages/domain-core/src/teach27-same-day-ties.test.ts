// TEACH-27 — same-day tie rules (ky-sped-lbd-sdi-sme ruling, 2026-09-25). SYNTHETIC
// data only. One shared oldest-first order for every grading/summary site: admin
// date, then entry time, then point id. The consistency window groups same-day
// points: a day counts only when EVERY point that day meets criterion; one
// below-criterion point that day resets the run, whatever the entry order.

import {
  asTimestamp,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type OpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  applyEdit,
  buildIcExport,
  compareArcOldestFirst,
  computeAutoStatement,
  computeQuarterlySummary,
  consistencyWindow,
} from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;
const noBreaks = () => false;
/** A deterministic, sortable id so a test can pin which way the id tiebreak would fall. */
const id = (n: number): OpaqueId =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as OpaqueId;

function makeGoal(nProbes = 4): IEPGoal {
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "solve two-step equations",
    behavior: "b",
    circumstance: "given a grade-level equations probe",
    criterion_level: 80,
    criterion_consistency: { n_probes: nProbes, phrase: `${nProbes} consecutive probes` },
    method_general: "cbm",
    method_tool: "probe",
    frequency: "weekly",
    denominator_model: "percent_correct_over_total",
    baseline_value: 50,
    baseline_source: "computed_from_baseline_points",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: "active",
    created_ts: asTimestamp(0),
    revisions: [],
    iep_end_date: iso("2027-05-29"),
  };
}

/** A scored % point: numerator IS the percent (denominator 100). */
function scored(
  goal: IEPGoal,
  adminDate: string,
  percent: number,
  entryTs: number,
  pointId: OpaqueId = newOpaqueId(),
): ProgressDataPoint {
  return {
    data_point_id: pointId,
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso(adminDate),
    entry_ts: asTimestamp(entryTs),
    state: "scored",
    numerator: percent,
    denominator_used: 100,
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

function noData(goal: IEPGoal, adminDate: string, entryTs: number): ProgressDataPoint {
  return {
    data_point_id: newOpaqueId(),
    goal_id: goal.goal_id,
    student_id: goal.student_id,
    admin_date: iso(adminDate),
    entry_ts: asTimestamp(entryTs),
    state: "no_data",
    no_data_reason: "absent",
    setting: "math_resource",
    scorer: "teacher",
    revisions: [],
  };
}

describe("shared oldest-first order", () => {
  it("orders by admin date, then entry time, then point id", () => {
    const g = makeGoal();
    const later = scored(g, "2026-09-08", 90, 5, id(1));
    const earlyDay = scored(g, "2026-09-07", 90, 99, id(2));
    const sameDayFirst = scored(g, "2026-09-08", 90, 1, id(3));
    const sorted = [later, earlyDay, sameDayFirst].sort(compareArcOldestFirst);
    expect(sorted.map((p) => p.data_point_id)).toEqual([id(2), id(3), id(1)]);
  });

  it("a full date + entry-time tie falls to the id, identically at every site", () => {
    const g = makeGoal();
    // Two points share date AND entry time; oldest-first puts the HIGHER id first,
    // so the lower id (7) is the later one — the last-5 window and the IC week keep it.
    const low = scored(g, "2026-09-01", 50, 100, id(7));
    const high = scored(g, "2026-09-01", 0, 100, id(9));
    const tail = ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"].map((d, i) =>
      scored(g, d, 100, 200 + i),
    );
    expect([low, high].sort(compareArcOldestFirst).map((p) => p.data_point_id)).toEqual([
      id(9),
      id(7),
    ]);
    // (50 + 100×4) / 5 = 90 — the id-7 point is the 5th-from-last.
    expect(computeQuarterlySummary(g, [low, high, ...tail]).average).toBe(90);
    const [card] = buildIcExport([g], [high, low]);
    expect(card?.weekly[0]?.percent).toBe(50);
  });
});

describe("consistency window — same-day grouping", () => {
  // Three prior passing days (run 3 of 4), then a day with a 90 and a 60.
  function mixedDay(firstPct: number, secondPct: number) {
    const g = makeGoal(4);
    const points = [
      scored(g, "2026-09-01", 90, 1),
      scored(g, "2026-09-02", 90, 2),
      scored(g, "2026-09-03", 90, 3),
      scored(g, "2026-09-04", firstPct, 10),
      scored(g, "2026-09-04", secondPct, 20),
    ];
    return consistencyWindow(g, points);
  }

  it("90 then 60 and 60 then 90 on one day give the same run and met", () => {
    const a = mixedDay(90, 60);
    const b = mixedDay(60, 90);
    expect(a.run).toBe(0);
    expect(b.run).toBe(0);
    expect(a.met).toBe(false);
    expect(b.met).toBe(false);
    expect(a.windowMetDate).toBeUndefined();
    expect(b.windowMetDate).toBeUndefined();
  });

  it("a mixed day's passing point does not start a new run", () => {
    const g = makeGoal(2);
    const r = consistencyWindow(g, [
      scored(g, "2026-09-01", 60, 1),
      scored(g, "2026-09-01", 90, 2),
      scored(g, "2026-09-02", 90, 3),
    ]);
    // Only 09-02's single point counts after the reset.
    expect(r.run).toBe(1);
    expect(r.met).toBe(false);
  });

  it("an all-passing day adds its whole count; windowMetDate is the day the run reaches required", () => {
    const g = makeGoal(4);
    const r = consistencyWindow(g, [
      scored(g, "2026-09-01", 90, 1),
      scored(g, "2026-09-02", 90, 2),
      scored(g, "2026-09-03", 85, 3),
      scored(g, "2026-09-03", 95, 4),
      scored(g, "2026-09-03", 80, 5),
    ]);
    expect(r.run).toBe(5);
    expect(r.met).toBe(true);
    expect(r.windowMetDate).toBe("2026-09-03");
  });

  it("a ⊘ still pauses the run and never resets it", () => {
    const g = makeGoal(4);
    const r = consistencyWindow(g, [
      scored(g, "2026-09-01", 90, 1),
      scored(g, "2026-09-02", 90, 2),
      noData(g, "2026-09-03", 3),
      scored(g, "2026-09-04", 90, 4),
      noData(g, "2026-09-04", 5),
      scored(g, "2026-09-04", 90, 6),
    ]);
    expect(r.run).toBe(4);
    expect(r.met).toBe(true);
    expect(r.windowMetDate).toBe("2026-09-04");
  });

  it("a mixed day after the window was met resets run/met but keeps windowMetDate", () => {
    const g = makeGoal(4);
    const r = consistencyWindow(g, [
      scored(g, "2026-09-01", 90, 1),
      scored(g, "2026-09-02", 90, 2),
      scored(g, "2026-09-03", 90, 3),
      scored(g, "2026-09-04", 90, 4),
      scored(g, "2026-09-05", 90, 5),
      scored(g, "2026-09-05", 60, 6),
    ]);
    expect(r.run).toBe(0);
    expect(r.met).toBe(false);
    expect(r.windowMetDate).toBe("2026-09-04");
  });

  it("sameDayMixed marks every glyph of a day with both a met and a not-met point", () => {
    const g = makeGoal(4);
    const mixedA = scored(g, "2026-09-02", 90, 20, id(1));
    const mixedB = scored(g, "2026-09-02", 60, 10, id(2));
    const clean = scored(g, "2026-09-03", 90, 30, id(3));
    const cleanPair = scored(g, "2026-09-01", 90, 1, id(4));
    const r = consistencyWindow(g, [clean, mixedA, cleanPair, mixedB]);
    // Entry order (oldest first), one glyph per point.
    expect(r.recentGlyphs).toEqual([
      { dataPointId: id(4), meets: true, offBasis: false, sameDayMixed: false },
      { dataPointId: id(2), meets: false, offBasis: false, sameDayMixed: true },
      { dataPointId: id(1), meets: true, offBasis: false, sameDayMixed: true },
      { dataPointId: id(3), meets: true, offBasis: false, sameDayMixed: false },
    ]);
  });

  it("sameDayMixed reflects the whole day even when the glance trims part of it", () => {
    const g = makeGoal(2);
    const r = consistencyWindow(g, [
      scored(g, "2026-09-01", 60, 1),
      scored(g, "2026-09-01", 90, 2),
      scored(g, "2026-09-02", 90, 3),
    ]);
    expect(r.recentGlyphs.map((x) => x.sameDayMixed)).toEqual([true, false]);
  });

  it("two all-passing points on one day are not mixed", () => {
    const g = makeGoal(2);
    const r = consistencyWindow(g, [
      scored(g, "2026-09-01", 90, 1),
      scored(g, "2026-09-01", 85, 2),
    ]);
    expect(r.recentGlyphs.map((x) => x.sameDayMixed)).toEqual([false, false]);
  });
});

describe("quarterly last-5 window — tie at the 5th-from-last position", () => {
  // 6 points; the 1st and 2nd share a date, so exactly one of them is the 5th-from-last.
  function summary(firstId: OpaqueId, secondId: OpaqueId) {
    const g = makeGoal();
    const points = [
      scored(g, "2026-09-01", 0, 100, firstId), // entered first → falls OUT of the window
      scored(g, "2026-09-01", 50, 200, secondId), // entered second → IN the window
      scored(g, "2026-09-02", 100, 300),
      scored(g, "2026-09-03", 100, 400),
      scored(g, "2026-09-04", 100, 500),
      scored(g, "2026-09-05", 100, 600),
    ];
    return computeQuarterlySummary(g, points);
  }

  it("is settled by entry time, whichever id sorts first", () => {
    const lowFirst = summary(id(1), id(2));
    const highFirst = summary(id(2), id(1));
    // (50 + 100×4) / 5 = 90
    expect(lowFirst.average).toBe(90);
    expect(highFirst.average).toBe(90);
    expect(lowFirst.n).toBe(5);
  });
});

describe("IC weekly value — tie at the week's last scored point", () => {
  function weekly(firstId: OpaqueId, secondId: OpaqueId) {
    const g = makeGoal();
    const points = [
      scored(g, "2026-09-07", 40, 10),
      scored(g, "2026-09-09", 70, 100, firstId), // entered first
      scored(g, "2026-09-09", 30, 200, secondId), // entered LAST → the weekly value
      noData(g, "2026-09-09", 300), // a later ⊘ never beats a scored point
    ];
    const [card] = buildIcExport([g], points);
    return card?.weekly;
  }

  it("takes the last-entered point on the latest date, independent of ids", () => {
    const a = weekly(id(1), id(2));
    const b = weekly(id(2), id(1));
    expect(a).toHaveLength(1);
    expect(a?.[0]?.percent).toBe(30);
    expect(b?.[0]?.percent).toBe(30);
  });
});

describe("≥8 trend gate counts points, not days", () => {
  it("passes with 8 points over 4 weeks when some share a day", () => {
    const g = makeGoal();
    // 8 points on 5 distinct days spanning 4 ISO weeks.
    const points = [
      scored(g, "2026-09-07", 60, 1),
      scored(g, "2026-09-07", 62, 2),
      scored(g, "2026-09-14", 66, 3),
      scored(g, "2026-09-14", 68, 4),
      scored(g, "2026-09-21", 72, 5),
      scored(g, "2026-09-28", 76, 6),
      scored(g, "2026-09-28", 78, 7),
      scored(g, "2026-09-28", 80, 8),
    ];
    const s = computeAutoStatement(g, "AB", points, { isNonInstructional: noBreaks });
    expect(s?.slots.totalPoints).toBe(8);
    expect(s?.indeterminateReason).not.toBe("below_point_gate");
    expect(s?.indeterminateReason).not.toBe("below_week_gate");
    // Rising 60→80 over the period projects on-track by the IEP end — a real trend claim.
    expect(s?.variant).toBe("on_track");
  });
});

describe("regenerating point ids changes no output when entry times differ", () => {
  function dataset(g: IEPGoal): ProgressDataPoint[] {
    // Same-day pairs throughout, with deliberately different values, so any
    // id-driven order would move the quarterly/prior windows, the four-point tail,
    // the IC weekly value, and the consistency run.
    const days = [
      "2026-09-07",
      "2026-09-09",
      "2026-09-14",
      "2026-09-16",
      "2026-09-21",
      "2026-09-23",
      "2026-09-28",
      "2026-09-30",
    ];
    const out: ProgressDataPoint[] = [];
    days.forEach((d, i) => {
      out.push(scored(g, d, 55 + i * 4, i * 10 + 1));
      out.push(scored(g, d, 85 - i, i * 10 + 2));
    });
    return out;
  }

  function outputs(g: IEPGoal, points: readonly ProgressDataPoint[]) {
    const c = consistencyWindow(g, points);
    return {
      consistency: {
        ...c,
        recentGlyphs: c.recentGlyphs.map(({ dataPointId: _d, ...rest }) => rest),
      },
      quarterly: computeQuarterlySummary(g, points),
      ic: buildIcExport([g], points),
      statement: computeAutoStatement(g, "AB", points, { isNonInstructional: noBreaks }),
    };
  }

  it("is id-independent", () => {
    const g = makeGoal();
    const points = dataset(g);
    const before = outputs(g, points);
    for (let trial = 0; trial < 5; trial++) {
      const regenerated = points.map((p) => ({ ...p, data_point_id: newOpaqueId() }));
      expect(outputs(g, regenerated)).toEqual(before);
    }
    // Ids in strictly reversed order relative to entry time.
    const reversed = points.map((p, i) => ({ ...p, data_point_id: id(1000 - i) }));
    const forward = points.map((p, i) => ({ ...p, data_point_id: id(i) }));
    expect(outputs(g, reversed)).toEqual(before);
    expect(outputs(g, forward)).toEqual(before);
  });
});

describe("applyEdit never changes entry_ts", () => {
  it("keeps the original entry time on a value edit and a ⊘ edit", () => {
    const g = makeGoal();
    const p = scored(g, "2026-09-07", 60, 12345);
    const edited = applyEdit(p, { numerator: 70 }, "teacher", asTimestamp(99999));
    expect(edited.entry_ts).toBe(12345);
    const toNoData = applyEdit(
      p,
      { state: "no_data", no_data_reason: "absent" },
      "teacher",
      asTimestamp(99999),
    );
    expect(toNoData.entry_ts).toBe(12345);
  });
});
