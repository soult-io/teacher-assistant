// Desktop "Needs your OK" para-validation strip (design §3.1, Q5 default): the same
// pending para points as the mobile ValidationQueueScreen, laid out as a full-width
// table above the master-detail. It honors the LOCKED itemization rule (§A.5): every
// value the para entered is VISIBLE in its own column and each row is individually
// Confirm/Fix-able — never a collapsed "confirm all". It renders ONLY on desktop, only
// when the queue is non-empty (the caller guards); mobile keeps the queue screen.
// This is a reflow of an existing surface — it adds no data and no new logic.

import type { OpaqueId, ProgressDataPoint } from "@teacher-assistant/schema";
import { Avatar } from "../../../design/Avatar.js";
import { pointValueLabel, SETTING_LABEL } from "../para/labels.js";

export interface ValidationStripProps {
  /** Pending para points — already master-truth-filtered + ordered by the teacher session. */
  readonly queue: readonly ProgressDataPoint[];
  readonly initialsById: ReadonlyMap<string, string>;
  readonly goalTextById: ReadonlyMap<string, string>;
  readonly periodLabelByStudent: (studentId: OpaqueId) => string | null;
  readonly onConfirm: (pending: ProgressDataPoint) => void;
  readonly onFix: (pending: ProgressDataPoint) => void;
}

export function ValidationStrip({
  queue,
  initialsById,
  goalTextById,
  periodLabelByStudent,
  onConfirm,
  onFix,
}: ValidationStripProps) {
  return (
    <div className="validate-strip" data-testid="validation-strip">
      <div className="grouplabel section">
        <span>Needs your OK — para points</span>
        <span className="ln" />
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Goal</th>
              <th>Period</th>
              <th>Value</th>
              <th>Admin date</th>
              <th>Setting</th>
              <th>Scorer</th>
              <th>Flag</th>
              <th> </th>
            </tr>
          </thead>
          <tbody>
            {queue.map((p) => {
              const initials = initialsById.get(p.student_id) ?? "??";
              const period = periodLabelByStudent(p.student_id as OpaqueId);
              return (
                <tr key={p.data_point_id}>
                  <td>
                    <Avatar initials={initials} small />
                  </td>
                  <td>{goalTextById.get(p.goal_id) ?? "(goal)"}</td>
                  <td>{period ?? "—"}</td>
                  <td>
                    <b>{pointValueLabel(p)}</b>
                  </td>
                  <td>{p.admin_date}</td>
                  <td>{SETTING_LABEL[p.setting]}</td>
                  <td>JT (para)</td>
                  <td>
                    {p.denominator_mismatch ? (
                      <span className="mismatch" title="off-basis (total ≠ assigned probe)">
                        ⚠ total {p.denominator_used} vs {p.denominator_original}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="valcell">
                    <button
                      type="button"
                      className="btn small primary"
                      aria-label={`confirm ${initials}`}
                      onClick={() => onConfirm(p)}
                    >
                      Confirm
                    </button>{" "}
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`fix ${initials}`}
                      onClick={() => onFix(p)}
                    >
                      Fix
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="note">
          Note — Each point itemized, values visible, individually correctable — no collapsed
          "confirm all". A mismatch stays in the audit, excluded from the consistency window until
          resolved.
        </div>
      </div>
    </div>
  );
}
