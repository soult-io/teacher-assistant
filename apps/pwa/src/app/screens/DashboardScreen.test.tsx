import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSeed } from "../../data/synthetic-seed.js";
import { DashboardScreen } from "./DashboardScreen.js";
import { buildLookups } from "./dashboard/dashboard-vm.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderDashboard() {
  const records = buildSyntheticSeed(NOW);
  const lk = buildLookups(records);
  const handlers = {
    onNewGoal: vi.fn(),
    onToScore: vi.fn(),
    onBaseline: vi.fn(),
    onOpenScore: vi.fn(),
    onOpenDetail: vi.fn(),
    apply: vi.fn().mockResolvedValue(undefined),
  };
  render(<DashboardScreen records={records} lk={lk} now={NOW} {...handlers} />);
  return handlers;
}

describe("DashboardScreen (U2/U3)", () => {
  it("renders the header, pending note, and probe/criterion context", () => {
    renderDashboard();
    expect(screen.getByTestId("header-line")).toHaveTextContent(
      "2 of 4 collectable scored · 1 excused · 2 owe",
    );
    expect(screen.getByText(/1 para point.*awaiting your OK/)).toBeInTheDocument();
    const body = screen.getByTestId("dashboard-body").textContent ?? "";
    expect(body).toContain("5-item probe");
    expect(body).toContain("80% × 4 consecutive probes");
  });

  it("cycles the three grouping lenses", () => {
    renderDashboard();
    const toggle = screen.getByTestId("group-toggle");
    expect(toggle).toHaveTextContent("owes-first");
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("by period");
    expect(screen.getByText("Period P2")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("by student");
    expect(screen.getAllByText("AB").length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("owes-first");
  });

  it("owes-first splits into 'Owes a point' and 'Done this week'", () => {
    renderDashboard();
    const body = screen.getByTestId("dashboard-body");
    expect(within(body).getByText("Owes a point")).toBeInTheDocument();
    expect(within(body).getByText("Done this week")).toBeInTheDocument();
  });

  it("by-student owes rows carry the ⚑ flag and a status-coloured value (C1/C3)", () => {
    renderDashboard();
    const toggle = screen.getByTestId("group-toggle");
    fireEvent.click(toggle); // by period
    fireEvent.click(toggle); // by student
    expect(screen.getAllByRole("button", { name: "Gave it, score later" }).length).toBeGreaterThan(
      0,
    );
    const owesValues = screen.getAllByText("owes");
    expect(
      owesValues.some((el) => el.className.includes("sval") && el.className.includes("owes")),
    ).toBe(true);
  });

  it("tapping an owes row opens the score sheet target", () => {
    const { onOpenScore } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "score Two-step equations" }));
    expect(onOpenScore).toHaveBeenCalledOnce();
  });

  it("every goal has a ↗ trend button that opens Goal Detail (D2 reachability)", () => {
    const { onOpenDetail } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "trend and history Two-step equations" }));
    expect(onOpenDetail).toHaveBeenCalledOnce();
  });

  it("the ⚑ flag writes a bookmark via apply", () => {
    const { apply } = renderDashboard();
    const flags = screen.getAllByRole("button", { name: "Gave it, score later" });
    const flag = flags[0];
    if (flag === undefined) {
      throw new Error("expected a score-later button");
    }
    fireEvent.click(flag);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("routes + New goal and To-score to their handlers", () => {
    const { onNewGoal, onToScore } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "+ New goal" }));
    expect(onNewGoal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("to-score"));
    expect(onToScore).toHaveBeenCalledOnce();
  });
});
