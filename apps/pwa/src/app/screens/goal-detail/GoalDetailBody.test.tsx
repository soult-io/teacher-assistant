import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import { GoalDetailBody, type GoalDetailLayout } from "./GoalDetailScreen.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function renderBody(layout: GoalDetailLayout) {
  const records = buildSyntheticSeed(NOW).master;
  // "Add integers" is IC-exportable in the seed, so the draft statement renders (matching
  // the existing GoalDetailScreen coverage) — letting us assert it survives every layout.
  const goal = records.goals.find((g) => g.goal_text === "Add integers");
  if (goal === undefined) {
    throw new Error("no synthetic goal");
  }
  const initials = records.students.find((s) => s.student_id === goal.student_id)?.initials ?? "??";
  return render(
    <div className="goal-detail">
      <GoalDetailBody
        goal={goal}
        points={records.points}
        observations={records.observations}
        initials={initials}
        periodLabel="P2"
        probeLabel="5-item probe"
        isNonInstructional={() => false}
        onAddPoint={vi.fn()}
        onEditPoint={vi.fn()}
        onAckMastery={vi.fn()}
        labelDuplicates={[]}
        onSetGoalLabel={vi.fn()}
        layout={layout}
      />
    </div>,
  );
}

describe("GoalDetailBody — layout reflow (U7)", () => {
  it("full layout uses two columns; mobile layout is a single column", () => {
    const full = renderBody("full");
    expect(full.container.querySelector(".twocol")).not.toBeNull();
    full.unmount();
    const mobile = renderBody("mobile");
    expect(mobile.container.querySelector(".twocol")).toBeNull();
  });

  it.each<GoalDetailLayout>(["mobile", "full"])(
    "preserves the honesty surfaces verbatim in the %s layout",
    (layout) => {
      const { getByTestId, getAllByText } = renderBody(layout);
      // The draft statement + variant badge + quarterly survive every reflow (design §5).
      expect(getByTestId("auto-statement")).toBeInTheDocument();
      expect(getByTestId("statement-variant")).toBeInTheDocument();
      expect(getByTestId("quarterly")).toBeInTheDocument();
      // The ⊘-as-gap trend note copy is preserved verbatim.
      expect(getAllByText(/never plotted as a zero/).length).toBeGreaterThan(0);
    },
  );

  it("an open goal # draft never carries over when the body switches goal (TEACH-41)", () => {
    const records = buildSyntheticSeed(NOW).master;
    const [a, b] = records.goals.filter((g) => g.status === "active");
    if (a === undefined || b === undefined) {
      throw new Error("expected two active goals");
    }
    const onSetGoalLabel = vi.fn();
    const body = (goal: typeof a) => (
      <GoalDetailBody
        key={goal.goal_id}
        goal={goal}
        points={records.points}
        observations={records.observations}
        initials="AB"
        periodLabel="P2"
        probeLabel="5-item probe"
        isNonInstructional={() => false}
        onAddPoint={vi.fn()}
        onEditPoint={vi.fn()}
        onAckMastery={vi.fn()}
        labelDuplicates={[]}
        onSetGoalLabel={onSetGoalLabel}
        layout="full"
      />
    );
    const view = render(body(a));
    fireEvent.click(view.getByTestId("goal-label-edit"));
    fireEvent.change(view.getByTestId("goal-label-input"), { target: { value: "Goal 2" } });
    view.rerender(body(b));
    expect(view.queryByTestId("goal-label-input")).toBeNull();
    expect(onSetGoalLabel).not.toHaveBeenCalled();
  });
});
