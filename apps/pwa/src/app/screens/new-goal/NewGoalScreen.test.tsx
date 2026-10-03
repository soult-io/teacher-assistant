import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewGoalScreen } from "./NewGoalScreen.js";

function fillCore() {
  fireEvent.change(screen.getByPlaceholderText("e.g. AB"), { target: { value: "AB" } });
  fireEvent.change(screen.getByPlaceholderText("solve two-step equations"), {
    target: { value: "solve two-step equations" },
  });
  fireEvent.change(screen.getByPlaceholderText("given a 5-item probe and a number line"), {
    target: { value: "given a 5-item probe" },
  });
  fireEvent.change(screen.getByLabelText("criterion level"), { target: { value: "80" } });
  fireEvent.change(screen.getByLabelText("criterion consistency"), { target: { value: "4" } });
  fireEvent.change(screen.getByLabelText("method tool"), { target: { value: "enVision" } });
  fireEvent.change(screen.getByLabelText("total items per probe"), { target: { value: "5" } });
}

describe("NewGoalScreen (U5)", () => {
  it("DRAFT is ready once the KY components are filled (no baseline required)", () => {
    render(<NewGoalScreen onSubmit={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Draft a proposed goal/ }));
    expect(screen.getByTestId("ng-gate")).toHaveClass("bad");
    fillCore();
    expect(screen.getByTestId("ng-gate")).toHaveClass("ok");
    expect(screen.getByRole("button", { name: "Start baselining →" })).toBeEnabled();
  });

  it("ADOPT is baseline-mandatory: not ready until a baseline is entered (default path)", () => {
    render(<NewGoalScreen onSubmit={vi.fn()} onBack={vi.fn()} />);
    // ADOPT is the default path.
    fillCore();
    // Core filled but no baseline → the engine gate blocks activation.
    expect(screen.getByTestId("ng-gate")).toHaveClass("bad");
    fireEvent.change(screen.getByLabelText("baseline percent"), { target: { value: "20" } });
    expect(screen.getByTestId("ng-gate")).toHaveClass("ok");
    expect(screen.getByRole("button", { name: "Activate goal · begin monitoring" })).toBeEnabled();
  });

  it("choosing VARIABLE basis surfaces the off-basis-check-off guardrail and hides the total field", () => {
    render(<NewGoalScreen onSubmit={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByLabelText("total items per probe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Variable / custom" }));
    expect(screen.getByTestId("variable-basis-note")).toHaveTextContent(
      /turns OFF the off-basis check/,
    );
    expect(screen.queryByLabelText("total items per probe")).toBeNull();
  });

  it("submitting hands the collected form up", () => {
    const onSubmit = vi.fn();
    render(<NewGoalScreen onSubmit={onSubmit} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Draft a proposed goal/ }));
    fillCore();
    fireEvent.click(screen.getByRole("button", { name: "Start baselining →" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ path: "draft", initials: "AB" });
  });

  describe("initials validation (TEACH-40)", () => {
    const INITIALS_ERROR = "Use 2 or 3 letters (initials only)";

    it.each(["AB", "JAS", "j.a.s."])("accepts %j: no error, form can submit", (raw) => {
      const onSubmit = vi.fn();
      render(<NewGoalScreen onSubmit={onSubmit} onBack={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Draft a proposed goal/ }));
      fillCore();
      fireEvent.change(screen.getByTestId("ng-initials"), { target: { value: raw } });
      fireEvent.blur(screen.getByTestId("ng-initials"));
      expect(screen.queryByText(INITIALS_ERROR)).toBeNull();
      expect(screen.getByTestId("ng-initials")).not.toHaveAttribute("aria-invalid", "true");
      fireEvent.click(screen.getByRole("button", { name: "Start baselining →" }));
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it.each(["John Smith", "J", "ABCD", "A1"])(
      "rejects %j: inline error shown and the form does not submit",
      (raw) => {
        const onSubmit = vi.fn();
        render(<NewGoalScreen onSubmit={onSubmit} onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: /Draft a proposed goal/ }));
        fillCore();
        const input = screen.getByTestId("ng-initials");
        fireEvent.change(input, { target: { value: raw } });
        // Before blur: submit is already blocked, but no error flashes mid-typing.
        expect(screen.queryByText(INITIALS_ERROR)).toBeNull();
        fireEvent.blur(input);
        expect(screen.getByText(INITIALS_ERROR)).toBeInTheDocument();
        expect(input).toHaveAttribute("aria-invalid", "true");
        expect(input).toHaveAccessibleDescription(INITIALS_ERROR);
        expect(screen.getByTestId("ng-gate")).toHaveClass("bad");
        const submit = screen.getByRole("button", { name: "Start baselining →" });
        expect(submit).toBeDisabled();
        fireEvent.click(submit);
        expect(onSubmit).not.toHaveBeenCalled();
      },
    );

    it("shows no error while the field is still empty", () => {
      render(<NewGoalScreen onSubmit={vi.fn()} onBack={vi.fn()} />);
      fireEvent.blur(screen.getByTestId("ng-initials"));
      expect(screen.queryByText(INITIALS_ERROR)).toBeNull();
    });

    it("caps the input length so a pasted full name cannot be typed in whole", () => {
      render(<NewGoalScreen onSubmit={vi.fn()} onBack={vi.fn()} />);
      expect(screen.getByTestId("ng-initials")).toHaveAttribute("maxLength", "6");
    });
  });
});
