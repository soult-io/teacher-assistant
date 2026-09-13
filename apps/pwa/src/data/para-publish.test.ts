import { describe, expect, it } from "vitest";
import { buildSyntheticSeed } from "./synthetic-seed.js";
import { deriveParaQueue, paraPeriodId, publishParaVisible } from "./para-publish.js";

const NOW = new Date("2026-09-14T12:00:00Z");

describe("publishParaVisible (U6 teacher→para publication source)", () => {
  it("scopes to the has_para period and emits only Period-DEK handles (no MK content)", () => {
    const records = buildSyntheticSeed(NOW).master;
    const periodId = paraPeriodId(records);
    if (periodId === null) {
      throw new Error("expected a para period");
    }
    const doc = publishParaVisible(records, periodId);

    // Roster + administer are non-empty and every id is opaque.
    expect(doc.roster.length).toBeGreaterThan(0);
    expect(doc.administer.length).toBeGreaterThan(0);

    // Structural FERPA: the published projection carries NO teacher-MK content.
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
    const records = buildSyntheticSeed(NOW).master;
    const periodId = paraPeriodId(records);
    if (periodId === null) {
      throw new Error("expected a para period");
    }
    const doc = publishParaVisible(records, periodId);
    // The seed catalogs the para-period goals → topic + standard, not goal_text.
    expect(doc.administer.some((a) => a.administerLabel.includes("· items") === false)).toBe(true);
    expect(doc.administer.some((a) => /· [A-Z]{2}\.[A-Z]\.\d+ ·/.test(a.administerLabel))).toBe(
      true,
    );
  });

  it("excludes goals from other periods (least-privilege: only the para's class)", () => {
    const records = buildSyntheticSeed(NOW).master;
    const periodId = paraPeriodId(records);
    if (periodId === null) {
      throw new Error("expected a para period");
    }
    const doc = publishParaVisible(records, periodId);
    // Every rostered student belongs to the scoped period; the P4 students (EF/GH) are absent.
    const rosterInitials = new Set(
      doc.roster.map((r) => records.students.find((s) => s.student_id === r.studentId)?.initials),
    );
    expect(rosterInitials.has("EF")).toBe(false);
    expect(rosterInitials.has("GH")).toBe(false);
  });
});

describe("deriveParaQueue (U6 master-truth validation queue)", () => {
  it("returns the seeded para pending points until a matching validated record lands in master", () => {
    const seed = buildSyntheticSeed(NOW);
    // Nothing validated yet: both seeded para captures are queued.
    expect(deriveParaQueue([], seed.paraPending).length).toBe(seed.paraPending.length);

    // A validated record in master (same data_point_id) drops that point from the queue —
    // regardless of whether its para tombstone has landed (self-healing property).
    const first = seed.paraPending[0];
    if (first === undefined) {
      throw new Error("expected seeded para pending");
    }
    const validatedInMaster = {
      ...first,
      state: "scored" as const,
      validated_by: "teacher" as const,
    };
    const remaining = deriveParaQueue([validatedInMaster], seed.paraPending);
    expect(remaining.some((p) => p.data_point_id === first.data_point_id)).toBe(false);
    expect(remaining.length).toBe(seed.paraPending.length - 1);
  });
});
