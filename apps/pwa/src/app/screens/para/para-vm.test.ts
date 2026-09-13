import { describe, expect, it } from "vitest";
import { buildSyntheticSeed } from "../../../data/synthetic-seed.js";
import { buildParaVisible, paraPeriodId } from "./para-vm.js";

const NOW = new Date("2026-09-14T12:00:00Z");

describe("para-vm (U6 projection)", () => {
  it("scopes to the has_para period and emits only Period-DEK handles (no MK content)", () => {
    const records = buildSyntheticSeed(NOW);
    const periodId = paraPeriodId(records);
    if (periodId === null) {
      throw new Error("expected a para period");
    }
    const doc = buildParaVisible(records, periodId);

    // Roster + administer are non-empty and every id is opaque.
    expect(doc.roster.length).toBeGreaterThan(0);
    expect(doc.administer.length).toBeGreaterThan(0);

    // Structural FERPA: the serialized doc carries NO teacher-MK content.
    const json = JSON.stringify(doc);
    for (const forbidden of ["criterion", "baseline", "accom", "goal_text", "behavior", "arc_"]) {
      expect(json.includes(forbidden)).toBe(false);
    }
    // The administer row exposes exactly the five Period-DEK handles.
    expect(Object.keys(doc.administer[0] ?? {}).sort()).toEqual([
      "administerLabel",
      "expectedDenominator",
      "goalId",
      "probeDefinitionId",
      "studentId",
    ]);
  });

  it("the administer-label comes from the NON-PII catalog (topic · standard · N items)", () => {
    const records = buildSyntheticSeed(NOW);
    const periodId = paraPeriodId(records);
    if (periodId === null) {
      throw new Error("expected a para period");
    }
    const doc = buildParaVisible(records, periodId);
    // The seed catalogs the para-period goals → topic + standard, not goal_text.
    expect(doc.administer.some((a) => a.administerLabel.includes("· items") === false)).toBe(true);
    expect(doc.administer.some((a) => /· [A-Z]{2}\.[A-Z]\.\d+ ·/.test(a.administerLabel))).toBe(
      true,
    );
  });

  it("excludes goals from other periods (least-privilege: only the para's class)", () => {
    const records = buildSyntheticSeed(NOW);
    const periodId = paraPeriodId(records);
    if (periodId === null) {
      throw new Error("expected a para period");
    }
    const doc = buildParaVisible(records, periodId);
    // Every rostered student belongs to the scoped period; the P4 students (EF/GH) are absent.
    const rosterInitials = new Set(
      doc.roster.map((r) => records.students.find((s) => s.student_id === r.studentId)?.initials),
    );
    expect(rosterInitials.has("EF")).toBe(false);
    expect(rosterInitials.has("GH")).toBe(false);
  });
});
