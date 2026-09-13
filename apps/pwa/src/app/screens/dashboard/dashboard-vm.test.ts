// @vitest-environment node
import { buildWeeklyDashboard, groupDashboard } from "@teacher-assistant/store";
import { describe, expect, it } from "vitest";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import {
  buildLookups,
  buildStudentCards,
  orderPeriodGroups,
  orderRowsByStudent,
  periodLabelOfGroup,
  toRowVM,
} from "./dashboard-vm.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function fixture() {
  const seed = buildSyntheticSeed(NOW);
  const lk = buildLookups(seed);
  const dash = buildWeeklyDashboard({
    goals: seed.goals,
    points: seed.points,
    asOf: NOW,
    isNonInstructional: () => false,
    periodByStudent: lk.periodByStudent,
  });
  const goalId = (text: string) =>
    seed.goals.find((g) => g.goal_text === text)?.goal_id ?? "missing";
  return { seed, lk, dash, goalId };
}

describe("dashboard view-models", () => {
  it("marks the pending-para goal and only that one", () => {
    const { lk, goalId } = fixture();
    expect(lk.pendingGoalIds.has(goalId("Two-step equations"))).toBe(true); // has a pending para point
    expect(lk.pendingGoalIds.has(goalId("Add integers"))).toBe(false); // scored, not pending
  });

  it("resolves a row to its display attributes", () => {
    const { lk, dash, goalId } = fixture();
    const row = dash.rows.find((r) => r.goalId === goalId("Two-step equations"));
    if (row === undefined) {
      throw new Error("expected the Two-step equations row on the dashboard");
    }
    const vm = toRowVM(row, lk);
    expect(vm).toMatchObject({
      initials: "AB",
      goalText: "Two-step equations",
      state: "owes",
      periodLabel: "P2",
      pending: true,
    });
  });

  it("orders by-student cards owes-first then by initials (design §E.4)", () => {
    const { lk, dash } = fixture();
    const cards = buildStudentCards(groupDashboard(dash.rows, "by_student"), lk);
    // AB + CD both owe (todo>0) → first, alphabetical; EF is fully scored → last.
    expect(cards.map((c) => c.initials)).toEqual(["AB", "CD", "EF"]);
    expect(cards[0]?.todo).toBe(1);
    expect(cards[2]?.todo).toBe(0);
  });

  it("orders by-period groups by label", () => {
    const { lk, dash } = fixture();
    const ordered = orderPeriodGroups(groupDashboard(dash.rows, "by_period"), lk);
    expect(ordered.map((g) => periodLabelOfGroup(g, lk))).toEqual(["P2", "P4"]);
  });

  it("resolves probe + criterion for a row from goal fields (C4, no store change)", () => {
    const { lk, dash, goalId } = fixture();
    const row = dash.rows.find((r) => r.goalId === goalId("Two-step equations"));
    if (row === undefined) {
      throw new Error("expected the Two-step equations row");
    }
    const vm = toRowVM(row, lk);
    expect(vm.probe).toBe("5-item probe");
    expect(vm.criterion).toBe("80% × 4 consecutive probes");
  });

  it("orders within-group rows by initials so a student's goals stay adjacent (C2)", () => {
    const { lk, dash } = fixture();
    const inits = orderRowsByStudent(dash.rows.map((r) => toRowVM(r, lk))).map((v) => v.initials);
    // Non-decreasing by initials (ASCII code points) — students grouped together.
    expect(inits).toEqual([...inits].sort());
  });
});
