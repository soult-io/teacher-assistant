// M13 — the para-visible projection (field-split §1.1/§1.2/§3, DECISIONS
// D-ARCH-FERPA-M13 conditions #1/#2/#5/#7/#9). Builds the `3p/para-visible` doc
// model: the pre-filtered 3rd-period roster, the read-only administer rows (linked
// to goals by OPAQUE id only), and the setting picklist.
//
// The key property is STRUCTURAL: the output type contains ONLY Period-DEK fields.
// No teacher-MK field (goal_text, the 6 KY components, criterion, baseline,
// accom_mod, denominator_model, status value, ARC dates, trend/history, exports)
// is representable here — so none can be serialized into the doc the Period DEK
// opens. Least-privilege is enforced by which field sits under which key, not by a
// UI filter. Cross-doc references are opaque UUIDs, resolvable only with the MK.

import {
  type AdministerCatalogEntry,
  buildAdministerLabel,
  compareCodePoints,
  opaqueAdministerLabel,
} from "@teacher-assistant/domain-core";
import type { GoalStatus, OpaqueId, Setting } from "@teacher-assistant/schema";
import { SETTINGS } from "@teacher-assistant/schema";
import { bucketBy } from "./group.js";

/** A teacher-side roster member (from the ENCRYPTED Student record) pre-filtered teacher-side. */
export interface ParaRosterMember {
  readonly studentId: OpaqueId;
  readonly initials: string;
  readonly colorToken: string;
  readonly periodId: OpaqueId;
  readonly active: boolean;
}

/** A teacher-side administer source (from the ENCRYPTED IEPGoal + its probe). */
export interface ParaAdministerSource {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  readonly periodId: OpaqueId;
  readonly status: GoalStatus;
  readonly probeDefinitionId: OpaqueId;
  readonly expectedDenominator: number;
  /** NON-PII curriculum catalog entry; omit → opaque "Probe N" fallback (F-1 downgrade). */
  readonly catalog?: AdministerCatalogEntry;
}

/** A Period-DEK roster row — the three handles the para needs, nothing more. */
export interface ParaVisibleRosterEntry {
  readonly studentId: OpaqueId;
  readonly initials: string;
  readonly colorToken: string;
}

/** A Period-DEK administer row — which probe to hand which student, by opaque ref. */
export interface ParaVisibleAdministerEntry {
  readonly goalId: OpaqueId;
  readonly studentId: OpaqueId;
  readonly probeDefinitionId: OpaqueId;
  readonly administerLabel: string;
  readonly expectedDenominator: number;
}

/** The `3p/para-visible` doc model — serialized under the Period DEK ONLY. */
export interface ParaVisibleDoc {
  readonly periodId: OpaqueId;
  readonly roster: readonly ParaVisibleRosterEntry[];
  readonly administer: readonly ParaVisibleAdministerEntry[];
  /** Non-PII instructional-setting enum values for the para picklist (the UI defaults the selection to math_resource). */
  readonly settingPicklist: readonly Setting[];
}

export interface ParaVisibleInput {
  /** The 3rd period this para is scoped to. */
  readonly periodId: OpaqueId;
  readonly roster: readonly ParaRosterMember[];
  readonly sources: readonly ParaAdministerSource[];
}

function bySource(a: ParaAdministerSource, b: ParaAdministerSource): number {
  return compareCodePoints(a.probeDefinitionId, b.probeDefinitionId);
}

/**
 * The administer rows for one student, in a deterministic order. When the student
 * has more than one active probe, a system ordinal (Probe 1/2…) disambiguates them
 * (F-4) — never a teacher-only attribute. A catalog entry yields the curriculum
 * label; its absence yields the opaque "Probe N" fallback.
 */
function administerRowsForStudent(
  sources: readonly ParaAdministerSource[],
): ParaVisibleAdministerEntry[] {
  const ordered = [...sources].sort(bySource);
  const disambiguate = ordered.length > 1;
  return ordered.map((s, i) => {
    const ordinal = i + 1;
    const administerLabel =
      s.catalog !== undefined
        ? buildAdministerLabel(s.catalog, disambiguate ? ordinal : undefined)
        : opaqueAdministerLabel(ordinal, s.expectedDenominator);
    return {
      goalId: s.goalId,
      studentId: s.studentId,
      probeDefinitionId: s.probeDefinitionId,
      administerLabel,
      expectedDenominator: s.expectedDenominator,
    };
  });
}

/**
 * Build the `3p/para-visible` projection: roster pre-filtered to ACTIVE members of
 * the scoped period, and read-only administer rows for ACTIVE goals in that period
 * only. Proposed/baseline/retired goals and other periods never appear. Output
 * holds only Period-DEK fields.
 */
export function buildParaVisibleProjection(input: ParaVisibleInput): ParaVisibleDoc {
  const roster: ParaVisibleRosterEntry[] = input.roster
    .filter((m) => m.periodId === input.periodId && m.active)
    .map((m) => ({ studentId: m.studentId, initials: m.initials, colorToken: m.colorToken }))
    .sort((a, b) => compareCodePoints(a.studentId, b.studentId));

  const active = input.sources.filter(
    (s) => s.periodId === input.periodId && s.status === "active",
  );
  const byStudent = bucketBy(active, (s) => s.studentId);
  const administer: ParaVisibleAdministerEntry[] = [...byStudent.keys()]
    .sort(compareCodePoints)
    .flatMap((studentId) => administerRowsForStudent(byStudent.get(studentId) ?? []));

  return { periodId: input.periodId, roster, administer, settingPicklist: [...SETTINGS] };
}
