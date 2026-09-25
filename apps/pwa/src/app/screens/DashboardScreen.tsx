// Weekly Dashboard (U2 + U3 writes; U7 desktop master-detail) — the 3-lens
// owes-first list over the M3 store projections.
//
// MOBILE (<900px): the validated single column — tapping an owes row opens the
// Quick-Score sheet; tapping a scored row opens it for an audited [Fix]; the ⚑ flag
// WRITES a score-later bookmark; a "To-score (N)" button opens the queue.
//
// DESKTOP (>=900px): MASTER-DETAIL (design §3.1). The owes-first list (master) sits
// left; clicking a row SELECTS it into the right pane, which renders that goal's full
// Goal Detail (trend + draft statement + consistency + quarterly + ARC). The first
// owed goal auto-selects so the pane is never empty. Pending para points render as a
// full-width table strip above the master-detail; the by-student lens becomes a
// full-width card grid (no pane). Same render functions throughout — only the host
// containers are re-laid-out (the mobile path is unchanged).

import { asTimestamp, type OpaqueId, type ProgressDataPoint } from "@teacher-assistant/schema";
import {
  buildToScoreQueue,
  buildWeeklyDashboard,
  type DashboardLens,
  groupDashboard,
  nextLens,
  renderHeader,
} from "@teacher-assistant/store";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
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
  oldestFirst,
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

type DashboardHeader = Parameters<typeof renderHeader>[0];
type DashboardGroups = ReturnType<typeof groupDashboard>;

function SectionLabel({ text, owes = false }: { readonly text: string; readonly owes?: boolean }) {
  return (
    <div className={`grouplabel${owes ? " owes" : ""}`}>
      <span>{text}</span>
      <span className="ln" />
    </div>
  );
}

/** The three-state honesty header. The pending-note button is mobile-only (desktop uses the strip). */
function Headline({
  header,
  pendingCount,
  onValidate,
  showPendButton,
}: {
  readonly header: DashboardHeader;
  readonly pendingCount: number;
  readonly onValidate: () => void;
  readonly showPendButton: boolean;
}) {
  return (
    <div className="headline">
      <div className="weeknav">
        <span className="wk">This week</span>
      </div>
      <div className="three">
        <div className="stat scored">
          <b data-testid="monitoring-complete">{header.scored}</b>
          <span>scored</span>
        </div>
        <div className="stat excused">
          <b>{header.excused}</b>
          <span>excused</span>
        </div>
        <div className="stat owe">
          <b data-testid="owe-count">{header.owe}</b>
          <span>owe</span>
        </div>
      </div>
      <p className="sub" data-testid="header-line">
        {renderHeader(header)}
      </p>
      {showPendButton && pendingCount > 0 ? (
        <button
          type="button"
          className="pendnote pendbtn"
          data-testid="validate-note"
          onClick={onValidate}
        >
          ⏳ {pendingCount} para point{pendingCount > 1 ? "s" : ""} awaiting your OK
        </button>
      ) : null}
    </div>
  );
}

function GroupToggle({
  lens,
  onCycle,
}: {
  readonly lens: DashboardLens;
  readonly onCycle: () => void;
}) {
  return (
    <button type="button" className="btn small ghost" onClick={onCycle} data-testid="group-toggle">
      Group: {LENS_LABEL[lens]}
    </button>
  );
}

interface CardHandlers {
  readonly queuedGoalIds: ReadonlySet<string>;
  readonly onScoreLater: (vm: RowVM) => void;
  readonly onOpenScore: (vm: RowVM) => void;
  readonly onOpenDetail: (vm: RowVM) => void;
}

/** The grouped body for a lens. `renderRow` differs per layout (mobile scores; desktop selects). */
function DashboardBody({
  lens,
  groups,
  lk,
  renderRow,
  cards,
}: {
  readonly lens: DashboardLens;
  readonly groups: DashboardGroups;
  readonly lk: Lookups;
  readonly renderRow: (vm: RowVM) => ReactElement;
  readonly cards: CardHandlers;
}) {
  if (lens === "by_student") {
    return (
      <>
        {buildStudentCards(groups, lk).map((card) => (
          <StudentCard
            key={card.studentId}
            card={card}
            queuedGoalIds={cards.queuedGoalIds}
            onScoreLater={cards.onScoreLater}
            onOpenScore={cards.onOpenScore}
            onOpenDetail={cards.onOpenDetail}
          />
        ))}
      </>
    );
  }
  if (lens === "by_period") {
    return (
      <>
        {orderPeriodGroups(groups, lk).map((group) => (
          <div key={group.key}>
            <SectionLabel text={`Period ${periodLabelOfGroup(group, lk)}`} />
            {orderRowsByStudent(group.rows.map((row) => toRowVM(row, lk))).map(renderRow)}
          </div>
        ))}
      </>
    );
  }
  return (
    <OwesFirst
      rows={(groups[0]?.rows ?? []).map((row) => toRowVM(row, lk))}
      renderRow={renderRow}
    />
  );
}

export interface DashboardScreenProps {
  readonly records: DecryptedRecords;
  readonly lk: Lookups;
  readonly now: Date;
  readonly onNewGoal: () => void;
  readonly onToScore: () => void;
  /** Open the segregated Baseline / proposed-goal track (U5). */
  readonly onBaseline: () => void;
  /** Open the teacher para-validation queue (U6). */
  readonly onValidate: () => void;
  /** Count of para pending points awaiting validation — from the para doc (D3), not master. */
  readonly paraPendingCount: number;
  readonly onOpenScore: (target: SheetTarget) => void;
  /** Open Goal Detail for a goal (trend + history) — reachable from every row. */
  readonly onOpenDetail: (goalId: OpaqueId) => void;
  readonly apply: (mutator: DocMutator) => Promise<void>;
  /** Desktop master-detail (design §3.1). Absent/false → the validated mobile layout. */
  readonly isDesktop?: boolean;
  /** Desktop only: render the selected goal's full Goal Detail into the right pane. */
  readonly renderDetailPane?: (goalId: OpaqueId) => ReactNode;
  /** Desktop only: the full-width para-validation table strip, above the master-detail. */
  readonly validationStrip?: ReactNode;
}

