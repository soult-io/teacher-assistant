import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import { BaselineScreen } from "./BaselineScreen.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderBaseline() {
  const records = buildSyntheticSeed(NOW);
  const initialsById = new Map(records.students.map((s) => [s.student_id, s.initials]));
  const handlers = {
    onBack: vi.fn(),
    onNewGoal: vi.fn(),
    onAddBaselinePoint: vi.fn(),
    onAdopt: vi.fn(),
    onEditArcDate: vi.fn().mockReturnValue(null),
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
    const { onAdopt } = renderBaseline();
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
