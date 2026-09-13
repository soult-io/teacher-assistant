import { asTimestamp, type IEPGoal, newOpaqueId } from "@teacher-assistant/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import { GoalDetailScreen } from "./GoalDetailScreen.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderDetail(goalText: string, over?: Partial<Parameters<typeof GoalDetailScreen>[0]>) {
  const records = buildSyntheticSeed(NOW).master;
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
      isNonInstructional={() => false}
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

  // ── PASS-WITH-CHANGES batch ─────────────────────────────────────────────────

  it("DM-1: the consistency glance is painted from the engine, flagging an off-basis probe", () => {
    // "Scientific notation" carries a teacher-counted off-basis probe inside its
    // recent window → its glyph gets the off-basis ring (win-off), engine-classified.
    renderDetail("Scientific notation");
    const glance = screen.getByTestId("consistency-window");
    expect(glance.querySelector(".win-off")).not.toBeNull();
  });

  it("DF-2: the ARC history table carries the Setting column", () => {
    renderDetail("Add integers");
    expect(screen.getByRole("columnheader", { name: "Setting" })).toBeInTheDocument();
    expect(screen.getAllByText("Resource").length).toBeGreaterThan(0);
  });

  it("DF-1/DF-7: an IC-exportable goal exposes both copy paths", () => {
    renderDetail("Add integers");
    expect(screen.getByTestId("copy-quarterly")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy to IC" })).toBeInTheDocument();
  });

  it("DF-1/DF-7: a non-IC-exportable (proposed) goal has NO copy path and no statement", () => {
    // A proposed goal fails the structural export guard — no draft statement, and no
    // IC copy button on the quarterly card.
    const proposed: IEPGoal = {
      goal_id: newOpaqueId(),
      student_id: newOpaqueId(),
      goal_text: "Proposed goal",
      behavior: "b",
      circumstance: "given a 5-item probe",
      criterion_level: 80,
      criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
      method_general: "cbm",
      method_tool: "5-item probe",
      frequency: "weekly",
      denominator_model: "percent_correct_over_total",
      accom_mod: "none",
      setting_default: "math_resource",
      valid_settings: ["math_resource"],
      status: "proposed",
      created_ts: asTimestamp(0),
      revisions: [],
    };
    render(
      <GoalDetailScreen
        goal={proposed}
        points={[]}
        observations={[]}
        initials="ZZ"
        periodLabel={null}
        probeLabel="5-item probe"
        isNonInstructional={() => false}
        onBack={vi.fn()}
        onAddPoint={vi.fn()}
        onEditPoint={vi.fn()}
        onAckMastery={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("copy-quarterly")).toBeNull();
    expect(screen.queryByTestId("auto-statement")).toBeNull();
  });

  it("DF-3: the three honesty info tips are present", () => {
    renderDetail("Multiply fractions"); // a mastery-candidate goal → all three tips render
    expect(
      screen.getByText(/A ⊘ pauses the run, it never breaks or resets it/),
    ).toBeInTheDocument();
    expect(screen.getByText(/A report-card figure/)).toBeInTheDocument();
    expect(screen.getByText(/Acknowledging flags the goal for ARC/)).toBeInTheDocument();
  });

  it("DF-4: the trend chart shows the baseline caption", () => {
    renderDetail("Add integers"); // baseline 40
    expect(screen.getByText("base 40%")).toBeInTheDocument();
  });

  it("clarifier: an INDETERMINATE statement surfaces the gate math", () => {
    renderDetail("Multiply fractions"); // 5 points → below_point_gate (needs 3 more)
    expect(screen.getByTestId("indeterminate-hint")).toHaveTextContent(
      "Needs 3 more scored data points",
    );
  });

  it("clarifier: the two-average divergence is explained when a counted off-basis point is averaged", () => {
    renderDetail("Scientific notation"); // F4 counts the off-basis point; M8 excludes it
    expect(screen.getByTestId("two-average-clarifier")).toBeInTheDocument();
  });
});
