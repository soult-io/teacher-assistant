// TEACH-46 — Baseline card UI: no accidental 0, audited Fix / Remove, the C8 Keep
// prompt, History, and the "Fixed after ARC" note. The exact strings are the
// ky-sped-lbd-sdi-sme ruling's (2026-10-09, section D). SYNTHETIC data only.

import {
  createBaselinePoint,
  fixBaselinePoint,
  removeBaselinePoint,
} from "@teacher-assistant/domain-core";
import { asTimestamp, type BaselinePoint, type IEPGoal } from "@teacher-assistant/schema";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import { GoalDetailBody } from "../goal-detail/GoalDetailScreen.js";
import { BaselineScreen } from "./BaselineScreen.js";

const NOW = new Date("2026-09-14T12:00:00Z");
const T = { who: "teacher", when: asTimestamp(Date.parse("2026-10-09T10:00:00Z")) } as const;

type Records = ReturnType<typeof buildSyntheticSeed>["master"];

function proposedOf(records: Records): IEPGoal {
  const g = records.goals.find((x) => x.status === "proposed");
  if (g === undefined) throw new Error("seed has a proposed goal");
  return g;
}

function renderBaseline(edit: (records: Records) => Records = (r) => r) {
  const records = edit(buildSyntheticSeed(NOW).master);
  const handlers = {
    onBack: vi.fn(),
    onNewGoal: vi.fn(),
    onAddBaselinePoint: vi.fn(),
    onAdopt: vi.fn(),
    onEditArcDate: vi.fn().mockReturnValue(null),
    onSetGoalLabel: vi.fn(),
    onFixBaselinePoint: vi.fn(),
    onRemoveBaselinePoint: vi.fn(),
    onKeepBaselineTotal: vi.fn(),
  };
  render(
    <BaselineScreen
      records={records}
      initialsById={new Map(records.students.map((s) => [s.student_id, s.initials]))}
      periodLabelByStudent={() => "P4"}
      isNonInstructional={() => false}
      {...handlers}
    />,
  );
  return { ...handlers, records, goal: proposedOf(records) };
}

/** Replace the proposed goal (and its probe's total) in the seed. */
function withGoal(patch: Partial<IEPGoal>, probeTotal?: number) {
  return (r: Records): Records => {
    const g = proposedOf(r);
    return {
      ...r,
      goals: r.goals.map((x) => (x.goal_id === g.goal_id ? { ...x, ...patch } : x)),
      probes: r.probes.map((p) =>
        p.goal_id === g.goal_id && probeTotal !== undefined
          ? { ...p, expected_denominator: probeTotal }
          : p,
      ),
    };
  };
}

function withPoints(make: (goal: IEPGoal, existing: readonly BaselinePoint[]) => BaselinePoint[]) {
  return (r: Records): Records => {
    const g = proposedOf(r);
    const own = r.baselinePoints.filter((p) => p.goal_id === g.goal_id);
    const others = r.baselinePoints.filter((p) => p.goal_id !== g.goal_id);
    return { ...r, baselinePoints: [...others, ...make(g, own)] };
  };
}

const addButton = () => screen.getByTestId("add-baseline-point");
const correct = () => screen.getByLabelText("baseline correct");
const total = () => screen.getByLabelText("baseline total");

describe("E1 — # correct starts empty; a typed 0 is accepted", () => {
  it("disables Add with the ruled reason until a number is typed", () => {
    const { onAddBaselinePoint } = renderBaseline();
    expect(correct()).toHaveValue("");
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveAccessibleDescription("Type the number correct first.");
    fireEvent.click(addButton());
    expect(onAddBaselinePoint).not.toHaveBeenCalled();
  });

  it("enables Add for 0 and saves 0", () => {
    const { onAddBaselinePoint } = renderBaseline();
    fireEvent.change(correct(), { target: { value: "0" } });
    expect(addButton()).toBeEnabled();
    fireEvent.click(addButton());
    expect(onAddBaselinePoint).toHaveBeenCalledOnce();
    expect(onAddBaselinePoint.mock.calls[0]?.slice(1)).toEqual([0, 5]);
    // The box empties again so a second tap cannot re-add the same score.
    expect(correct()).toHaveValue("");
    expect(addButton()).toBeDisabled();
  });

  it.each(["1.5", "-1", "abc"])("rejects %s", (typed) => {
    renderBaseline();
    fireEvent.change(correct(), { target: { value: typed } });
    expect(addButton()).toBeDisabled();
  });

  it("rejects n > d with the ruled message, and d = 0", () => {
    renderBaseline();
    fireEvent.change(correct(), { target: { value: "6" } });
    expect(addButton()).toBeDisabled();
    expect(screen.getByTestId("add-point-reason")).toHaveTextContent(
      "Number correct can't be more than the total.",
    );
    fireEvent.change(correct(), { target: { value: "0" } });
    fireEvent.change(total(), { target: { value: "0" } });
    expect(addButton()).toBeDisabled();
  });
});

