// @vitest-environment node
import type { DashboardGroup } from "@teacher-assistant/store";
import { buildToScoreQueue, buildWeeklyDashboard, groupDashboard } from "@teacher-assistant/store";
import { describe, expect, it } from "vitest";
import { buildSyntheticSeed, type SyntheticSeed } from "../../../data/synthetic-seed.js";
import {
  buildLookups,
  buildStudentCards,
  orderPeriodGroups,
  type Lookups,
  orderRowsByStudent,
  orderToScoreQueue,
  orderValidationQueue,
  periodLabelOfGroup,
  type RowVM,
  rowValueText,
  toRowVM,
} from "./dashboard-vm.js";

const NOW = new Date("2026-09-14T12:00:00Z");

function fixture(full: SyntheticSeed = buildSyntheticSeed(NOW)) {
  const seed = full.master;
  // The para pending live in the para doc; the dashboard marks rows from that queue.
  const paraPendingGoalIds = new Set(full.paraPending.map((p) => p.goal_id));
  const lk = buildLookups(seed, paraPendingGoalIds);
  const dash = buildWeeklyDashboard({
    goals: seed.goals,
    points: seed.points,
    asOf: NOW,
    isNonInstructional: () => false,
    periodByStudent: lk.periodByStudent,
  });
  const goalId = (text: string) =>
    seed.goals.find((g) => g.goal_text === text)?.goal_id ?? "missing";
  return { full, seed, lk, dash, goalId };
}

