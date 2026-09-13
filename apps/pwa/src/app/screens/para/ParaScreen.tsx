// U6 — the para surface (M13). A period-scoped aide screen: ONLY the para's one
// class (the has_para period), rendered entirely from the `3p/para-visible`
// projection (opaque ids + Period-DEK handles + the non-PII administer-label). No
// goal definition, no trend/history/export, no other period is reachable here. Every
// capture lands ⏳ pending for the teacher to validate.

import { useState } from "react";
import type { DecryptedRecords } from "../../../data/repository.js";
import type { DocMutator } from "../../../data/session.js";
import { Avatar } from "../../../design/Avatar.js";
import { ParaCaptureSheet, type ParaCaptureTarget } from "./ParaCaptureSheet.js";
import { buildParaVisible, paraPeriodId } from "./para-vm.js";

export interface ParaScreenProps {
  readonly records: DecryptedRecords;
  readonly now: Date;
  readonly apply: (mutator: DocMutator) => Promise<void>;
}

export function ParaScreen({ records, now, apply }: ParaScreenProps) {
  const [target, setTarget] = useState<ParaCaptureTarget | null>(null);
  const periodId = paraPeriodId(records);

  if (periodId === null) {
    return (
      <div className="para">
        <div className="banner info">No period is assigned to a para on this device.</div>
      </div>
    );
  }

  const doc = buildParaVisible(records, periodId);
  const initialsById = new Map(doc.roster.map((r) => [r.studentId, r.initials]));
  // A goal already has a para entry awaiting validation (⏳): its Score is disabled.
  const pendingGoalIds = new Set(
    records.points
      .filter((p) => p.scorer === "para" && p.validated_by === undefined)
      .map((p) => p.goal_id),
  );

  const commit = async (mutator: DocMutator) => {
    await apply(mutator);
    setTarget(null);
  };

  return (
    <div className="para">
      <div className="banner info">
        Math 81 Resource · scoped to this class only — no other students, no trends, no export.
      </div>
      <h1>Your students today</h1>
      <div className="sub">Enter scores; the teacher confirms each one before it counts.</div>

      {doc.administer.length === 0 ? (
        <div className="card">No probes to administer for this class right now.</div>
      ) : (
        doc.administer.map((row) => {
          const initials = initialsById.get(row.studentId) ?? "??";
          const pending = pendingGoalIds.has(row.goalId);
          return (
            <div className="row" key={`${row.goalId}-${row.probeDefinitionId}`}>
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
          settingPicklist={doc.settingPicklist}
          now={now}
          onCommit={commit}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </div>
  );
}
