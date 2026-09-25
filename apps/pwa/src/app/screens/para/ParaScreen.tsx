// U6 — the para surface (M13). A period-scoped aide screen rendered ENTIRELY from
// the para device's own `{period}/para-visible` doc (opaque ids + Period-DEK handles
// + the non-PII administer-label) — decrypted with a ParaKeyring that holds ONLY the
// Period DEK. No goal definition, trend/history/export, or any other period is
// reachable here by construction (the key boundary, not a filter). Every capture lands
// ⏳ pending in this doc for the teacher to validate.

import type { OpaqueId } from "@teacher-assistant/schema";
import { useState } from "react";
import type { ParaDocRecords } from "../../../data/repository.js";
import type { DocMutator } from "../../../data/session.js";
import { Avatar } from "../../../design/Avatar.js";
import { StatusChip } from "../../../design/StatusChip.js";
import { STATUS_CHIPS } from "../../../design/glyphs.js";
import { ParaCaptureSheet, type ParaCaptureTarget } from "./ParaCaptureSheet.js";
import { orderAdministerRows } from "./para-order.js";

export interface ParaScreenProps {
  readonly paraRecords: ParaDocRecords;
  readonly now: Date;
  readonly capturePara: (mutator: DocMutator) => Promise<void>;
}

export function ParaScreen({ paraRecords, now, capturePara }: ParaScreenProps) {
  const [target, setTarget] = useState<ParaCaptureTarget | null>(null);

  if (paraRecords.periodId === null) {
    return (
      <div className="para">
        <div className="banner info">No period is assigned to a para on this device.</div>
      </div>
    );
  }

  const initialsById = new Map(paraRecords.roster.map((r) => [r.studentId, r.initials]));
  const initialsOf = (studentId: OpaqueId) => initialsById.get(studentId) ?? "??";
  const administer = orderAdministerRows(paraRecords.administer, initialsOf);
  // A goal already has a para entry awaiting validation (⏳) — its Score is a pending
  // tag instead. Derived from THIS doc: a pending point not yet consumed by a tombstone.
  const consumed = new Set(paraRecords.tombstones.map((t) => t.dataPointId));
  const pendingGoalIds = new Set(
    paraRecords.pending.filter((p) => !consumed.has(p.data_point_id)).map((p) => p.goal_id),
  );

  const commit = async (mutator: DocMutator) => {
    await capturePara(mutator);
    setTarget(null);
  };

  return (
    <div className="para" data-testid="para-surface">
      <div className="banner info">
        3rd period · Math 81 Resource · para: JT · scoped to this class only — no other students, no
        trends, no export.
      </div>
      <h1>Your students today</h1>
      <div className="sub">Enter scores; the teacher confirms each one before it counts.</div>

      {administer.length === 0 ? (
        <div className="card">No probes to administer for this class right now.</div>
      ) : (
        administer.map((row) => {
          const initials = initialsOf(row.studentId);
          const pending = pendingGoalIds.has(row.goalId);
          return (
            <div
              className="row"
              data-testid="para-admin-row"
              key={`${row.goalId}-${row.probeDefinitionId}`}
            >
              <StatusChip
                chip={pending ? STATUS_CHIPS.pending : STATUS_CHIPS.owes}
                label={pending ? "pending" : "to score"}
              />
              <Avatar initials={initials} />
              <div className="rowmain">
                <span className="rowtitle">{row.administerLabel}</span>
              </div>
              <div className="rowright">
                {pending ? (
                  <span className="pendnote" data-testid="para-pending">
                    ⏳ pending
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn small primary"
                    data-testid="para-score"
                    aria-label={`score ${row.administerLabel}`}
                    onClick={() =>
                      setTarget({
                        goalId: row.goalId,
                        studentId: row.studentId,
                        initials,
                        probeDefinitionId: row.probeDefinitionId,
                        administerLabel: row.administerLabel,
                        expectedDenominator: row.expectedDenominator,
                      })
                    }
                  >
                    Score
                  </button>
                )}
              </div>
            </div>
          );
        })
      )}

      <div className="note" style={{ marginTop: "0.8rem" }}>
        This is your one assigned class. No other students, no trends, no export — by design.
      </div>

      {target !== null ? (
        <ParaCaptureSheet
          target={target}
          settingPicklist={paraRecords.settingPicklist}
          now={now}
          onCommit={commit}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </div>
  );
}
