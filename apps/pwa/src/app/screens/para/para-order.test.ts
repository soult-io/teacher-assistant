// @vitest-environment node
import type { OpaqueId } from "@teacher-assistant/schema";
import type { ParaVisibleAdministerEntry } from "@teacher-assistant/store";
import { describe, expect, it } from "vitest";
import { orderAdministerRows } from "./para-order.js";

const row = (
  studentId: string,
  administerLabel: string,
  goalId = "g",
): ParaVisibleAdministerEntry =>
  ({
    goalId: goalId as OpaqueId,
    studentId: studentId as OpaqueId,
    probeDefinitionId: `p-${goalId}` as OpaqueId,
    administerLabel,
    expectedDenominator: 5,
  }) as ParaVisibleAdministerEntry;

const initials = new Map([
  ["s-z", "AB"],
  ["s-a", "cd"],
  ["s-m", "AB"],
]);
const initialsOf = (id: OpaqueId) => initials.get(id) ?? "??";

describe("orderAdministerRows (TEACH-25)", () => {
  it("orders by initials (case-insensitive), then studentId, then label number-aware", () => {
    const rows = [
      row("s-a", "Probe 1"),
      row("s-z", "Probe 10"),
      row("s-z", "Probe 2"),
      row("s-m", "Probe 1"),
    ];
    expect(
      orderAdministerRows(rows, initialsOf).map((r) => `${r.studentId} ${r.administerLabel}`),
    ).toEqual(["s-m Probe 1", "s-z Probe 2", "s-z Probe 10", "s-a Probe 1"]);
  });

  it("does not depend on the input order; ids break only true duplicates", () => {
    const rows = [
      row("s-z", "Probe 1", "g-2"),
      row("s-z", "Probe 1", "g-1"),
      row("s-a", "Probe 1"),
    ];
    const forward = orderAdministerRows(rows, initialsOf);
    expect(orderAdministerRows([...rows].reverse(), initialsOf)).toEqual(forward);
    expect(forward.map((r) => r.goalId)).toEqual(["g-1", "g-2", "g"]);
  });
});
