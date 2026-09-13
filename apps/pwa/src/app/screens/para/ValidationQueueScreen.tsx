// U6 — teacher-side para-validation queue (M13, design §A.5 F1). Every para entry
// lands ⏳ pending and becomes an ARC-auditable record ONLY when the teacher
// validates it here. The queue is ITEMIZED: each row shows every value the para
// entered (correct/total, %, date, setting, observations, off-basis flag) and is
// individually Confirmable/Fixable — never a collapsed "confirm all" with hidden
// values (§A.5). Validation routes through validateParaMutator (the engine writes
// only the validated record + a tombstone; no trend/history is produced).

import { orderPendingForValidation } from "@teacher-assistant/domain-core";
import type { ProgressDataPoint } from "@teacher-assistant/schema";
import { StatusChip } from "../../../design/StatusChip.js";
import { Avatar } from "../../../design/Avatar.js";
import { OBS_LABEL } from "./labels.js";

function valueLine(p: ProgressDataPoint): string {
  const parts: string[] = [];
  if (p.state === "no_data") {
    parts.push(`⊘ ${p.no_data_reason ?? "no data"}`);
  } else if (p.numerator !== undefined && p.denominator_used !== undefined) {
    const pct = Math.round((p.numerator / p.denominator_used) * 100);
    parts.push(`${p.numerator}/${p.denominator_used} = ${pct}%`);
  }
  parts.push(p.admin_date);
  const obs = (p.para_observations ?? []).map((o) => OBS_LABEL[o] ?? o);
  const accoms = p.accommodation_subtypes ?? [];
  if (obs.length > 0) {
    parts.push(obs.join(", "));
  }
  if (accoms.length > 0) {
    parts.push(`[${accoms.join(", ")}]`);
  }
  return parts.join(" · ");
}

export interface ValidationQueueScreenProps {
  readonly records: { readonly points: readonly ProgressDataPoint[] };
  readonly initialsById: ReadonlyMap<string, string>;
  readonly goalTextById: ReadonlyMap<string, string>;
  readonly onConfirm: (pending: ProgressDataPoint) => void;
  readonly onFix: (pending: ProgressDataPoint) => void;
  readonly onBack: () => void;
}

export function ValidationQueueScreen({
  records,
  initialsById,
  goalTextById,
  onConfirm,
  onFix,
  onBack,
}: ValidationQueueScreenProps) {
  const pending = orderPendingForValidation(
    records.points.filter((p) => p.scorer === "para" && p.validated_by === undefined),
  );

  return (
    <div className="validation-queue">
      <div className="backrow">
        <button type="button" className="back" onClick={onBack}>
          ‹ Dashboard
        </button>
      </div>
      <h1>Para points to confirm</h1>
      <div className="sub">
        Each para entry stays pending until you confirm it. Confirm one at a time — every value is
        shown; nothing counts until you OK it.
      </div>

      {pending.length === 0 ? (
        <div className="card" data-testid="queue-empty">
          Nothing awaiting your confirmation.
        </div>
      ) : (
        pending.map((p) => {
          const initials = initialsById.get(p.student_id) ?? "??";
          return (
            <div className="row validate" key={p.data_point_id}>
              <StatusChip chip={{ glyph: "⏳", className: "pending" }} label="pending" />
              <Avatar initials={initials} />
              <div className="rowmain">
                <span className="rowtitle">{goalTextById.get(p.goal_id) ?? "(goal)"}</span>
                <span className="rowmeta">{valueLine(p)} · JT</span>
                {p.denominator_mismatch ? (
                  <span className="note warn" data-testid="validate-mismatch">
                    Total differs from the assigned probe ({p.denominator_original}) —
                    original-vs-used retained; excluded from the consistency window until you
                    resolve.
                  </span>
                ) : null}
                <div className="valbtns">
                  <button
                    type="button"
                    className="btn small primary"
                    aria-label={`confirm ${initials}`}
                    onClick={() => onConfirm(p)}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    aria-label={`fix ${initials}`}
                    onClick={() => onFix(p)}
                  >
                    Fix
                  </button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
