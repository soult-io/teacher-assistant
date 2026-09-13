// Weekly Dashboard (U1 slice) — proves the wiring end to end: it reads the
// decrypted records and renders the M3 `buildWeeklyDashboard` projection LIVE
// (the three-state header + an owes-first list). The full three-lens dashboard,
// score-later bookmarks, and pending-para notes are U2; this slice renders the
// header and rows so a passkey login demonstrably lights up live projections.
//
// No domain logic here: the header string and the row states come from the
// engine; this only maps ids → the student's avatar + goal title and paints.

import { compareCodePoints } from "@teacher-assistant/domain-core";
import type { IEPGoal, ProgressDataPoint, Student } from "@teacher-assistant/schema";
import {
  buildWeeklyDashboard,
  type DashboardRow,
  type DashboardState,
  renderHeader,
} from "@teacher-assistant/store";
import { Avatar } from "../../design/Avatar.js";
import { chipForDashboardState } from "../../design/glyphs.js";
import { StatusChip } from "../../design/StatusChip.js";
import type { DecryptedRecords } from "../../data/repository.js";

// Owes first, then documented-no-data, then scored (design §E.4 owes-first lens).
const STATE_ORDER: Readonly<Record<DashboardState, number>> = {
  owes: 0,
  documented_no_data: 1,
  has_point: 2,
};

const STATE_LABEL: Readonly<Record<DashboardState, string>> = {
  owes: "owes",
  documented_no_data: "no data",
  has_point: "scored",
};

function rightText(row: DashboardRow, value: number | undefined): string {
  if (row.state === "has_point") {
    return value !== undefined ? `${Math.round(value * 100)}%` : "scored";
  }
  if (row.state === "documented_no_data") {
    return row.noDataReason ?? "excused";
  }
  return "owes";
}

interface RowViewModel {
  readonly row: DashboardRow;
  readonly initials: string;
  readonly goalText: string;
  readonly value: number | undefined;
}

function GoalRow({ vm }: { vm: RowViewModel }) {
  const chip = chipForDashboardState(vm.row.state);
  const isOwes = vm.row.state === "owes";
  return (
    <div className={`row${isOwes ? " owes" : ""}`}>
      <StatusChip chip={chip} label={STATE_LABEL[vm.row.state]} />
      <Avatar initials={vm.initials} />
      <div className="rowmain">
        {/* §E.1: the avatar already carries the initials, so the row meta does
            not repeat them. The period tag lands here in U2 (the M3 projection
            surfaces periodId; U1's synthetic seed has no period entities yet). */}
        <span className="rowtitle">{vm.goalText}</span>
      </div>
      <div className="rowright">
        <span className={`rowval${isOwes ? " dim" : ""}`}>{rightText(vm.row, vm.value)}</span>
      </div>
    </div>
  );
}

function initialsOf(students: readonly Student[]): Map<string, string> {
  return new Map(students.map((s) => [s.student_id, s.initials]));
}

function goalTextOf(goals: readonly IEPGoal[]): Map<string, string> {
  return new Map(goals.map((g) => [g.goal_id, g.goal_text]));
}

/** Latest scored value this dashboard cares about, per goal (for the row's right-hand %). */
function scoredValueOf(points: readonly ProgressDataPoint[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of points) {
    if (p.state === "scored" && p.computed_value !== undefined) {
      out.set(p.goal_id, p.computed_value);
    }
  }
  return out;
}

export function DashboardScreen({
  records,
  now,
}: {
  readonly records: DecryptedRecords;
  readonly now: Date;
}) {
  const dashboard = buildWeeklyDashboard({
    goals: records.goals,
    points: records.points,
    asOf: now,
    isNonInstructional: () => false, // U1 synthetic: every week is instructional
  });

  const byStudent = initialsOf(records.students);
  const byGoal = goalTextOf(records.goals);
  const values = scoredValueOf(records.points);

  const rows: RowViewModel[] = dashboard.rows
    .map((row) => ({
      row,
      initials: byStudent.get(row.studentId) ?? "??",
      goalText: byGoal.get(row.goalId) ?? "(goal)",
      value: values.get(row.goalId),
    }))
    .sort(
      (a, b) =>
        STATE_ORDER[a.row.state] - STATE_ORDER[b.row.state] ||
        compareCodePoints(a.initials, b.initials),
    );

  const h = dashboard.header;
  return (
    <div>
      <div className="headline">
        <div className="weeknav">
          <span className="wk">This week</span>
        </div>
        <div className="three">
          <div className="stat scored">
            <b>{h.scored}</b>
            <span>scored</span>
          </div>
          <div className="stat excused">
            <b>{h.excused}</b>
            <span>excused</span>
          </div>
          <div className="stat owe">
            <b>{h.owe}</b>
            <span>owe</span>
          </div>
        </div>
        <p className="sub" data-testid="header-line">
          {renderHeader(h)}
        </p>
      </div>

      <div className="grouplabel owes">
        <span>This week</span>
        <span className="ln" />
      </div>
      {rows.map((vm) => (
        <GoalRow key={vm.row.goalId} vm={vm} />
      ))}
    </div>
  );
}
