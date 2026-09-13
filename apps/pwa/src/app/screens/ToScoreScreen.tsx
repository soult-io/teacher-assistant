// To-Score queue (U3) — the score-later ⚑ bookmarks land here as queued points
// (buildToScoreQueue). Each row opens the FULL Quick-Score editor (not a reduced
// form), keeping the collected admin date. Scoring from the queue writes via M5
// (an audited queued→scored edit) and clears the flag.

import type { ProgressDataPoint } from "@teacher-assistant/schema";
import { buildToScoreQueue } from "@teacher-assistant/store";
import { Avatar } from "../../design/Avatar.js";
import type { DecryptedRecords } from "../../data/repository.js";
import type { Lookups } from "./dashboard/dashboard-vm.js";

export interface ToScoreScreenProps {
  readonly records: DecryptedRecords;
  readonly lk: Lookups;
  readonly onOpen: (point: ProgressDataPoint) => void;
  readonly onBack: () => void;
}

export function ToScoreScreen({ records, lk, onOpen, onBack }: ToScoreScreenProps) {
  const byId = new Map(records.points.map((p) => [p.data_point_id, p]));
  const queue = buildToScoreQueue(records.points);

  return (
    <div>
      <div className="backrow">
        <button type="button" className="back" onClick={onBack}>
          ‹ Dashboard
        </button>
      </div>
      <h1>To-score</h1>
      <p className="sub">
        Collected, not yet scored — score later at home. Tap a student for the full editor. The date
        shown is when you gave the probe, so the weekly cadence stays honest.
      </p>
      {queue.length === 0 ? (
        <div className="card" data-testid="queue-empty">
          All caught up.
        </div>
      ) : (
        queue.map((entry) => {
          const point = byId.get(entry.dataPointId);
          if (point === undefined) {
            return null;
          }
          const initials = lk.initialsById.get(entry.studentId) ?? "??";
          const goalText = lk.goalTextById.get(entry.goalId) ?? "(goal)";
          // §E.1: the period tag stays on the queue row (the Quick-Score header shows it too).
          const periodId = lk.periodByStudent(entry.studentId);
          const periodLabel = periodId !== null ? (lk.periodLabelById.get(periodId) ?? null) : null;
          return (
            <button
              key={entry.dataPointId}
              type="button"
              className="row tap qrow"
              onClick={() => onOpen(point)}
            >
              <span className="chip queued" aria-hidden="true">
                ◷
              </span>
              <Avatar initials={initials} />
              <div className="rowmain">
                <span className="rowtitle">
                  {goalText} <span className="editpt">full editor ›</span>
                </span>
                <span className="rowmeta">
                  {periodLabel !== null ? <span className="period">{periodLabel}</span> : null}{" "}
                  collected {entry.adminDate} <span className="locked">admin date</span>
                </span>
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}
