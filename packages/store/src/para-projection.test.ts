// M13 — the para-visible projection. Acceptance (field-split §1/§2/§3, DECISIONS
// D-ARCH-FERPA-M13 #1/#2/#5/#7/#9). SYNTHETIC data only.

import { newOpaqueId, type OpaqueId } from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  buildParaVisibleProjection,
  type ParaAdministerSource,
  type ParaRosterMember,
} from "./index.js";

const P3 = "period-3" as OpaqueId;
const P7 = "period-7" as OpaqueId;

function member(over: Partial<ParaRosterMember> & { studentId: OpaqueId }): ParaRosterMember {
  return {
    initials: "AB",
    colorToken: "hsl(200 60% 50%)",
    periodId: P3,
    active: true,
    ...over,
  };
}

function source(
  over: Partial<ParaAdministerSource> & { studentId: OpaqueId },
): ParaAdministerSource {
  return {
    goalId: newOpaqueId(),
    periodId: P3,
    status: "active",
    probeDefinitionId: newOpaqueId(),
    expectedDenominator: 10,
    ...over,
  };
}

describe("roster is pre-filtered to ACTIVE members of the scoped period only (§1.1, #9)", () => {
  it("excludes other periods and inactive students; emits only the three handles", () => {
    const s1 = "stu-1" as OpaqueId;
    const s2 = "stu-2" as OpaqueId;
    const s3 = "stu-3" as OpaqueId;
    const doc = buildParaVisibleProjection({
      periodId: P3,
      roster: [
        member({ studentId: s1, initials: "AB" }),
        member({ studentId: s2, initials: "CD", periodId: P7 }), // other period
        member({ studentId: s3, initials: "EF", active: false }), // inactive
      ],
      sources: [],
    });
    expect(doc.roster.map((r) => r.studentId)).toEqual([s1]);
    expect(Object.keys(doc.roster[0] ?? {}).sort()).toEqual([
      "colorToken",
      "initials",
      "studentId",
    ]);
  });
});

describe("administer rows are active-only, this-period-only, opaque-linked (§1.2, #1/#7)", () => {
  it("projects an active goal's probe as a curriculum label, linked by opaque goal id", () => {
    const s1 = "stu-1" as OpaqueId;
    const g1 = newOpaqueId();
    const doc = buildParaVisibleProjection({
      periodId: P3,
      roster: [member({ studentId: s1 })],
      sources: [
        source({
          studentId: s1,
          goalId: g1,
          catalog: {
            topicLabel: "Two-step equations",
            standardCode: "EE7",
            expectedDenominator: 10,
          },
        }),
      ],
    });
    expect(doc.administer).toHaveLength(1);
    expect(doc.administer[0]?.goalId).toBe(g1);
    expect(doc.administer[0]?.administerLabel).toBe("Two-step equations · EE7 · 10 items");
    // No teacher-MK field is representable on the row.
    expect(Object.keys(doc.administer[0] ?? {}).sort()).toEqual([
      "administerLabel",
      "expectedDenominator",
      "goalId",
      "probeDefinitionId",
      "studentId",
    ]);
  });

  it("excludes proposed/retired goals and goals from other periods", () => {
    const s1 = "stu-1" as OpaqueId;
    const doc = buildParaVisibleProjection({
      periodId: P3,
      roster: [member({ studentId: s1 })],
      sources: [
        source({ studentId: s1, status: "proposed" }),
        source({ studentId: s1, status: "retired" }),
        source({ studentId: s1, periodId: P7 }),
      ],
    });
    expect(doc.administer).toEqual([]);
  });

  it("disambiguates a student's multiple active probes with a system ordinal (F-4, #5)", () => {
    const s1 = "stu-1" as OpaqueId;
    const doc = buildParaVisibleProjection({
      periodId: P3,
      roster: [member({ studentId: s1 })],
      sources: [
        source({
          studentId: s1,
          probeDefinitionId: "probe-a" as OpaqueId,
          catalog: {
            topicLabel: "Two-step equations",
            standardCode: "EE7",
            expectedDenominator: 10,
          },
        }),
        source({
          studentId: s1,
          probeDefinitionId: "probe-b" as OpaqueId,
          catalog: {
            topicLabel: "Two-step equations",
            standardCode: "EE7",
            expectedDenominator: 10,
          },
        }),
      ],
    });
    const labels = doc.administer.map((a) => a.administerLabel);
    expect(labels).toEqual([
      "Two-step equations · EE7 · 10 items · Probe 1",
      "Two-step equations · EE7 · 10 items · Probe 2",
    ]);
  });

  it("falls back to an opaque 'Probe N' handle when no catalog entry is available (F-1)", () => {
    const s1 = "stu-1" as OpaqueId;
    const doc = buildParaVisibleProjection({
      periodId: P3,
      roster: [member({ studentId: s1 })],
      sources: [source({ studentId: s1, expectedDenominator: 10 })], // no catalog
    });
    expect(doc.administer[0]?.administerLabel).toBe("Probe 1 · 10 items");
  });
});

describe("setting picklist is the non-PII enum values (default math_resource)", () => {
  it("exposes the three instructional-setting values", () => {
    const doc = buildParaVisibleProjection({ periodId: P3, roster: [], sources: [] });
    expect(doc.settingPicklist).toContain("math_resource");
    expect([...doc.settingPicklist].sort()).toEqual(["gen_ed", "home_scored", "math_resource"]);
  });
});
