// Weekly Dashboard (U2 + U3 writes) — the 3-lens owes-first list over the M3
// store projections. U3 adds the write surfaces: tapping an owes row opens the
// Quick-Score sheet; tapping a scored row opens it for an audited [Fix]; the ⚑
// flag now WRITES a score-later bookmark (M5 queued point) — its "on" state is
// the presence of that queued point; a "To-score (N)" button opens the queue.
//
// Grouping + within-group ordering come from the store; the app-local
// dashboard-vm only resolves display + orders groups (see dashboard-vm.ts).

import { asTimestamp, type OpaqueId, type ProgressDataPoint } from "@teacher-assistant/schema";
import {
  buildToScoreQueue,
  buildWeeklyDashboard,
  type DashboardLens,
  groupDashboard,
  nextLens,
  renderHeader,
} from "@teacher-assistant/store";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import { isNonInstructionalWeek } from "../../data/calendar.js";
import { isoDateOf } from "../../data/date.js";
import type { DecryptedRecords } from "../../data/repository.js";
import type { DocMutator } from "../../data/session.js";
import { bookmarkMutator, DEFAULT_SETTING, unbookmarkMutator } from "../../data/writes.js";
import { type SheetTarget, targetForRow } from "../sheet-target.js";
import { GoalRow } from "./dashboard/GoalRow.js";
import {
  buildStudentCards,
  type Lookups,
  orderPeriodGroups,
  orderRowsByStudent,
  periodLabelOfGroup,
  type RowVM,
  toRowVM,
} from "./dashboard/dashboard-vm.js";
import { StudentCard } from "./dashboard/StudentCard.js";

const SETTING = DEFAULT_SETTING;

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
  readonly lk: Lookups;
  readonly now: Date;
  readonly onNewGoal: () => void;
  readonly onToScore: () => void;
  readonly onOpenScore: (target: SheetTarget) => void;
  /** Open Goal Detail for a goal (trend + history) — reachable from every row. */
  readonly onOpenDetail: (goalId: OpaqueId) => void;
  readonly apply: (mutator: DocMutator) => Promise<void>;
}

export function DashboardScreen(props: DashboardScreenProps) {
  const { records, lk, now, onNewGoal, onToScore, onOpenScore, onOpenDetail, apply } = props;
  const [lens, setLens] = useState<DashboardLens>("owes_first");
  const today = isoDateOf(now);

  const dashboard = useMemo(
    () =>
      buildWeeklyDashboard({
        goals: records.goals,
        points: records.points,
        asOf: now,
        // Single-sourced calendar (data/calendar.ts) — the same predicate the R3-3
        // gate uses, so owes math and the auto-statement agree on what a week is.
        isNonInstructional: isNonInstructionalWeek,
        periodByStudent: lk.periodByStudent,
      }),
    [records, now, lk],
  );

  // Score-later state is now the DATA (M5 queued points), not local UI state.
  const queue = buildToScoreQueue(records.points);
  const queuedGoalIds = new Set(queue.map((e) => e.goalId));
  const queuedPointByGoal = new Map(
    records.points.filter((p) => p.state === "queued").map((p) => [p.goal_id, p]),
  );
  const scoredPointByGoal = new Map(
    records.points.filter((p) => p.state === "scored").map((p) => [p.goal_id, p]),
  );
  const pendingCount = dashboard.rows.filter((r) => lk.pendingGoalIds.has(r.goalId)).length;
  const groups = groupDashboard(dashboard.rows, lens);

  const toggleLater = useCallback(
    (vm: RowVM) => {
      const queued = queuedPointByGoal.get(vm.goalId);
      void (queued !== undefined
        ? apply(unbookmarkMutator(queued.data_point_id))
        : apply(
            bookmarkMutator({
              goalId: vm.goalId,
              studentId: vm.studentId,
              adminDate: today,
              entryTs: asTimestamp(Date.now()),
              setting: SETTING,
            }),
          ));
    },
    [apply, queuedPointByGoal, today],
  );

  const openScore = useCallback(
    (vm: RowVM) => {
      // Resolve any existing point for this goal/week: a scored row opens for a
      // [Fix]; an owes row that already has a ⚑ queued placeholder opens THAT
      // placeholder (so scoring completes it in place — never a duplicate point).
      const existing: ProgressDataPoint | undefined =
        vm.state === "has_point"
          ? scoredPointByGoal.get(vm.goalId)
          : queuedPointByGoal.get(vm.goalId);
      if (existing !== undefined) {
        onOpenScore({
          ...targetForRow(vm, lk, today),
          existingPoint: existing,
          adminDate: existing.admin_date,
        });
        return;
      }
      if (vm.state === "owes") {
        onOpenScore(targetForRow(vm, lk, today));
      }
    },
    [onOpenScore, lk, today, scoredPointByGoal, queuedPointByGoal],
  );

  const openDetail = useCallback((vm: RowVM) => onOpenDetail(vm.goalId), [onOpenDetail]);

  const renderRow = (vm: RowVM): ReactElement => (
    <GoalRow
      key={vm.goalId}
      vm={vm}
      scoreLater={queuedGoalIds.has(vm.goalId)}
      onScoreLater={toggleLater}
      onOpenScore={openScore}
      onOpenDetail={openDetail}
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
            <StudentCard
              key={card.studentId}
              card={card}
              queuedGoalIds={queuedGoalIds}
              onScoreLater={toggleLater}
              onOpenScore={openScore}
              onOpenDetail={openDetail}
            />
          ))
        ) : lens === "by_period" ? (
          orderPeriodGroups(groups, lk).map((group) => (
            <div key={group.key}>
              <SectionLabel text={`Period ${periodLabelOfGroup(group, lk)}`} />
              {orderRowsByStudent(group.rows.map((row) => toRowVM(row, lk))).map(renderRow)}
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
        <button type="button" className="btn wide" onClick={onToScore} data-testid="to-score">
          To-score ({queue.length})
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
  // Within each section a student's goals stay adjacent + alphabetized (§E.4).
  const owes = orderRowsByStudent(rows.filter((r) => r.state === "owes"));
  const done = orderRowsByStudent(rows.filter((r) => r.state !== "owes"));
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
