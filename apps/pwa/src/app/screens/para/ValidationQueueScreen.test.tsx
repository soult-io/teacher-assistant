import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { deriveParaQueue } from "../../../data/para-publish.js";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import { ValidationQueueScreen } from "./ValidationQueueScreen.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderQueue() {
  const seed = buildSyntheticSeed(NOW);
  const queue = deriveParaQueue(seed.master.points, seed.paraPending);
  const initialsById = new Map(seed.master.students.map((s) => [s.student_id, s.initials]));
  const goalTextById = new Map(seed.master.goals.map((g) => [g.goal_id, g.goal_text]));
  const handlers = { onConfirm: vi.fn(), onFix: vi.fn(), onBack: vi.fn() };
  render(
    <ValidationQueueScreen
      queue={queue}
      initialsById={initialsById}
      goalTextById={goalTextById}
      {...handlers}
    />,
  );
  return handlers;
}

describe("ValidationQueueScreen (U6)", () => {
  it("itemizes each pending para point with its values (seed = 2)", () => {
    renderQueue();
    // Two seeded para captures await validation, each individually confirmable.
    expect(screen.getAllByRole("button", { name: /^confirm / }).length).toBe(2);
  });

  it("shows the SETTING the para recorded on each row (§A.5 every value visible)", () => {
    renderQueue();
    // The seed captures both use the Resource setting — it must be shown to the teacher.
    expect(screen.getAllByText(/Resource/).length).toBeGreaterThan(0);
  });

  it("surfaces the off-basis flag on the mismatch entry", () => {
    renderQueue();
    expect(screen.getByTestId("validate-mismatch")).toBeInTheDocument();
  });

  it("Confirm routes to the validation handler (nothing counts until then)", () => {
    const { onConfirm } = renderQueue();
    fireEvent.click(screen.getAllByRole("button", { name: /^confirm / })[0] as HTMLElement);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