describe("dashboard view-models", () => {
  it("marks the pending-para goal and only that one", () => {
    const { lk, goalId } = fixture();
    expect(lk.pendingGoalIds.has(goalId("Two-step equations"))).toBe(true); // has a pending para point
    expect(lk.pendingGoalIds.has(goalId("Add integers"))).toBe(false); // scored, not pending
  });

  it("resolves a row to its display attributes", () => {
    const { lk, dash, goalId } = fixture();
    const row = dash.rows.find((r) => r.goalId === goalId("Two-step equations"));
    if (row === undefined) {
      throw new Error("expected the Two-step equations row on the dashboard");
    }
    const vm = toRowVM(row, lk);
    expect(vm).toMatchObject({
      initials: "AB",
      goalText: "Two-step equations",
      state: "owes",
      periodLabel: "P2",
      pending: true,
    });
  });

  it("orders by-student cards owes-first then by initials (design §E.4)", () => {
    const { lk, dash } = fixture();
    const cards = buildStudentCards(groupDashboard(dash.rows, "by_student"), lk);
    // AB + CD both owe (todo>0) → first, alphabetical; EF is fully scored → last.
    expect(cards.map((c) => c.initials)).toEqual(["AB", "CD", "EF"]);
    expect(cards[0]?.todo).toBe(1);
    expect(cards[2]?.todo).toBe(0);
  });

  it("orders by-period groups by label", () => {
    const { lk, dash } = fixture();
    const ordered = orderPeriodGroups(groupDashboard(dash.rows, "by_period"), lk);
    expect(ordered.map((g) => periodLabelOfGroup(g, lk))).toEqual(["P2", "P4"]);
  });

  it("resolves probe + criterion for a row from goal fields (C4, no store change)", () => {
    const { lk, dash, goalId } = fixture();
    const row = dash.rows.find((r) => r.goalId === goalId("Two-step equations"));
    if (row === undefined) {
      throw new Error("expected the Two-step equations row");
    }
    const vm = toRowVM(row, lk);
    expect(vm.probe).toBe("5-item probe");
    expect(vm.criterion).toBe("80% × 4 consecutive probes");
  });

  it("orders by-student cards by initials, then period, then studentId on a tie (TEACH-25)", () => {
    const { lk } = fixture();
    const group = (key: string, periodId: string | null): DashboardGroup => ({
      key,
      rows: [
        {
          goalId: `g-${key}` as RowVM["goalId"],
          studentId: key as RowVM["studentId"],
          state: "owes",
          periodId: periodId as RowVM["goalId"] | null,
        } as DashboardGroup["rows"][number],
      ],
    });
    const labels = new Map([
      ["p-10", "P10"],
      ["p-2", "P2"],
    ]);
    const tieLk: Lookups = {
      ...lk,
      initialsById: new Map([
        ["s-3", "AB"],
        ["s-2", "ab"],
        ["s-1", "AB"],
        ["s-0", "AB"],
        ["s-4", "AB"],
      ]),
      periodLabelById: labels,
      goalTextById: new Map(),
    };
    const cards = buildStudentCards(
      [
        group("s-3", "p-2"),
        group("s-2", "p-2"),
        group("s-1", null),
        group("s-0", "p-2"),
        group("s-4", "p-10"),
      ],
      tieLk,
    );
    // AB before ab (raw tiebreak); within AB: "P10" < "P2" as text, no period last;
    // equal period → studentId.
    expect(cards.map((c) => c.studentId)).toEqual(["s-4", "s-0", "s-3", "s-1", "s-2"]);
  });

  it('orders by-period groups number-aware ("P2" before "P10"), then by periodId', () => {
    const { lk } = fixture();
    const g = (key: string): DashboardGroup => ({ key, rows: [] });
    const labelLk: Lookups = {
      ...lk,
      periodLabelById: new Map([
        ["id-b", "Period 10"],
        ["id-a", "Period 2"],
        ["id-d", "Period 2"],
        ["id-c", "period 1"],
      ]),
    };
    const ordered = orderPeriodGroups(
      [g("id-b"), g("id-d"), g("unassigned"), g("id-a"), g("id-c")],
      labelLk,
    );
    expect(ordered.map((x) => x.key)).toEqual(["id-c", "id-a", "id-d", "id-b", "unassigned"]);
  });

  it("lists each student's goals A–Z by goal text, case-insensitively (TEACH-25)", () => {
    const vm = (initials: string, goalText: string, goalId: string, periodLabel: string | null) =>
      ({ initials, goalText, goalId, periodLabel, studentId: `s-${initials}` }) as RowVM;
    const rows = [
      vm("AB", "two-step equations", "g-1", "P2"),
      vm("AB", "Add integers", "g-9", "P2"),
      vm("CD", "Number line", "g-0", "P4"),
      vm("AB", "Add integers", "g-3", "P2"), // true duplicate → goalId decides
    ];
    expect(orderRowsByStudent(rows).map((r) => `${r.initials} ${r.goalText} ${r.goalId}`)).toEqual([
      "AB Add integers g-3",
      "AB Add integers g-9",
      "AB two-step equations g-1",
      "CD Number line g-0",
    ]);
  });

  it("orders within-group rows by initials so a student's goals stay adjacent (C2)", () => {
    const { lk, dash } = fixture();
    const inits = orderRowsByStudent(dash.rows.map((r) => toRowVM(r, lk))).map((v) => v.initials);
    // Non-decreasing by initials (ASCII code points) — students grouped together.
    expect(inits).toEqual([...inits].sort());
  });

  it("shows the seed's rows in the ruled order: goals A–Z within each student", () => {
    const shown = displayed(fixture());
    expect(shown.owes).toEqual(["AB Two-step equations", "CD Multiply fractions"]);
    expect(shown.done).toEqual(["AB Add integers", "CD Number line", "EF Scientific notation"]);
    expect(shown.cards).toEqual([
      "AB: Add integers | Two-step equations",
      "CD: Multiply fractions | Number line",
      "EF: Scientific notation",
    ]);
    expect(shown.periods).toEqual([
      "P2: AB Add integers | AB Two-step equations | CD Multiply fractions | CD Number line",
      "P4: EF Scientific notation",
    ]);
    expect(shown.validation).toEqual([
      "AB Two-step equations 2026-09-14",
      "CD Multiply fractions 2026-09-14",
    ]);
  });
});

