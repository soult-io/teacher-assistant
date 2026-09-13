// Weekly Dashboard (U2) — the full owes-first list over the M3 store
// projections, with the three grouping lenses (owes-first → by-period →
// by-student), status chips, the pending-para note, and the score-later flag.
//
// Grouping + within-group ordering come from @teacher-assistant/store
// (buildWeeklyDashboard / groupDashboard / nextLens) — there is no app-local
// ordering table. Score-later is local UI state in U2 (it marks the row); the
// To-Score queue + editable entry it opens are U3. "+ New goal" routes to a stub
// (the New-Goal flow is U5).

import { type ReactElement, useCallback, useMemo, useState } from "react";
import {
  buildWeeklyDashboard,
  type DashboardLens,
  groupDashboard,
  nextLens,
  renderHeader,
} from "@teacher-assistant/store";
import type { DecryptedRecords } from "../../data/repository.js";
import { GoalRow } from "./dashboard/GoalRow.js";
import { StudentCard } from "./dashboard/StudentCard.js";
import {
  buildLookups,
  buildStudentCards,
  orderPeriodGroups,
  periodLabelOfGroup,
  type RowVM,
  toRowVM,
} from "./dashboard/dashboard-vm.js";

const LENS_LABEL: Readonly<Record<DashboardLens, string>> = {
  owes_first: "owes-first",
  by_period: "by period",
  by_student: "by student",
};

function SectionLabel({ text, owes = false }: { readonly text: string; readonly owes?: boolean }) {
  return (
    <div className={`grouplabel${owes ? " owes" : ""}`}>
      <span>{text}</span>
      <span className="ln" />
    </div>
  );
}

export interface DashboardScreenProps {
  readonly records: DecryptedRecords;
  readonly now: Date;
  readonly onNewGoal: () => void;
}

export function DashboardScreen({ records, now, onNewGoal }: DashboardScreenProps) {
  const [lens, setLens] = useState<DashboardLens>("owes_first");
  const [scoreLater, setScoreLater] = useState<ReadonlySet<string>>(() => new Set());

  const toggleLater = useCallback((goalId: string) => {
    setScoreLater((prev) => {
      const next = new Set(prev);
      if (next.has(goalId)) {
        next.delete(goalId);
      } else {
        next.add(goalId);
      }
      return next;
    });
  }, []);

  const lk = useMemo(() => buildLookups(records), [records]);
  const dashboard = useMemo(
    () =>
      buildWeeklyDashboard({
        goals: records.goals,
        points: records.points,
        asOf: now,
        isNonInstructional: () => false, // U1/U2 synthetic: every week is instructional
        periodByStudent: lk.periodByStudent,
      }),
    [records, now, lk],
  );

  const pendingCount = dashboard.rows.filter((r) => lk.pendingGoalIds.has(r.goalId)).length;
  const groups = groupDashboard(dashboard.rows, lens);

  const renderRow = (vm: RowVM) => (
    <GoalRow
      key={vm.goalId}
      vm={vm}
      scoreLater={scoreLater.has(vm.goalId)}
      onScoreLater={toggleLater}
    />
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
        {pendingCount > 0 ? (
          <div className="pendnote">
            ⏳ {pendingCount} para point{pendingCount > 1 ? "s" : ""} awaiting your OK
          </div>
        ) : null}
      </div>

      <div className="grouptoggle">
        <button
          type="button"
          className="btn small ghost"
          onClick={() => setLens(nextLens(lens))}
          data-testid="group-toggle"
        >
          Group: {LENS_LABEL[lens]}
        </button>
      </div>

      <div data-testid="dashboard-body">
        {lens === "by_student" ? (
          buildStudentCards(groups, lk).map((card) => (
            <StudentCard key={card.studentId} card={card} />
          ))
        ) : lens === "by_period" ? (
          orderPeriodGroups(groups, lk).map((group) => (
            <div key={group.key}>
              <SectionLabel text={`Period ${periodLabelOfGroup(group, lk)}`} />
              {group.rows.map((row) => renderRow(toRowVM(row, lk)))}
            </div>
          ))
        ) : (
          <OwesFirst
            rows={(groups[0]?.rows ?? []).map((row) => toRowVM(row, lk))}
            renderRow={renderRow}
          />
        )}
      </div>

      <div className="btnrow" style={{ marginTop: "0.9rem" }}>
        <button type="button" className="btn primary wide" onClick={onNewGoal}>
          + New goal
        </button>
      </div>
    </div>
  );
}

/** Owes-first lens: the store's single owes-first group, split into labelled sections. */
function OwesFirst({
  rows,
  renderRow,
}: {
  readonly rows: readonly RowVM[];
  readonly renderRow: (vm: RowVM) => ReactElement;
}) {
  const owes = rows.filter((r) => r.state === "owes");
  const done = rows.filter((r) => r.state !== "owes");
  return (
    <div>
      <SectionLabel text="Owes a point" owes />
      {owes.length > 0 ? owes.map(renderRow) : <div className="note">Nothing owing right now.</div>}
      {done.length > 0 ? (
        <>
          <SectionLabel text="Done this week" />
          {done.map(renderRow)}
        </>
      ) : null}
    </div>
  );
}
