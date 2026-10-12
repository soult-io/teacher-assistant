// @vitest-environment node
import {
  asTimestamp,
  type BaselinePoint,
  type IEPGoal,
  type OpaqueId,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { baselinePointsOldestFirst, orderProposedGoals } from "./baseline-order.js";

const goal = (goalId: string, studentId: string, goalText: string) =>
  ({ goal_id: goalId, student_id: studentId, goal_text: goalText }) as unknown as IEPGoal;

const resolvers = {
  initialsOf: (id: OpaqueId) => ({ "s-1": "GH", "s-2": "ab", "s-3": "AB" })[id as string] ?? "??",
  periodLabelOf: (id: OpaqueId) => (id === "s-3" ? null : "P2"),
};

describe("orderProposedGoals (TEACH-25)", () => {
  it("orders initials, period (none last), studentId, then goal text A–Z", () => {
    const goals = [
      goal("g-1", "s-1", "Add integers"),
      goal("g-2", "s-2", "two-step equations"),
      goal("g-3", "s-2", "Add integers"),
      goal("g-4", "s-3", "Add integers"),
    ];
    const shown = (gs: readonly IEPGoal[]) =>
      orderProposedGoals(gs, resolvers).map((g) => g.goal_id);
    expect(shown(goals)).toEqual(["g-4", "g-3", "g-2", "g-1"]);
    expect(shown([...goals].reverse())).toEqual(["g-4", "g-3", "g-2", "g-1"]);
  });
});

describe("baselinePointsOldestFirst (TEACH-25)", () => {
  const pt = (id: string, date: string, ts: number) =>
    ({
      baseline_point_id: id,
      admin_date: date,
      entry_ts: asTimestamp(ts),
    }) as unknown as BaselinePoint;

  it("orders admin date, then entry time, then point id — independent of input order", () => {
    const pts = [
      pt("b", "2026-09-02", 0),
      pt("c", "2026-09-01", 5),
      pt("a", "2026-09-02", 0),
      pt("d", "2026-09-01", 1),
    ];
    const ids = (ps: readonly BaselinePoint[]) =>
      baselinePointsOldestFirst(ps).map((p) => p.baseline_point_id);
    expect(ids(pts)).toEqual(["d", "c", "a", "b"]);
    expect(ids([...pts].reverse())).toEqual(["d", "c", "a", "b"]);
  });
});
