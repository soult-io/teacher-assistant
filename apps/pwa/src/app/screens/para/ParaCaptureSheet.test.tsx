import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { readParaVisible } from "../../../data/repository.js";
import type { DocMutator } from "../../../data/session.js";
import { ParaCaptureSheet, type ParaCaptureTarget } from "./ParaCaptureSheet.js";

const NOW = new Date("2026-09-14T12:00:00Z");
const target: ParaCaptureTarget = {
  goalId: "goal-1",
  studentId: "stu-1",
  initials: "AB",
  probeDefinitionId: "probe-1",
  administerLabel: "Two-step equations · EE.C.7 · 5 items",
  expectedDenominator: 5,
};

/** Apply the committed mutator to a fresh PARA doc and return the single pending point. */
function applyMutator(mutator: DocMutator) {
  const doc = new Y.Doc();
  doc.transact(() => mutator(doc));
  // The para capture writes into the para doc's pending map (Period-DEK scope), never master.
  return readParaVisible(doc).pending[0];
}

function renderSheet() {
  const onCommit = vi.fn();
  render(
    <ParaCaptureSheet
      target={target}
      settingPicklist={["math_resource", "gen_ed", "home_scored"]}
      now={NOW}
      onCommit={onCommit}
      onClose={vi.fn()}
    />,
  );
  return { onCommit };
}

describe("ParaCaptureSheet (U6, hard FERPA constraints)", () => {
  it("has ZERO free-text: no textarea, and the qualitative fields are all chips", () => {
    const { container } = render(
      <ParaCaptureSheet
        target={target}
        settingPicklist={["math_resource"]}
        now={NOW}
        onCommit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelector("textarea")).toBeNull();
    // The only inputs are the two NUMERIC score fields; there is no free-text input.
    const inputs = [...container.querySelectorAll("input")];
    expect(inputs.every((i) => i.getAttribute("inputmode") === "numeric")).toBe(true);
    // Observations are chip buttons, not a text field.
    expect(screen.getByRole("button", { name: "Independent" })).toBeInTheDocument();
  });

  it("the ⊘ reasons are Absent/Behavior/No time ONLY — never Testing", () => {
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "No data" }));
    expect(screen.getByRole("button", { name: "Absent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Behavior" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "No time" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Testing" })).toBeNull();
  });

  it("accommodation subtypes appear ONLY after the para picks 'Accommodation' (no accom_mod edge)", () => {
    renderSheet();
    expect(screen.queryByRole("button", { name: "Calculator" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accommodation" }));
    expect(screen.getByRole("button", { name: "Calculator" })).toBeInTheDocument();
  });

  it("saving builds a scorer=para PENDING point carrying the witnessed chips", () => {
    const { onCommit } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "plus" })); // 1 correct
    fireEvent.click(screen.getByRole("button", { name: "Independent" }));
    fireEvent.click(screen.getByRole("button", { name: "Save (pending)" }));
    expect(onCommit).toHaveBeenCalledOnce();
    const point = applyMutator(onCommit.mock.calls[0]?.[0] as DocMutator);
    expect(point?.scorer).toBe("para");
    expect(point?.state).toBe("pending");
    expect(point?.validated_by).toBeUndefined();
    expect(point?.para_observations).toEqual(["Independent"]);
  });

  it("a differing total lands off-basis (flagged for the teacher) — the para can't redefine it", () => {
    const { onCommit } = renderSheet();
    fireEvent.change(screen.getByLabelText("total items"), { target: { value: "6" } });
    expect(screen.getByTestId("para-mismatch-note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save (pending)" }));
    const point = applyMutator(onCommit.mock.calls[0]?.[0] as DocMutator);
    expect(point?.denominator_mismatch).toBe(true);
    expect(point?.denominator_original).toBe(5); // assigned total retained, never overwritten
  });
});