export function DashboardScreen(props: DashboardScreenProps) {
  const {
    records,
    lk,
    now,
    onNewGoal,
    onToScore,
    onBaseline,
    onValidate,
    paraPendingCount,
    onOpenScore,
    onOpenDetail,
    apply,
    isDesktop = false,
    renderDetailPane,
    validationStrip,
  } = props;
  const [lens, setLens] = useState<DashboardLens>("owes_first");
  const [selectedGoalId, setSelectedGoalId] = useState<OpaqueId | null>(null);
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
  // Newest point per goal wins, whatever the record order (TEACH-25).
  const byAge = oldestFirst(records.points);
  const queuedPointByGoal = new Map(
    byAge.filter((p) => p.state === "queued").map((p) => [p.goal_id, p]),
  );
  const scoredPointByGoal = new Map(
    byAge.filter((p) => p.state === "scored").map((p) => [p.goal_id, p]),
  );
  const pendingCount = paraPendingCount;
  const groups = groupDashboard(dashboard.rows, lens);

  // Desktop pane default (design Q1): the first owed goal, else the first row, so the
  // pane is never empty. Derived from the owes-first ordering the list itself uses.
  const firstPick = useMemo(() => {
    const owesFirst = groupDashboard(dashboard.rows, "owes_first")[0]?.rows ?? [];
    const ordered = orderRowsByStudent(owesFirst.map((row) => toRowVM(row, lk)));
    const pick = ordered.find((vm) => vm.state === "owes") ?? ordered[0];
    return pick?.goalId ?? null;
  }, [dashboard.rows, lk]);

  const paneActive = isDesktop && renderDetailPane !== undefined;
  const selectedValid =
    selectedGoalId !== null && dashboard.rows.some((r) => r.goalId === selectedGoalId);
  useEffect(() => {
    if (paneActive && !selectedValid && firstPick !== null) {
      setSelectedGoalId(firstPick);
    }
  }, [paneActive, selectedValid, firstPick]);

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

  const cards: CardHandlers = {
    queuedGoalIds,
    onScoreLater: toggleLater,
    onOpenScore: openScore,
    onOpenDetail: openDetail,
  };

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

  // Desktop rows select into the pane instead of scoring (design §4).
  const renderSelectableRow = (vm: RowVM): ReactElement => (
    <GoalRow
      key={vm.goalId}
      vm={vm}
      scoreLater={queuedGoalIds.has(vm.goalId)}
      onScoreLater={toggleLater}
      onOpenScore={openScore}
      onOpenDetail={openDetail}
      onSelect={(picked) => setSelectedGoalId(picked.goalId)}
      selected={vm.goalId === selectedGoalId}
    />
  );

  const header = dashboard.header;

  if (paneActive) {
    return (
      <div>
        <Headline
          header={header}
          pendingCount={pendingCount}
          onValidate={onValidate}
          showPendButton={false}
        />
        {validationStrip}
        {lens === "by_student" ? (
          <>
            <div className="listtoolbar">
              <GroupToggle lens={lens} onCycle={() => setLens(nextLens(lens))} />
            </div>
            <div className="scardgrid" data-testid="dashboard-body">
              <DashboardBody
                lens={lens}
                groups={groups}
                lk={lk}
                renderRow={renderRow}
                cards={cards}
              />
            </div>
          </>
        ) : (
          <div className="md">
            <div className="mdlist">
              <div className="listtoolbar">
                <GroupToggle lens={lens} onCycle={() => setLens(nextLens(lens))} />
              </div>
              <div data-testid="dashboard-body">
                <DashboardBody
                  lens={lens}
                  groups={groups}
                  lk={lk}
                  renderRow={renderSelectableRow}
                  cards={cards}
                />
              </div>
            </div>
            <div className="mddetail" data-testid="detail-pane">
              {selectedGoalId !== null && renderDetailPane !== undefined
                ? renderDetailPane(selectedGoalId)
                : null}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Mobile — the validated layout (unchanged).
  return (
    <div>
      <Headline
        header={header}
        pendingCount={pendingCount}
        onValidate={onValidate}
        showPendButton
      />

      <div className="grouptoggle">
        <GroupToggle lens={lens} onCycle={() => setLens(nextLens(lens))} />
      </div>

      <div data-testid="dashboard-body">
        <DashboardBody lens={lens} groups={groups} lk={lk} renderRow={renderRow} cards={cards} />
      </div>

      <div className="btnrow" style={{ marginTop: "0.9rem" }}>
        <button
          type="button"
          className="btn primary wide"
          onClick={onNewGoal}
          data-testid="new-goal-cta"
        >
          + New goal
        </button>
        <button type="button" className="btn wide" onClick={onToScore} data-testid="to-score">
          To-score ({queue.length})
        </button>
      </div>
      <div className="btnrow" style={{ marginTop: "0.4rem" }}>
        <button
          type="button"
          className="btn wide ghost"
          onClick={onBaseline}
          data-testid="baseline-track"
        >
          Baseline / proposed goals
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
