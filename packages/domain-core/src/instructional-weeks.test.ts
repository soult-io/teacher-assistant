import { describe, expect, it } from "vitest";
import {
  baselineWindowStart,
  enumerateIsoWeeks,
  instructionalWeekCount,
  instructionalWeeks,
  isoWeekId,
} from "./instructional-weeks.js";

describe("isoWeekId (ISO-8601)", () => {
  it("computes standard week numbers", () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(isoWeekId("2026-01-01")).toBe("2026-W01");
    // 2026-09-07 (Monday) → W37.
    expect(isoWeekId("2026-09-07")).toBe("2026-W37");
    // A date late in Dec can belong to ISO week 1 of the next year, but 2026-12-28
    // (Mon) is W53 of 2026.
    expect(isoWeekId("2026-12-28")).toBe("2026-W53");
  });

  it("buckets a whole week under one id", () => {
    // Mon 2026-09-07 … Sun 2026-09-13 are all W37.
    for (const d of ["2026-09-07", "2026-09-09", "2026-09-13"]) {
      expect(isoWeekId(d)).toBe("2026-W37");
    }
  });
});

describe("instructionalWeeks (the M8 gate count)", () => {
  const none = () => false;

  it("a 5-calendar-week scored span with 1 break week counts as 4 instructional weeks", () => {
    // Span W37..W41 (5 ISO weeks). Flag W39 as a calendar break.
    const span = enumerateIsoWeeks("2026-09-07", "2026-10-05");
    expect(span).toEqual(["2026-W37", "2026-W38", "2026-W39", "2026-W40", "2026-W41"]);
    const isBreak = (w: string) => w === "2026-W39";
    const weeks = instructionalWeeks({
      firstAdminDate: "2026-09-07",
      asOf: "2026-10-05",
      isNonInstructional: isBreak,
    });
    expect(weeks).toEqual(["2026-W37", "2026-W38", "2026-W40", "2026-W41"]);
    expect(weeks.length).toBe(4); // the ≥4-instructional-week gate sees 4, not 5
  });

  it("excludes weeks that are ⊘-only for the goal (per-goal, distinct from calendar)", () => {
    const count = instructionalWeekCount({
      firstAdminDate: "2026-09-07",
      asOf: "2026-10-05",
      isNonInstructional: none,
      excusedOnlyWeeks: new Set(["2026-W38", "2026-W40"]),
    });
    expect(count).toBe(3); // 5 weeks − 2 excused-only
  });

  it("returns no weeks before a goal has a first admin date", () => {
    expect(
      instructionalWeeks({ firstAdminDate: null, asOf: "2026-10-05", isNonInstructional: none }),
    ).toEqual([]);
  });
});

describe("baselineWindowStart (arc_date − N instructional weeks)", () => {
  const arc = "2026-10-05"; // W41

  it("counts back N instructional weeks, inclusive of the arc week", () => {
    // No breaks: 6 instructional weeks ending at W41 → starts at W36.
    expect(baselineWindowStart(arc, 6, () => false)).toBe("2026-W36");
  });

  it("moving the window across a break recomputes it in instructional-week terms", () => {
    // A break at W38 pushes the 6-instructional-week start one calendar week earlier.
    const withBreak = baselineWindowStart(arc, 6, (w) => w === "2026-W38");
    const withoutBreak = baselineWindowStart(arc, 6, () => false);
    expect(withoutBreak).toBe("2026-W36");
    expect(withBreak).toBe("2026-W35"); // one calendar week earlier to still span 6 instructional weeks
  });
});
