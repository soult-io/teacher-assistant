import type { IsoDate } from "@teacher-assistant/schema";
import { newOpaqueId } from "@teacher-assistant/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickScoreSheet } from "./QuickScoreSheet.js";
import type { SheetTarget } from "./sheet-target.js";

function makeTarget(): SheetTarget {
  return {
    goalId: newOpaqueId(),
    studentId: newOpaqueId(),
    initials: "AB",
    goalText: "Two-step equations",
    periodLabel: "P2",
    probeLabel: "5-item probe",
    expectedDenominator: 5,
    variableBasis: false,
    adminDate: "2026-09-14" as IsoDate,
  };
}

function form(): HTMLFormElement {
  const el = document.querySelector<HTMLFormElement>("form.qs-form");
  if (el === null) {
    throw new Error("score form not found");
  }
  return el;
}

describe("QuickScoreSheet — desktop modal affordances (U7)", () => {
  it("exposes a ✕ close control that calls onClose", () => {
    const onClose = vi.fn();
    render(<QuickScoreSheet target={makeTarget()} onCommit={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Enter (submit) saves a matching score", () => {
    const onCommit = vi.fn();
    render(<QuickScoreSheet target={makeTarget()} onCommit={onCommit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("number correct"), { target: { value: "4" } });
    fireEvent.submit(form());
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("Enter does NOT bypass the F-2 mismatch ack — submit is guarded on a mismatch", () => {
    const onCommit = vi.fn();
    render(<QuickScoreSheet target={makeTarget()} onCommit={onCommit} onClose={vi.fn()} />);
    // Total 6 ≠ assigned 5 → genuine mismatch; the explicit disposition is required.
    fireEvent.change(screen.getByLabelText("total items"), { target: { value: "6" } });
    expect(screen.getByTestId("mismatch-ack")).toBeInTheDocument();
    fireEvent.submit(form());
    expect(onCommit).not.toHaveBeenCalled();
  });
});
