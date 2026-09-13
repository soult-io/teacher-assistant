// U6 — para view-model. Maps the decrypted records to the M13 store projection
// (buildParaVisibleProjection), which strips everything to Period-DEK fields. The
// administer-label's topic/standard come ONLY from the NON-PII catalog store (C-3),
// never from goal_text. This module holds NO domain rules — it feeds the engine.

import {
  type ParaAdministerSource,
  type ParaRosterMember,
  type ParaVisibleDoc,
  buildParaVisibleProjection,
} from "@teacher-assistant/store";
import type { OpaqueId } from "@teacher-assistant/schema";
import type { DecryptedRecords } from "../../../data/repository.js";

/** The period this device's para is scoped to — the one class flagged has_para. */
export function paraPeriodId(records: DecryptedRecords): OpaqueId | null {
  return records.periods.find((p) => p.has_para)?.period_id ?? null;
}

/**
 * Build the `3p/para-visible` projection for the scoped period. The roster + administer
 * rows come out carrying ONLY opaque ids + Period-DEK handles; the catalog (topic +
 * standard) is looked up from the cleartext non-PII catalog store, never goal_text.
 */
export function buildParaVisible(records: DecryptedRecords, periodId: OpaqueId): ParaVisibleDoc {
  const periodByStudent = new Map(
    records.students.map((s) => [s.student_id, s.period_memberships[0] ?? null]),
  );
  const catalogByGoal = new Map(records.catalog.map((c) => [c.goal_id, c]));
  const probeByGoal = new Map(records.probes.map((p) => [p.goal_id, p]));

  const roster: ParaRosterMember[] = records.students.flatMap((s) => {
    const period = periodByStudent.get(s.student_id);
    return period === null || period === undefined
      ? []
      : [
          {
            studentId: s.student_id,
            initials: s.initials,
            colorToken: s.color_token,
            periodId: period,
            active: s.active,
          },
        ];
  });

  const sources: ParaAdministerSource[] = records.goals.flatMap((g) => {
    const probe = probeByGoal.get(g.goal_id);
    const period = periodByStudent.get(g.student_id);
    if (probe === undefined || period === null || period === undefined) {
      return [];
    }
    const cat = catalogByGoal.get(g.goal_id);
    return [
      {
        goalId: g.goal_id,
        studentId: g.student_id,
        periodId: period,
        status: g.status,
        probeDefinitionId: probe.probe_definition_id,
        expectedDenominator: probe.expected_denominator,
        // Catalog from the NON-PII store ONLY (C-3); absent → opaque "Probe N" fallback.
        ...(cat !== undefined
          ? {
              catalog: {
                topicLabel: cat.topic_label,
                standardCode: cat.standard_code,
                expectedDenominator: probe.expected_denominator,
              },
            }
          : {}),
      },
    ];
  });

  return buildParaVisibleProjection({ periodId, roster, sources });
}