describe("E2 — 'of N' prefill follows C7", () => {
  it("prefills the probe's total (not a hardcoded 5)", () => {
    renderBaseline(withGoal({}, 12));
    expect(total()).toHaveValue("12");
  });

  it("is empty and required on a variable-total goal", () => {
    renderBaseline(withGoal({ denominator_basis: "variable" }, 12));
    expect(total()).toHaveValue("");
    fireEvent.change(correct(), { target: { value: "3" } });
    expect(addButton()).toBeDisabled();
    fireEvent.change(total(), { target: { value: "7" } });
    expect(addButton()).toBeEnabled();
  });

  it("hides the row when the goal is not scored as a percent", () => {
    renderBaseline(withGoal({ denominator_model: "frequency_count" }));
    expect(screen.queryByLabelText("baseline total")).toBeNull();
    expect(screen.queryByTestId("add-baseline-point")).toBeNull();
  });
});

describe("Fix dialog", () => {
  it("opens 'Fix baseline point', validates, and saves through [Save fix]", () => {
    const { onFixBaselinePoint } = renderBaseline();
    const card = screen.getByTestId("proposed-card");
    const [firstFix] = within(card).getAllByRole("button", { name: /^fix baseline point/ });
    fireEvent.click(firstFix as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Fix baseline point" });
    fireEvent.change(within(dialog).getByLabelText("fixed correct"), { target: { value: "9" } });
    expect(within(dialog).getByRole("button", { name: "Save fix" })).toBeDisabled();
    expect(within(dialog).getByTestId("fix-problem")).toHaveTextContent(
      "Number correct can't be more than the total.",
    );
    fireEvent.change(within(dialog).getByLabelText("fixed correct"), { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save fix" }));
    expect(onFixBaselinePoint).toHaveBeenCalledOnce();
    expect(onFixBaselinePoint.mock.calls[0]?.[2]).toMatchObject({
      numerator: 0,
      denominator_used: 5,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("dialog focus", () => {
  it("moves focus into the dialog and back to the opener on close", () => {
    renderBaseline();
    const [opener] = screen.getAllByRole("button", { name: /^remove baseline point/ });
    (opener as HTMLElement).focus();
    fireEvent.click(opener as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Remove baseline point" });
    expect(within(dialog).getAllByRole("radio")[0]).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe("E4 — Remove dialog and History", () => {
  it("offers exactly the four ruled reasons and requires one", () => {
    const { onRemoveBaselinePoint } = renderBaseline();
    const [firstRemove] = screen.getAllByRole("button", { name: /^remove baseline point/ });
    fireEvent.click(firstRemove as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Remove baseline point" });
    expect(dialog).toHaveTextContent("Why remove it?");
    expect(dialog).toHaveTextContent(
      "It stays in the history. It won't count toward the baseline.",
    );
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual([
      "Entered by mistake",
      "Duplicate entry",
      "Wrong student or goal",
      "Probe not given the way the goal says",
    ]);
    // No free-text field anywhere in the dialog.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    const confirm = within(dialog).getByTestId("confirm-remove");
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Duplicate entry" }));
    fireEvent.click(confirm);
    expect(onRemoveBaselinePoint).toHaveBeenCalledOnce();
    expect(onRemoveBaselinePoint.mock.calls[0]?.[2]).toBe("duplicate");
  });

  it("a removed point leaves the list, drops the count, and shows struck through in a collapsed History", () => {
    renderBaseline(
      withPoints((goal, own) => {
        const [first, ...rest] = own;
        if (first === undefined) throw new Error("seed");
        return [removeBaselinePoint(first, goal, "entered_by_mistake", T), ...rest];
      }),
    );
    const card = screen.getByTestId("proposed-card");
    expect(within(card).getAllByTestId("baseline-point")).toHaveLength(2);
    expect(within(card).getByTestId("baseline-not-usable")).toHaveTextContent(
      "Need 3 points to estimate a baseline (you have 2).",
    );
    const history = within(card).getByTestId("baseline-history");
    expect(history).not.toHaveAttribute("open");
    expect(history.querySelector("s")).toHaveTextContent(
      "Removed 2026-10-09: Entered by mistake (was 1/5)",
    );
    // ESTIMATE wording stays where an estimate shows; the adopt button is gone below 3.
    expect(within(card).queryByTestId("adopt-button")).toBeNull();
  });

  it("History shows a fix as 'Fixed {date}: was a/b, now c/d'", () => {
    renderBaseline(
      withPoints((goal, own) => {
        const [first, ...rest] = own;
        if (first === undefined) throw new Error("seed");
        return [fixBaselinePoint(first, goal, { numerator: 3 }, T), ...rest];
      }),
    );
    expect(screen.getByTestId("baseline-history")).toHaveTextContent(
      "Fixed 2026-10-09: was 1/5, now 3/5",
    );
    expect(screen.getByTestId("baseline-estimate")).toHaveTextContent("estimate");
  });
});

describe("E9 — a mismatched total waits for Keep", () => {
  function withOddTotal(goal: IEPGoal, own: readonly BaselinePoint[]): BaselinePoint[] {
    return [
      ...own.slice(0, 2),
      createBaselinePoint({
        goal,
        probe: {
          probe_definition_id: "x" as never,
          goal_id: goal.goal_id,
          expected_denominator: 5,
          condition: "c",
        },
        adminDate: own[0]?.admin_date ?? ("2026-09-01" as never),
        numerator: 3,
        denominator: 4,
        who: "teacher",
        entryTs: asTimestamp(9),
      }),
    ];
  }

  it("shows the ruled prompt; the point does not count until Keep", () => {
    const { onKeepBaselineTotal, onFixBaselinePoint } = renderBaseline(withPoints(withOddTotal));
    const card = screen.getByTestId("proposed-card");
    const prompt = within(card).getByTestId("total-mismatch");
    expect(prompt).toHaveTextContent("This goal's probe has 5 items. Keep 4?");
    expect(within(card).getByTestId("baseline-not-usable")).toHaveTextContent("(you have 2)");
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep 4" }));
    expect(onKeepBaselineTotal).toHaveBeenCalledOnce();
    fireEvent.click(within(prompt).getByRole("button", { name: "Use 5" }));
    expect(onFixBaselinePoint.mock.calls[0]?.[2]).toEqual({ denominator_used: 5 });
  });
});

describe("Post-adoption (ruling B) on Goal Detail", () => {
  function adoptedDetail(fixed: boolean) {
    const records = buildSyntheticSeed(NOW).master;
    const proposed = proposedOf(records);
    const own = records.baselinePoints.filter((p) => p.goal_id === proposed.goal_id);
    const goal: IEPGoal = {
      ...proposed,
      status: "active",
      goal_label: "1",
      baseline_value: 100 / 3,
      baseline_source: "computed_from_baseline_points",
      revisions: [
        {
          who: "teacher",
          when: asTimestamp(1),
          old: { status: "proposed" },
          new: {
            status: "active",
            baseline_source: "computed_from_baseline_points",
            baseline_method: "mean",
            baseline_point_ids: own.map((p) => p.baseline_point_id),
          },
        },
      ],
    };
    const [first, ...rest] = own;
    if (first === undefined) throw new Error("seed");
    const points = fixed ? [fixBaselinePoint(first, goal, { numerator: 4 }, T), ...rest] : own;
    const onFix = vi.fn();
    render(
      <GoalDetailBody
        layout="mobile"
        goal={goal}
        points={[]}
        observations={[]}
        initials="GH"
        periodLabel={null}
        probeLabel="5-item probe"
        labelDuplicates={[]}
        onSetGoalLabel={vi.fn()}
        isNonInstructional={() => false}
        onAddPoint={vi.fn()}
        onEditPoint={vi.fn()}
        onAckMastery={vi.fn()}
        baselinePoints={points}
        onFixBaselinePoint={onFix}
      />,
    );
    return onFix;
  }

  it("offers Fix but never Remove, and no re-lock action", () => {
    const onFix = adoptedDetail(false);
    const card = screen.getByTestId("detail-baseline-points");
    expect(within(card).getAllByRole("button", { name: /^fix baseline point/ })).toHaveLength(3);
    expect(within(card).queryByRole("button", { name: /^remove/ })).toBeNull();
    expect(within(card).queryByRole("button", { name: /lock|adopt/i })).toBeNull();
    expect(within(card).queryByTestId("fixed-after-arc")).toBeNull();
    expect(onFix).not.toHaveBeenCalled();
  });

  it("after a fix shows the ruled note with both numbers; the header baseline is unchanged", () => {
    adoptedDetail(true);
    expect(screen.getByTestId("fixed-after-arc")).toHaveTextContent(
      "Fixed after ARC. The IEP baseline stays 33%. With this fix the estimate would be 53%. If the IEP baseline is wrong, bring it to the ARC.",
    );
    expect(screen.getByText(/Baseline 33\.3/)).toBeInTheDocument();
  });
});
