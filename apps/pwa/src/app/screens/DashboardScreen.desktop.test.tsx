import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OpaqueId } from "@teacher-assistant/schema";
import { buildSyntheticSeed } from "../../data/synthetic-seed.js";
import { DashboardScreen } from "./DashboardScreen.js";
import { buildLookups } from "./dashboard/dashboard-vm.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderDesktop() {
  const seed = buildSyntheticSeed(NOW);
  const records = seed.master;
  const lk = buildLookups(records);
  const handlers = {
    onNewGoal: vi.fn(),
    onToScore: vi.fn(),
    onBaseline: vi.fn(),
    onValidate: vi.fn(),
    onOpenScore: vi.fn(),
    onOpenDetail: vi.fn(),
    apply: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <DashboardScreen
      records={records}
      lk={lk}
      now={NOW}
      paraPendingCount={seed.paraPending.length}
      {...handlers}
      isDesktop
      renderDetailPane={(goalId: OpaqueId) => <div data-testid="pane-content">{goalId}</div>}
      validationStrip={<div data-testid="vstrip">strip</div>}
    />,
  );
  return handlers;
}

describe("DashboardScreen — desktop master-detail (U7)", () => {
  it("renders the master-detail with an auto-selected (non-empty) detail pane", () => {
    renderDesktop();
    const pane = screen.getByTestId("detail-pane");
    const content = screen.getByTestId("pane-content");
    expect(pane).toContainElement(content);
    // design Q1: the first owed goal auto-selects so the pane is never blank.
    expect(content.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("renders the full-width validation strip above the master-detail", () => {
    renderDesktop();
    expect(screen.getByTestId("vstrip")).toBeInTheDocument();
  });

  it("rows SELECT into the pane (open), never score, and drop the mobile footer actions", () => {
    renderDesktop();
    // Desktop rows are 'open …' (select), not 'score …'.
    expect(screen.getByRole("button", { name: "open Two-step equations" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "score Two-step equations" })).toBeNull();
    // The dashboard footer destinations moved to the sidebar — not on the dashboard.
    expect(screen.queryByTestId("to-score")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ New goal" })).toBeNull();
  });

  it("clicking a row selects it (accent highlight) and repaints the pane", () => {
    renderDesktop();
    const before = screen.getByTestId("pane-content").textContent;
    const rowBtn = screen.getByRole("button", { name: "open Multiply fractions" });
    fireEvent.click(rowBtn);
    expect(rowBtn.closest(".row")?.className).toContain("selected");
    // The pane now shows a different goal than the auto-selected one.
    expect(screen.getByTestId("pane-content").textContent).not.toBe(before);
  });

  it("by-student lens becomes a full-width card grid with no detail pane (design Q2)", () => {
    renderDesktop();
    const toggle = screen.getByTestId("group-toggle");
    fireEvent.click(toggle); // by period
    fireEvent.click(toggle); // by student
    const body = screen.getByTestId("dashboard-body");
    expect(body.className).toContain("scardgrid");
    expect(screen.queryByTestId("detail-pane")).toBeNull();
  });
});
