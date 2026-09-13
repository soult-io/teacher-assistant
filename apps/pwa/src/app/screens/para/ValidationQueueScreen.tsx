// U6 — teacher-side para-validation queue (M13, design §A.5 F1). Every para entry
// lands ⏳ pending in the {period}/para-visible doc and becomes an ARC-auditable
// record ONLY when the teacher validates it. The `queue` is DERIVED FROM MASTER TRUTH
// by the teacher session (a para pending point with no validated record in master),
// ordered deterministically. Each row is ITEMIZED — every value the para entered
// (correct/total, %, date, SETTING, observations, off-basis flag) is shown, and each
// is individually Confirm/Fix-able — never a collapsed "confirm all" with hidden
// values (§A.5). Validation routes through the session's two-doc coordinator: the
// validated record → master, a tombstone → the para doc; no trend/history is produced.

import type { ProgressDataPoint } from "@teacher-assistant/schema";
import { StatusChip } from "../../../design/StatusChip.js";
import { Avatar } from "../../../design/Avatar.js";
import { OBS_LABEL, SETTING_LABEL } from "./labels.js";

function valueLine(p: ProgressDataPoint): string {
  const parts: string[] = [];
  if (p.state === "no_data") {
    parts.push(`⊘ ${p.no_data_reason ?? "no data"}`);
  } else if (p.numerator !== undefined && p.denominator_used !== undefined) {
    const pct = Math.round((p.numerator / p.denominator_used) * 100);
    parts.push(`${p.numerator}/${p.denominator_used} = ${pct}%`);
  }
  parts.push(p.admin_date);
  // §A.5: the teacher must see the SETTING the para recorded to validate honestly.
  parts.push(SETTING_LABEL[p.setting]);
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
  /** The pending para points to validate — already master-truth-filtered + ordered by the session. */
  readonly queue: readonly ProgressDataPoint[];
  readonly initialsById: ReadonlyMap<string, string>;
  readonly goalTextById: ReadonlyMap<string, string>;
  readonly onConfirm: (pending: ProgressDataPoint) => void;
  readonly onFix: (pending: ProgressDataPoint) => void;
  readonly onBack: () => void;
}

export function ValidationQueueScreen({
  queue,
  initialsById,
  goalTextById,
  onConfirm,
  onFix,
  onBack,
}: ValidationQueueScreenProps) {
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

      {queue.length === 0 ? (
        <div className="card" data-testid="queue-empty">
          Nothing awaiting your confirmation.
        </div>
      ) : (
        queue.map((p) => {
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
