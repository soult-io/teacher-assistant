// M13 — para capture + teacher-validation + administer-label. Acceptance
// (phase1-spec §6, field-split §1.4/§2/§3, DECISIONS D-ARCH-FERPA-M13). SYNTHETIC
// data only. Every expected value derived by hand.

import {
  asTimestamp,
  type AccommodationSubtype,
  type IsoDate,
  newOpaqueId,
  type OpaqueId,
  type ParaObservation,
  type ProgressDataPoint,
  type Timestamp,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import {
  buildAdministerLabel,
  buildParaPendingPoint,
  type ParaCaptureContext,
  type ParaNoDataReason,
  ParaValidationError,
  opaqueAdministerLabel,
  orderPendingForValidation,
  validateParaPoint,
} from "./index.js";

const iso = (s: string): IsoDate => s as IsoDate;

function ctx(over?: Partial<ParaCaptureContext>): ParaCaptureContext {
  return {
    dataPointId: newOpaqueId(),
    goalId: newOpaqueId(),
    studentId: newOpaqueId(),
    probeConditionId: newOpaqueId(),
    expectedDenominator: 10,
    adminDate: iso("2026-09-10"),
    setting: "math_resource",
    entryTs: asTimestamp(1000),
    adminDateBounds: { earliest: iso("2026-09-07"), latest: iso("2026-09-11") },
    ...over,
  };
}

describe("administer-label is built from the NON-PII catalog ONLY (field-split §2)", () => {
  it("composes topic · standard · item count, with an ordinal only to disambiguate", () => {
    const entry = {
      topicLabel: "Two-step equations",
      standardCode: "EE7",
      expectedDenominator: 10,
    };
    expect(buildAdministerLabel(entry)).toBe("Two-step equations · EE7 · 10 items");
    expect(buildAdministerLabel(entry, 2)).toBe("Two-step equations · EE7 · 10 items · Probe 2");
  });

  it("opaque fallback carries an ordinal + item count and zero topic (F-1 downgrade)", () => {
    expect(opaqueAdministerLabel(1, 10)).toBe("Probe 1 · 10 items");
  });
});

describe("para pending point — HARD-constrained write (field-split §1.4)", () => {
  it("a valid scored entry lands PENDING, scorer=para, never validated", () => {
    const c = ctx();
    const res = buildParaPendingPoint(c, { kind: "scored", numerator: 8, denominatorUsed: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.point;
    expect(p.state).toBe("pending");
    expect(p.scorer).toBe("para");
    expect(p.numerator).toBe(8);
    expect(p.denominator_used).toBe(10);
    expect(p.denominator_original).toBe(10); // = expected_denominator, read-only
    expect(p.denominator_mismatch).toBe(false);
    expect(p.computed_value).toBeCloseTo(0.8);
    expect(p.validated_by).toBeUndefined(); // NEVER set on the para surface
    expect(p.validated_ts).toBeUndefined();
  });

  it("records THIS probe's actual total and flags a denominator mismatch, retaining the original", () => {
    const res = buildParaPendingPoint(ctx({ expectedDenominator: 10 }), {
      kind: "scored",
      numerator: 6,
      denominatorUsed: 8, // this session's actual total differs from the assigned 10
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.point.denominator_original).toBe(10); // never overwritten
    expect(res.point.denominator_used).toBe(8);
    expect(res.point.denominator_mismatch).toBe(true);
  });

  it("rejects an out-of-range numerator, a non-positive denominator, and an out-of-bounds date", () => {
    const bad1 = buildParaPendingPoint(ctx(), {
      kind: "scored",
      numerator: 11,
      denominatorUsed: 10,
    });
    expect(bad1).toEqual({ ok: false, reason: "numerator_out_of_range" });
    const bad2 = buildParaPendingPoint(ctx(), { kind: "scored", numerator: 0, denominatorUsed: 0 });
    expect(bad2).toEqual({ ok: false, reason: "denominator_nonpositive" });
    const future = buildParaPendingPoint(ctx({ adminDate: iso("2026-09-12") }), {
      kind: "scored",
      numerator: 5,
      denominatorUsed: 10,
    });
    expect(future).toEqual({ ok: false, reason: "admin_date_out_of_bounds" });
  });

  it("⊘ reasons are Absent/Behavior/No-time ONLY — Testing and No-school are not para-reachable", () => {
    const ok = buildParaPendingPoint(ctx(), { kind: "no_data", noDataReason: "absent" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.point.state).toBe("no_data");
      expect(ok.point.no_data_reason).toBe("absent");
      expect(ok.point.numerator).toBeUndefined();
    }
    // Teacher-only (testing) and calendar-only (no_school) reasons must be rejected:
    // cast past the narrow para union to prove the runtime guard, not just the type.
    const testing = buildParaPendingPoint(ctx(), {
      kind: "no_data",
      noDataReason: "testing" as unknown as ParaNoDataReason,
    });
    expect(testing).toEqual({ ok: false, reason: "invalid_no_data_reason" });
    const noSchool = buildParaPendingPoint(ctx(), {
      kind: "no_data",
      noDataReason: "no_school" as unknown as ParaNoDataReason,
    });
    expect(noSchool).toEqual({ ok: false, reason: "invalid_no_data_reason" });
  });

  it("rejects any chip outside the LOCKED closed enums (no free text, no unknown chip)", () => {
    const badObs = buildParaPendingPoint(ctx(), {
      kind: "scored",
      numerator: 5,
      denominatorUsed: 10,
      paraObservations: ["Independent", "NotARealChip" as ParaObservation],
    });
    expect(badObs).toEqual({ ok: false, reason: "invalid_observation_chip" });
    const badSub = buildParaPendingPoint(ctx(), {
      kind: "scored",
      numerator: 5,
      denominatorUsed: 10,
      accommodationSubtypes: ["Calculator", "Telepathy" as AccommodationSubtype],
    });
    expect(badSub).toEqual({ ok: false, reason: "invalid_accommodation_subtype" });
  });

  it("accommodation_subtypes carry ONLY the para's witnessed selections (no accom_mod edge)", () => {
    // The context has no accom_mod field at all — the subtypes can only be what the
    // para passed; there is no code path from the goal's prescribed accommodation.
    const res = buildParaPendingPoint(ctx(), {
      kind: "scored",
      numerator: 7,
      denominatorUsed: 10,
      paraObservations: ["Accommodation", "UsedLearnedStrategy"],
      accommodationSubtypes: ["Calculator"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.point.accommodation_subtypes).toEqual(["Calculator"]);
      expect(res.point.para_observations).toEqual(["Accommodation", "UsedLearnedStrategy"]);
    }
  });
});

describe("teacher validation writes the MK record and tombstones the para pending entry (§3)", () => {
  function pendingScored(): ProgressDataPoint {
    const res = buildParaPendingPoint(ctx(), { kind: "scored", numerator: 8, denominatorUsed: 10 });
    if (!res.ok) throw new Error("fixture");
    return res.point;
  }

  it("promotes a scored pending point to a validated, scored canonical record", () => {
    const when: Timestamp = asTimestamp(5000);
    const { validated, tombstone } = validateParaPoint(pendingScored(), { who: "teacher", when });
    expect(validated.state).toBe("scored");
    expect(validated.validated_by).toBe("teacher");
    expect(validated.validated_ts).toBe(when);
    expect(validated.numerator).toBe(8); // the witnessed values carry through unchanged
    // The only thing written back to the para doc is the consume tombstone.
    expect(tombstone.dataPointId).toBe(validated.data_point_id);
    expect(tombstone.consumedTs).toBe(when);
  });

  it("a documented ⊘ stays no_data on validation", () => {
    const res = buildParaPendingPoint(ctx(), { kind: "no_data", noDataReason: "behavior" });
    if (!res.ok) throw new Error("fixture");
    const { validated } = validateParaPoint(res.point, { who: "teacher", when: asTimestamp(1) });
    expect(validated.state).toBe("no_data");
    expect(validated.validated_by).toBe("teacher");
  });

  it("refuses to validate a non-para point or an already-validated point", () => {
    const teacherPoint: ProgressDataPoint = { ...pendingScored(), scorer: "teacher" };
    expect(() => validateParaPoint(teacherPoint, { who: "teacher", when: asTimestamp(1) })).toThrow(
      ParaValidationError,
    );
    const already: ProgressDataPoint = {
      ...pendingScored(),
      validated_by: "teacher",
      validated_ts: asTimestamp(1),
    };
    expect(() => validateParaPoint(already, { who: "teacher", when: asTimestamp(2) })).toThrow(
      ParaValidationError,
    );
  });

  it("orders a validation batch deterministically (admin-date, then opaque id)", () => {
    const g = newOpaqueId();
    const s = newOpaqueId();
    const mk = (id: OpaqueId, date: string): ProgressDataPoint => ({
      data_point_id: id,
      goal_id: g,
      student_id: s,
      admin_date: iso(date),
      entry_ts: asTimestamp(0),
      state: "pending",
      setting: "math_resource",
      scorer: "para",
      revisions: [],
    });
    const a = mk("aaa" as OpaqueId, "2026-09-10");
    const b = mk("bbb" as OpaqueId, "2026-09-08");
    const ordered = orderPendingForValidation([a, b]);
    expect(ordered.map((p) => p.admin_date)).toEqual(["2026-09-08", "2026-09-10"]);
  });
});
