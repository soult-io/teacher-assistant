import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSeed } from "../../data/synthetic-seed.js";
import { DashboardScreen } from "./DashboardScreen.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderDashboard(onNewGoal = vi.fn()) {
  render(<DashboardScreen records={buildSyntheticSeed(NOW)} now={NOW} onNewGoal={onNewGoal} />);
  return { onNewGoal };
}

describe("DashboardScreen (U2)", () => {
  it("renders the header and the pending-para note", () => {
    renderDashboard();
    expect(screen.getByTestId("header-line")).toHaveTextContent(
      "2 of 4 collectable scored · 1 excused · 2 owe",
    );
    // Both the header summary and the owes row carry a pending-para note.
    expect(screen.getByText(/1 para point.*awaiting your OK/)).toBeInTheDocument(); // header
    expect(screen.getByText("⏳ para point — awaiting your OK")).toBeInTheDocument(); // row
  });

  it("cycles the three grouping lenses", () => {
    renderDashboard();
    const toggle = screen.getByTestId("group-toggle");
    expect(toggle).toHaveTextContent("owes-first");
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("by period");
    // by-period shows a period section header
    expect(screen.getByText("Period P2")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("by student");
    // by-student shows the student cards (AB owes → first card)
    expect(screen.getAllByText("AB").length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("owes-first");
  });

  it("toggles the score-later flag on an owes row", () => {
    renderDashboard();
    const flags = screen.getAllByRole("button", { name: "Gave it, score later" });
    expect(flags.length).toBeGreaterThan(0);
    const flag = flags[0];
    if (flag === undefined) {
      throw new Error("expected a score-later button");
    }
    expect(flag).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(flag);
    expect(flag).toHaveAttribute("aria-pressed", "true");
  });

  it("owes-first section lists the owing goals under 'Owes a point'", () => {
    renderDashboard();
    const body = screen.getByTestId("dashboard-body");
    expect(within(body).getByText("Owes a point")).toBeInTheDocument();
    expect(within(body).getByText("Done this week")).toBeInTheDocument();
  });

  it("owes rows show probe + criterion context (C4)", () => {
    renderDashboard();
    const body = screen.getByTestId("dashboard-body").textContent ?? "";
    expect(body).toContain("5-item probe");
    expect(body).toContain("80% × 4 consecutive probes");
  });

  it("by-student owes rows carry the score-later flag and a status-coloured value (C1/C3)", () => {
    renderDashboard();
    const toggle = screen.getByTestId("group-toggle");
    fireEvent.click(toggle); // by period
    fireEvent.click(toggle); // by student
    // C1: the ⚑ flag is present on owes rows in the by-student lens too.
    expect(screen.getAllByRole("button", { name: "Gave it, score later" }).length).toBeGreaterThan(
      0,
    );
    // C3: the nested "owes" value carries the amber status class (.sval.owes).
    const owesValues = screen.getAllByText("owes");
    expect(
      owesValues.some((el) => el.className.includes("sval") && el.className.includes("owes")),
    ).toBe(true);
  });

  it("routes + New goal to its handler", () => {
    const { onNewGoal } = renderDashboard();
    fireEvent.click(screen.getByRole("button", { name: "+ New goal" }));
    expect(onNewGoal).toHaveBeenCalledOnce();
  });
});
