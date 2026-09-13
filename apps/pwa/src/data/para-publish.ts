// U6 — the teacher→para PUBLICATION source (topology D2) and the master-truth
// validation-queue derivation (D3). The teacher device (holds MK + the Period DEK)
// is the ONLY writer of the para doc's roster/administer/settingPicklist: it
// materializes the para-visible SLICE of its master records into the Period-DEK
// doc. `publishParaVisible` is a pure, deterministic, idempotent function of master
// state → ParaVisibleDoc; re-running it when nothing changed is a no-op, so it is
// safe to run defensively (no human "publish" button).
//
// The output is `buildParaVisibleProjection`'s ParaVisibleDoc — a type that CANNOT
// represent a teacher-MK field (goal_text, criterion, accom_mod, …). The
// administer-label's topic/standard come ONLY from the NON-PII catalog store (C-3),
// never goal_text. This module holds NO domain rules — it feeds the store engine.

import {
  type ParaAdministerSource,
  type ParaRosterMember,
  type ParaVisibleDoc,
  buildParaVisibleProjection,
} from "@teacher-assistant/store";
import { orderPendingForValidation } from "@teacher-assistant/domain-core";
import type { OpaqueId, ProgressDataPoint } from "@teacher-assistant/schema";
import type { DecryptedRecords } from "./repository.js";

/** The period this device's para is scoped to — the one class flagged has_para. */
export function paraPeriodId(records: DecryptedRecords): OpaqueId | null {
  return records.periods.find((p) => p.has_para)?.period_id ?? null;
}

/**
 * Publish source: materialize the `{period}/para-visible` projection from the
 * teacher's master records. The roster + administer rows carry ONLY opaque ids +
 * Period-DEK handles; the catalog (topic + standard) is looked up from the cleartext
 * NON-PII catalog store, never goal_text. buildParaVisibleProjection then pre-filters
 * to ACTIVE members/goals of the scoped period. The teacher session diffs this into
 * the Period-DEK doc (repository.writeParaVisibleProjection).
 */
export function publishParaVisible(records: DecryptedRecords, periodId: OpaqueId): ParaVisibleDoc {
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

/**
 * The teacher's validation queue, DERIVED FROM MASTER TRUTH (D3, property 2): the
 * para-doc pending points that have NO corresponding validated record in master
 * (keyed by opaque data_point_id). A validated point lands in master.points with the
 * same id, which excludes it here regardless of whether its para tombstone has landed
 * yet — so a crash between the two-doc writes self-heals and never double-counts.
 * Ordered deterministically (admin-date, then opaque id).
 */
export function deriveParaQueue(
  masterPoints: readonly ProgressDataPoint[],
  paraPending: readonly ProgressDataPoint[],
): ProgressDataPoint[] {
  const validatedIds = new Set(masterPoints.map((p) => p.data_point_id));
  return orderPendingForValidation(paraPending.filter((p) => !validatedIds.has(p.data_point_id)));
}
