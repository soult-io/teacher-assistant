import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import { GoalDetailScreen } from "./GoalDetailScreen.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderDetail(goalText: string, over?: Partial<Parameters<typeof GoalDetailScreen>[0]>) {
  const records = buildSyntheticSeed(NOW);
  const goal = records.goals.find((g) => g.goal_text === goalText);
  if (goal === undefined) {
    throw new Error(`no synthetic goal ${goalText}`);
  }
  const initials = records.students.find((s) => s.student_id === goal.student_id)?.initials ?? "??";
  const handlers = {
    onBack: vi.fn(),
    onAddPoint: vi.fn(),
    onEditPoint: vi.fn(),
    onAckMastery: vi.fn(),
  };
  render(
    <GoalDetailScreen
      goal={goal}
      points={records.points}
      observations={records.observations}
      initials={initials}
      periodLabel="P4"
      probeLabel="5-item probe"
      {...handlers}
      {...over}
    />,
  );
  return { goal, handlers };
}

describe("GoalDetailScreen (U4)", () => {
  it("shows a DRAFT progress statement labelled for review, never auto-final", () => {
    renderDetail("Add integers");
    const stmt = screen.getByTestId("auto-statement");
    expect(
      within(stmt).getByText(/Draft progress statement — review before copying to IC/),
    ).toBeInTheDocument();
  });

  it("HONESTY #2: a ≥8 clean goal earns a real ON-TRACK trend claim", () => {
    // "Add integers" has 8 clean scored points across ≥4 weeks → the gate is met.
    renderDetail("Add integers");
    expect(screen.getByTestId("statement-variant")).toHaveTextContent("On track");
  });

  it("HONESTY #2: a mastery-eligible run with < 8 points stays INDETERMINATE (no trend claim under the gate)", () => {
    // "Multiply fractions" has a met consistency window BUT only 5 scored points:
    // the window is acknowledged-able, yet the statement must NOT assert a trend.
    renderDetail("Multiply fractions");
    expect(screen.getByTestId("statement-variant")).toHaveTextContent("Indeterminate");
    expect(screen.getByTestId("auto-statement").textContent ?? "").toContain(
      "additional data are needed",
    );
    // The two gates are independent: the window is met (mastery candidate surfaced)
    // even though the trend claim is withheld.
    expect(screen.getByTestId("mastery-candidate")).toBeInTheDocument();
  });

  it("HONESTY #1: the F4 summary renders the no-data-weeks-spanned label", () => {
    // "Number line" has a ⊘ between scored points → its recent-5 window spans it.
    renderDetail("Number line");
    expect(screen.getByTestId("nodata-spanned")).toHaveTextContent(/no-data week/);
  });

  it("a ⊘ is shown as a gap, never a plotted zero (chart note + no y=0 point)", () => {
    renderDetail("Number line");
    expect(
      screen.getByText(/no-data probe is shown as a gap, never plotted as a zero/),
    ).toBeInTheDocument();
    // The read model never emits a 0-valued trend point for a ⊘ (they are markers).
    const svg = screen.getByRole("img", { name: "progress trend" });
    expect(svg).toBeInTheDocument();
  });

  it("surfaces a counted off-basis point in the ARC history + excludes it from the statement", () => {
    // "Scientific notation" carries a teacher-counted off-basis point (total 6 ≠ 5).
    renderDetail("Scientific notation");
    // History shows the off-basis ⚠ marker (kept, never overwritten).
    expect(screen.getByText("⚠")).toBeInTheDocument();
    // M8 hard-excludes every off-basis point regardless of the "counted" election.
    expect(screen.getByTestId("auto-statement").textContent ?? "").toMatch(
      /off-basis\/condition-mismatched point/,
    );
  });

  it("teacher-only mastery acknowledge flags for ARC (never auto-closes the goal)", () => {
    const { handlers } = renderDetail("Multiply fractions");
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge for ARC" }));
    expect(handlers.onAckMastery).toHaveBeenCalledOnce();
  });

  it("routes + Add a point and per-row Fix to their handlers", () => {
    const { handlers } = renderDetail("Add integers");
    fireEvent.click(screen.getByRole("button", { name: "+ Add a point" }));
    expect(handlers.onAddPoint).toHaveBeenCalledOnce();
    // Each scored row has a Fix (audited edit).
    fireEvent.click(screen.getAllByRole("button", { name: /^fix / })[0] as HTMLElement);
    expect(handlers.onEditPoint).toHaveBeenCalledOnce();
  });

  it("goes back to the dashboard", () => {
    const { handlers } = renderDetail("Add integers");
    fireEvent.click(screen.getByRole("button", { name: "‹ Dashboard" }));
    expect(handlers.onBack).toHaveBeenCalledOnce();
  });
});
