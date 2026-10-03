import { fireEvent, render, screen, within } from "@testing-library/react";
import { newOpaqueId } from "@teacher-assistant/schema";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import { ADOPT_FIX_LABEL, ADOPT_NEEDS_LABEL, BaselineScreen } from "./BaselineScreen.js";

const NOW = new Date("2026-09-14T12:00:00Z");

type Records = ReturnType<typeof buildSyntheticSeed>["master"];

function renderBaseline(edit: (records: Records) => Records = (r) => r) {
  const records = edit(buildSyntheticSeed(NOW).master);
  const initialsById = new Map(records.students.map((s) => [s.student_id, s.initials]));
  const handlers = {
    onBack: vi.fn(),
    onNewGoal: vi.fn(),
    onAddBaselinePoint: vi.fn(),
    onAdopt: vi.fn(),
    onEditArcDate: vi.fn().mockReturnValue(null),
    onSetGoalLabel: vi.fn(),
  };
  render(
    <BaselineScreen
      records={records}
      initialsById={initialsById}
      periodLabelByStudent={() => "P4"}
      isNonInstructional={() => false}
      {...handlers}
    />,
  );
  return handlers;
}

/** The seed with GH's proposed goal labelled `label`, plus an ACTIVE GH goal numbered `activeLabel`. */
function withGhLabels(label: string, activeLabel: string | null) {
  return (records: Records): Records => {
    const proposed = records.goals.find((g) => g.status === "proposed");
    if (proposed === undefined) {
      throw new Error("expected the seed's proposed goal");
    }
    const goals = records.goals.map((g) =>
      g.goal_id === proposed.goal_id ? { ...g, goal_label: label } : g,
    );
    if (activeLabel !== null) {
      goals.push({
        ...proposed,
        goal_id: newOpaqueId(),
        goal_text: "Order of operations",
        status: "active",
        goal_label: activeLabel,
        baseline_value: 30,
        baseline_source: "eval",
      });
    }
    return { ...records, goals };
  };
}

describe("BaselineScreen (U5)", () => {
  it("renders the proposed card with an ESTIMATE and toggles average ↔ median-of-3", () => {
    renderBaseline();
    const card = screen.getByTestId("proposed-card");
    const estimate = within(card).getByTestId("baseline-estimate");
    // Seed baseline points 20/40/40 → mean 33%, median 40%.
    expect(estimate).toHaveTextContent("33%");
    expect(estimate).toHaveTextContent("average");
    fireEvent.click(screen.getByTestId("median-toggle"));
    const median = within(screen.getByTestId("proposed-card")).getByTestId("baseline-estimate");
    expect(median).toHaveTextContent("40%");
    expect(median).toHaveTextContent("median");
  });

  it("offers Adopt at ARC once the baseline is usable (≥3 comparable points)", () => {
    const { onAdopt } = renderBaseline(withGhLabels("1", null));
    fireEvent.click(screen.getByTestId("adopt-button"));
    expect(onAdopt).toHaveBeenCalledOnce();
    // Adoption locks the currently-shown method (average by default).
    expect(onAdopt.mock.calls[0]?.[2]).toBe("mean");
  });

  it("adding a baseline point routes to the handler", () => {
    const { onAddBaselinePoint } = renderBaseline();
    fireEvent.click(screen.getByRole("button", { name: "+ Add baseline point" }));
    expect(onAddBaselinePoint).toHaveBeenCalledOnce();
  });

  it("editing the ARC date routes to the engine handler", () => {
    const { onEditArcDate } = renderBaseline();
    fireEvent.change(screen.getByLabelText("arc date"), { target: { value: "2026-09-21" } });
    expect(onEditArcDate).toHaveBeenCalledOnce();
    expect(onEditArcDate.mock.calls[0]?.[1]).toBe("2026-09-21");
  });
});

describe("BaselineScreen — IEP goal label (TEACH-41)", () => {
  it("the seed's draft has no label: '+ Add IEP goal #' beside the ARC date, saved inline", () => {
    const { onSetGoalLabel } = renderBaseline();
    const card = screen.getByTestId("proposed-card");
    fireEvent.click(within(card).getByTestId("goal-label-edit"));
    const input = within(card).getByTestId("goal-label-input");
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSetGoalLabel).toHaveBeenCalledOnce();
    expect(onSetGoalLabel.mock.calls[0]?.[1]).toBe("1");
    expect(onSetGoalLabel.mock.calls[0]?.[0].status).toBe("proposed");
  });

  it("a labelled draft shows 'Goal 3 · text' on the card", () => {
    renderBaseline(withGhLabels("3", null));
    const title = screen.getByTestId("proposed-card").querySelector(".rowtitle");
    expect(title).toHaveTextContent(/^Goal 3/);
    expect(title).toHaveTextContent(/Add integers$/);
  });

  it("adopting proposed Goal N while active Goal N exists asks 'retire the old Goal N?' — never blocks", () => {
    const { onAdopt } = renderBaseline(withGhLabels("1", "1"));
    expect(screen.getByTestId("adopt-label-warning")).toHaveTextContent(
      "GH already has an active Goal 1 — Order of operations. Adopting this makes two Goal 1: retire the old Goal 1?",
    );
    fireEvent.click(screen.getByTestId("adopt-button"));
    expect(onAdopt).toHaveBeenCalledOnce(); // nothing retired, nothing blocked
  });

  it("no warning when the active goal has a different number", () => {
    renderBaseline(withGhLabels("1", "2"));
    expect(screen.queryByTestId("adopt-label-warning")).toBeNull();
  });

  it("adopting a goal with no IEP goal # is blocked, with a plain reason pointing at the inline box", () => {
    const { onAdopt } = renderBaseline(); // the seed's draft is unlabelled, baseline usable
    const card = screen.getByTestId("proposed-card");
    const adopt = within(card).getByTestId("adopt-button");
    expect(adopt).toBeDisabled();
    expect(within(card).getByTestId("adopt-needs-label")).toHaveTextContent(ADOPT_NEEDS_LABEL);
    expect(adopt).toHaveAccessibleDescription(ADOPT_NEEDS_LABEL);
    // The reason names the control that fixes it, and that control is on this card.
    expect(ADOPT_NEEDS_LABEL).toContain("+ Add IEP goal #");
    expect(within(card).getByTestId("goal-label-edit")).toHaveTextContent("+ Add IEP goal #");
    fireEvent.click(adopt);
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("adopting a goal with an IEP goal # is allowed, with no reason shown", () => {
    const { onAdopt } = renderBaseline(withGhLabels("2", null));
    const adopt = screen.getByTestId("adopt-button");
    expect(adopt).toBeEnabled();
    expect(screen.queryByTestId("adopt-needs-label")).toBeNull();
    fireEvent.click(adopt);
    expect(onAdopt).toHaveBeenCalledOnce();
  });

  it("a stored label that fails validation counts as no label, and the reason points at 'edit'", () => {
    renderBaseline(withGhLabels("Goal 2", null));
    const card = screen.getByTestId("proposed-card");
    expect(within(card).getByTestId("adopt-button")).toBeDisabled();
    expect(within(card).getByTestId("adopt-needs-label")).toHaveTextContent(ADOPT_FIX_LABEL);
    // The control the reason names is the one the card shows for a stored label.
    expect(within(card).getByTestId("goal-label-edit")).toHaveTextContent("edit");
  });
});
