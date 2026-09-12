// FERPA-guard — HARD STOP #M13 (para role surface, field-split §1-§4, DECISIONS
// D-ARCH-FERPA-M13). The 11 HARD build conditions, each asserted here: behaviourally
// against the real M13 engine, and/or by a static (comment-stripped) scan of the
// para-visible source so the privacy prose that NAMES a forbidden field does not
// trip the check. Least-privilege is enforced by which field sits under which key,
// not by a UI filter — so the para-visible surfaces must be structurally incapable
// of carrying a teacher-MK field.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAdministerLabel,
  buildParaPendingPoint,
  opaqueAdministerLabel,
  PARA_NO_DATA_REASONS,
  type ParaCaptureContext,
  validateParaPoint,
} from "@teacher-assistant/domain-core";
import { generatePeriodKey, ParaKeyring, sodiumReady } from "@teacher-assistant/crypto";
import {
  type AccommodationSubtype,
  asTimestamp,
  type IsoDate,
  newOpaqueId,
  newScopeTag,
  type OpaqueId,
  type ParaObservation,
  type Timestamp,
} from "@teacher-assistant/schema";
import { buildParaVisibleProjection } from "@teacher-assistant/store";
import { beforeAll, describe, expect, it } from "vitest";
import { collectFiles, scanCodeForPattern } from "../src/checks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// The para-VISIBLE surfaces: the administer-label builder, the capture write, and
// the Period-DEK projection. These must never reference a teacher-MK goal field.
const paraFiles = [
  join(repoRoot, "packages", "domain-core", "src", "para-administer-label.ts"),
  join(repoRoot, "packages", "domain-core", "src", "para-capture.ts"),
  join(repoRoot, "packages", "store", "src", "para-projection.ts"),
];

const iso = (s: string): IsoDate => s as IsoDate;
const ts = (n: number): Timestamp => asTimestamp(n);
const P3 = "period-3" as OpaqueId;

function ctx(over?: Partial<ParaCaptureContext>): ParaCaptureContext {
  return {
    dataPointId: newOpaqueId(),
    goalId: newOpaqueId(),
    studentId: newOpaqueId(),
    probeConditionId: newOpaqueId(),
    expectedDenominator: 10,
    adminDate: iso("2026-09-10"),
    setting: "math_resource",
    entryTs: ts(0),
    adminDateBounds: { earliest: iso("2026-09-07"), latest: iso("2026-09-11") },
    ...over,
  };
}

// #1/#7 — no teacher-MK goal field may appear in the para-visible source at all.
describe("#1/#4/#7 — the para-visible source references NO teacher-MK goal field", () => {
  const mkGoalFields: readonly RegExp[] = [
    /\bgoal_text\b/,
    /\.behavior\b/, // a goal.behavior READ (not the "behavior" ⊘-reason string literal)
    /\bcircumstance\b/,
    /\bcriterion_level\b/,
    /\bcriterion_consistency\b/,
    /\bmethod_general\b/,
    /\bmethod_tool\b/,
    /\bfrequency\b/,
    /\bbaseline_value\b/,
    /\bbaseline_source\b/,
    /\bbaseline_window_start\b/,
    /\baccom_mod\b/, // #4: accommodation_subtypes must have NO edge from accom_mod
    /\bdenominator_model\b/,
    /\barc_date/, // matches arc_date AND arc_date_flag
    /\biep_end_date\b/,
    /\bmastery\b/,
    /\btrend\b/,
  ];
  // NOTE: the goal `status` VALUE must not be serialized either, but `status` is
  // read for filtering here — so that invariant is proven behaviourally by the
  // output-key-set assertion below, not by this source scan.

  it("no MK goal field is referenced in the administer-label / capture / projection code", () => {
    for (const pattern of mkGoalFields) {
      const hits = scanCodeForPattern(paraFiles, pattern);
      expect(hits, `${pattern} → ${JSON.stringify(hits, null, 2)}`).toEqual([]);
    }
  });
});