/** Every list a teacher sees, flattened to the on-screen text (no ids). */
function displayed({ full, lk, dash }: ReturnType<typeof fixture>) {
  const text = (r: RowVM) => `${r.initials} ${r.goalText}`;
  const rows = (groupDashboard(dash.rows, "owes_first")[0]?.rows ?? []).map((r) => toRowVM(r, lk));
  const cards = buildStudentCards(groupDashboard(dash.rows, "by_student"), lk);
  const periods = orderPeriodGroups(groupDashboard(dash.rows, "by_period"), lk);
  const goalTextOf = (goalId: string) => lk.goalTextById.get(goalId) ?? "?";
  const initialsOf = (studentId: string) => lk.initialsById.get(studentId) ?? "?";
  return {
    // The value each row shows (scored % / ⊘ reason) — must not follow record order either.
    values: orderRowsByStudent(rows).map((r) => `${text(r)} ${rowValueText(r) ?? "owes"}`),
    owes: orderRowsByStudent(rows.filter((r) => r.state === "owes")).map(text),
    done: orderRowsByStudent(rows.filter((r) => r.state !== "owes")).map(text),
    cards: cards.map((c) => `${c.initials}: ${c.rows.map((r) => r.goalText).join(" | ")}`),
    periods: periods.map(
      (g) =>
        `${periodLabelOfGroup(g, lk)}: ${orderRowsByStudent(g.rows.map((r) => toRowVM(r, lk)))
          .map(text)
          .join(" | ")}`,
    ),
    toScore: orderToScoreQueue(buildToScoreQueue(full.master.points), lk).map(
      (e) => `${initialsOf(e.studentId)} ${goalTextOf(e.goalId)} ${e.adminDate}`,
    ),
    validation: orderValidationQueue(full.paraPending, lk).map(
      (p) => `${initialsOf(p.student_id)} ${goalTextOf(p.goal_id)} ${p.admin_date}`,
    ),
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Re-mint every opaque id in the seed (goal, student, period, data-point, …) and
 * reverse every record array. `order` decides the new ids' code-point order
 * relative to the old: "reversed" flips every id tiebreak.
 */
function remint(full: SyntheticSeed, order: "same" | "reversed"): SyntheticSeed {
  const json = JSON.stringify(full);
  const ids = [...new Set(json.match(UUID) ?? [])].sort();
  const n = ids.length;
  const fresh = new Map(
    ids.map((id, i) => {
      const rank = order === "reversed" ? n - i : i + 1;
      return [id, `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`];
    }),
  );
  const remapped = JSON.parse(
    json.replace(UUID, (id) => fresh.get(id) ?? id),
    (_k, v) => (Array.isArray(v) ? [...v].reverse() : v),
  ) as SyntheticSeed;
  return remapped;
}

describe("queue display order (TEACH-25)", () => {
  it("orders the To-Score queue by student-goal, then admin date, then point id", () => {
    const { lk, goalId, seed } = fixture();
    const sid = (text: string) => seed.goals.find((g) => g.goal_text === text)?.student_id ?? "";
    const entry = (text: string, adminDate: string, dataPointId: string) =>
      ({
        dataPointId,
        goalId: goalId(text),
        studentId: sid(text),
        adminDate,
        state: "queued",
      }) as ReturnType<typeof buildToScoreQueue>[number];
    const queue = [
      entry("Two-step equations", "2026-09-10", "p-1"),
      entry("Number line", "2026-09-09", "p-2"),
      entry("Add integers", "2026-09-11", "p-4"),
      entry("Add integers", "2026-09-11", "p-3"),
      entry("Add integers", "2026-09-10", "p-5"),
    ];
    expect(orderToScoreQueue(queue, lk).map((e) => e.dataPointId)).toEqual([
      "p-5", // AB Add integers, oldest
      "p-3", // same goal + date → point id
      "p-4",
      "p-1", // AB Two-step equations
      "p-2", // CD
    ]);
  });

  it("keeps the validation queue chronological, then student-goal, then entry time", () => {
    const { lk, full } = fixture();
    const [a, b] = full.paraPending;
    if (a === undefined || b === undefined) {
      throw new Error("expected two para-pending points in the seed");
    }
    const early = { ...b, admin_date: "2026-09-01" as typeof b.admin_date };
    const laterEntry = {
      ...a,
      entry_ts: (a.entry_ts + 5) as typeof a.entry_ts,
      data_point_id: "0" as typeof a.data_point_id,
    };
    const shown = orderValidationQueue([laterEntry, a, b, early], lk).map((p) => p.data_point_id);
    expect(shown).toEqual([early.data_point_id, a.data_point_id, "0", b.data_point_id]);
  });
});

describe("display order is independent of opaque ids (TEACH-25)", () => {
  it("shows the same order for re-minted, reversed-order ids and shuffled records", () => {
    const base = buildSyntheticSeed(NOW);
    const expected = displayed(fixture(base));
    expect(displayed(fixture(remint(base, "same")))).toEqual(expected);
    expect(displayed(fixture(remint(base, "reversed")))).toEqual(expected);
  });

  it("shows the same order across independent reseeds (fresh random UUIDs)", () => {
    const expected = displayed(fixture(buildSyntheticSeed(NOW)));
    for (let i = 0; i < 5; i += 1) {
      expect(displayed(fixture(buildSyntheticSeed(NOW)))).toEqual(expected);
    }
  });
});
