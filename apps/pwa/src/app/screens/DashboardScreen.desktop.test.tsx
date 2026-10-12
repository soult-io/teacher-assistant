import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DecryptedRecords } from "../../data/repository.js";
import { buildSyntheticSeed } from "../../data/synthetic-seed.js";
import { DashboardScreen } from "./DashboardScreen.js";
import { buildLookups } from "./dashboard/dashboard-vm.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderDesktop(records?: DecryptedRecords) {
  const seed = buildSyntheticSeed(NOW);
  const master = records ?? seed.master;
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
      records={master}
      lk={buildLookups(master)}
      now={NOW}
      paraPendingCount={seed.paraPending.length}
      {...handlers}
      isDesktop
      validationStrip={<div data-testid="vstrip">strip</div>}
    />,
  );
  return handlers;
}

/** Cycle the group toggle until it reads `label`. */
function groupBy(label: string) {
  const toggle = screen.getByTestId("group-toggle");
  for (let i = 0; i < 3 && !(toggle.textContent ?? "").includes(label); i++) {
    fireEvent.click(toggle);
  }
  expect(toggle).toHaveTextContent(`Group: ${label}`);
}

/** The card sections of the dashboard body: label text → the initials on its cards. */
function sections(): Record<string, string[]> {
  const body = screen.getByTestId("dashboard-body");
  return Object.fromEntries(
    [...body.querySelectorAll(".cardsection")].map((section) => [
      section.querySelector(".grouplabel")?.textContent ?? "",
      [...section.querySelectorAll(".scard .shead .name")].map((n) => n.textContent ?? ""),
    ]),
  );
}

/** The goal titles on one student's card, in the order shown. */
function cardGoals(initials: string): string[] {
  const card = [...document.querySelectorAll(".scard")].find(
    (c) => c.querySelector(".shead .name")?.textContent === initials,
  );
  return [...(card?.querySelectorAll(".sgoal .g") ?? [])].map((g) => g.textContent ?? "");
}

describe("DashboardScreen — desktop student cards (TEACH-43)", () => {
  it("lands on owes-first with a card grid: no detail pane, no goal rows, no graph", () => {
    const { onOpenDetail } = renderDesktop();
    expect(screen.getByTestId("group-toggle")).toHaveTextContent("Group: owes-first");
    expect(screen.getByTestId("dashboard-body").querySelector(".scardgrid")).not.toBeNull();
    expect(screen.queryByTestId("detail-pane")).toBeNull();
    expect(screen.queryByTestId("goal-row")).toBeNull();
    expect(screen.queryByRole("img", { name: "progress trend" })).toBeNull();
    // Nothing is auto-selected or auto-opened on mount.
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it("owes-first splits students into 'Owes a point' and 'Done this week' card sections", () => {
    renderDesktop();
    const s = sections();
    expect(Object.keys(s)).toEqual(["Owes a point", "Done this week"]);
    expect(s["Owes a point"]?.length).toBeGreaterThan(0);
    expect(s["Done this week"]?.length).toBeGreaterThan(0);
    // Each student is on exactly one card.
    const all = [...(s["Owes a point"] ?? []), ...(s["Done this week"] ?? [])];
    expect(new Set(all).size).toBe(all.length);
    // Every card under "Owes a point" owes; every card under "Done this week" does not.
    const body = screen.getByTestId("dashboard-body");
    const [owes, done] = [...body.querySelectorAll(".cardsection")];
    expect(
      [...(owes?.querySelectorAll(".tally") ?? [])].every((t) => t.className.includes("todo")),
    ).toBe(true);
    expect(
      [...(done?.querySelectorAll(".tally") ?? [])].every((t) => t.className.includes("done")),
    ).toBe(true);
  });

  it("an owing student's card shows all their goals in IEP order (TEACH-41), not only the owed one", () => {
    renderDesktop();
    expect(sections()["Owes a point"]).toContain("AB");
    const goals = cardGoals("AB");
    expect(goals).toHaveLength(2);
    expect(goals[0]).toMatch(/^Goal 1.*Two-step equations$/);
    expect(goals[1]).toMatch(/^Goal 2.*Add integers$/);
  });

  it("by period gives each period its own card section, with no goal rows", () => {
    renderDesktop();
    groupBy("by period");
    const s = sections();
    expect(Object.keys(s).length).toBeGreaterThan(0);
    for (const [label, initials] of Object.entries(s)) {
      expect(label).toMatch(/^Period /);
      expect(initials.length).toBeGreaterThan(0);
    }
    expect(s["Period P2"]).toEqual(expect.arrayContaining(["AB", "CD"]));
    expect(screen.queryByTestId("goal-row")).toBeNull();
  });

  it("by student is the plain card grid", () => {
    renderDesktop();
    groupBy("by student");
    const body = screen.getByTestId("dashboard-body");
    expect(body.className).toContain("scardgrid");
    expect(body.querySelectorAll(".scard").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("goal-row")).toBeNull();
  });

  it("↗ opens Goal Detail and goal text opens Quick-Score", () => {
    const { onOpenDetail, onOpenScore } = renderDesktop();
    fireEvent.click(screen.getByRole("button", { name: "trend and history Goal 2, Add integers" }));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenScore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "score Goal 1, Two-step equations" }));
    expect(onOpenScore).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });

  it("keeps the validation strip and drops the mobile footer actions", () => {
    renderDesktop();
    expect(screen.getByTestId("vstrip")).toBeInTheDocument();
    expect(screen.queryByTestId("to-score")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ New goal" })).toBeNull();
  });

  it("keeps the 'Nothing owing right now.' note when no student owes", () => {
    const master = buildSyntheticSeed(NOW).master;
    renderDesktop({ ...master, goals: master.goals.filter((g) => g.status !== "active") });
    expect(screen.getByText("Nothing owing right now.")).toBeInTheDocument();
  });
});