describe("#2 — administer-label is built from the NON-PII catalog only, opaque fallback", () => {
  it("a goal_text / free-form label edge does not exist in the label builder source", () => {
    const labelFile = [
      join(repoRoot, "packages", "domain-core", "src", "para-administer-label.ts"),
    ];
    expect(scanCodeForPattern(labelFile, /\bgoal_text\b/)).toEqual([]);
    expect(scanCodeForPattern(labelFile, /\.label\b/)).toEqual([]);
  });

  it("composes the catalog fields; falls back to an opaque handle with zero topic", () => {
    expect(
      buildAdministerLabel({
        topicLabel: "Two-step equations",
        standardCode: "EE7",
        expectedDenominator: 10,
      }),
    ).toBe("Two-step equations · EE7 · 10 items");
    expect(opaqueAdministerLabel(1, 10)).toBe("Probe 1 · 10 items");
  });
});

describe("#3 — ZERO free text; chip enums are exact closed sets; ⊘ excludes Testing", () => {
  it("the para ⊘ picklist is Absent/Behavior/No-time ONLY (no Testing, no No-school)", () => {
    expect([...PARA_NO_DATA_REASONS].sort()).toEqual(["absent", "behavior", "no_time"]);
    expect(PARA_NO_DATA_REASONS).not.toContain("testing");
    expect(PARA_NO_DATA_REASONS).not.toContain("no_school");
  });

  it("a chip outside the locked closed set is rejected (no unknown value, no free text)", () => {
    const bad = buildParaPendingPoint(ctx({ entryTs: ts(1) }), {
      kind: "scored",
      numerator: 5,
      denominatorUsed: 10,
      paraObservations: ["Independent", "FreeTextSmuggled" as ParaObservation],
    });
    expect(bad).toEqual({ ok: false, reason: "invalid_observation_chip" });
  });
});

describe("#4 — accommodation_subtypes carry only the para's witnessed selections", () => {
  it("the subtypes on the point equal exactly what the para passed (no accom_mod source)", () => {
    const subs: readonly AccommodationSubtype[] = ["Calculator"];
    const res = buildParaPendingPoint(ctx({ entryTs: ts(1) }), {
      kind: "scored",
      numerator: 7,
      denominatorUsed: 10,
      accommodationSubtypes: subs,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.point.accommodation_subtypes).toEqual(["Calculator"]);
    }
  });
});

describe("#5 — F-4 disambiguation is a system ordinal, not a teacher attribute", () => {
  it("two same-topic probes for one student get Probe 1 / Probe 2", () => {
    const s1 = "stu-1" as OpaqueId;
    const cat = { topicLabel: "Two-step equations", standardCode: "EE7", expectedDenominator: 10 };
    const doc = buildParaVisibleProjection({
      periodId: P3,
      roster: [{ studentId: s1, initials: "AB", colorToken: "c", periodId: P3, active: true }],
      sources: [
        {
          goalId: newOpaqueId(),
          studentId: s1,
          periodId: P3,
          status: "active",
          probeDefinitionId: "a" as OpaqueId,
          expectedDenominator: 10,
          catalog: cat,
        },
        {
          goalId: newOpaqueId(),
          studentId: s1,
          periodId: P3,
          status: "active",
          probeDefinitionId: "b" as OpaqueId,
          expectedDenominator: 10,
          catalog: cat,
        },
      ],
    });
    expect(doc.administer.map((a) => a.administerLabel)).toEqual([
      "Two-step equations · EE7 · 10 items · Probe 1",
      "Two-step equations · EE7 · 10 items · Probe 2",
    ]);
  });
});

describe("#1/#7 — the projection emits only opaque ids + Period-DEK handles", () => {
  it("administer rows reference the goal by opaque id and carry no MK content", () => {
    const s1 = "stu-1" as OpaqueId;
    const doc = buildParaVisibleProjection({
      periodId: P3,
      roster: [{ studentId: s1, initials: "AB", colorToken: "c", periodId: P3, active: true }],
      sources: [
        {
          goalId: newOpaqueId(),
          studentId: s1,
          periodId: P3,
          status: "active",
          probeDefinitionId: newOpaqueId(),
          expectedDenominator: 10,
          catalog: { topicLabel: "Fractions", standardCode: "NS1", expectedDenominator: 10 },
        },
      ],
    });
    const json = JSON.stringify(doc);
    for (const forbidden of ["criterion", "baseline", "accom", "goal_text", "behavior"]) {
      expect(json.includes(forbidden)).toBe(false);
    }
    expect(Object.keys(doc.administer[0] ?? {}).sort()).toEqual([
      "administerLabel",
      "expectedDenominator",
      "goalId",
      "probeDefinitionId",
      "studentId",
    ]);
  });
});

describe("#8 — validation writes the MK record + a tombstone, never trend/history back", () => {
  it("the result is exactly {validated (MK, stamped), tombstone}", () => {
    const res = buildParaPendingPoint(ctx({ entryTs: ts(1) }), {
      kind: "scored",
      numerator: 8,
      denominatorUsed: 10,
    });
    if (!res.ok) throw new Error("fixture");
    const out = validateParaPoint(res.point, { who: "teacher", when: ts(9) });
    expect(Object.keys(out).sort()).toEqual(["tombstone", "validated"]);
    expect(out.validated.validated_by).toBe("teacher");
    expect(out.validated.state).toBe("scored");
    expect(Object.keys(out.tombstone).sort()).toEqual(["consumedTs", "dataPointId"]);
    // No trend/history/quarterly/statement/export surface leaks out of validation.
    const json = JSON.stringify(out);
    for (const forbidden of ["trend", "quarterly", "statement", "history", "mastery", "export"]) {
      expect(json.toLowerCase().includes(forbidden)).toBe(false);
    }
  });
});

describe("#6 — the para pending point carries no person-name; attribution is the opaque scorer enum", () => {
  it("has no name-like field; 'who' is scorer=para (device identity lives in sync metadata, not the record)", () => {
    const res = buildParaPendingPoint(ctx({ entryTs: ts(1) }), {
      kind: "scored",
      numerator: 8,
      denominatorUsed: 10,
    });
    if (!res.ok) throw new Error("fixture");
    expect(res.point.scorer).toBe("para");
    for (const key of Object.keys(res.point)) {
      expect(key.toLowerCase().includes("name")).toBe(false);
    }
  });
});

describe("#9 — the para keyring is scoped to its period; other scopes undecryptable", () => {
  // NOTE: condition #11 (para pending store CIPHERTEXT AT REST) is enforced by the
  // crypto envelope + persistence layer, NOT by this unit — this test proves the
  // key-SCOPE boundary (#9), not at-rest encryption. Do not read it as evidence for #11.
  beforeAll(async () => {
    await sodiumReady();
  });

  it("holds exactly the 3rd-period DEK; goal-definition + other-period scopes absent", () => {
    const period3 = generatePeriodKey(newScopeTag());
    const otherPeriod = newScopeTag();
    const masterGoalDefScope = newScopeTag();
    const para = new ParaKeyring([period3]);
    expect(para.scopes()).toEqual([period3.scopeTag]);
    expect(para.hasScope(otherPeriod)).toBe(false); // cannot read another period
    expect(para.hasScope(masterGoalDefScope)).toBe(false); // cannot read goal definitions
  });
});

describe("#10 — the M8 auto-statement has no input edge from para chips", () => {
  it("auto-statement.ts references neither para_observations nor accommodation_subtypes", () => {
    const autoStmt = [join(repoRoot, "packages", "domain-core", "src", "auto-statement.ts")];
    expect(scanCodeForPattern(autoStmt, /\bpara_observations\b/)).toEqual([]);
    expect(scanCodeForPattern(autoStmt, /\baccommodation_subtypes\b/)).toEqual([]);
  });
});

// Sanity: the para-visible source files exist to be scanned.
describe("scan target sanity", () => {
  it("collects the para source files", () => {
    const present = collectFiles(join(repoRoot, "packages"), [".ts"]).filter((f) =>
      f.includes("para-"),
    );
    expect(present.length).toBeGreaterThanOrEqual(3);
  });
});
