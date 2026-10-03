// Weekly Dashboard (U2 + U3 writes; U7 desktop; TEACH-43 desktop cards) — the
// 3-lens owes-first list over the M3 store projections.
//
// MOBILE (<900px): the validated single column — tapping an owes row opens the
// Quick-Score sheet; tapping a scored row opens it for an audited [Fix]; the ⚑ flag
// WRITES a score-later bookmark; a "To-score (N)" button opens the queue.
//
// DESKTOP (>=900px): every lens renders the full-width StudentCard grid (TEACH-43) —
// no graph on the dashboard. Owes-first splits into "Owes a point" / "Done this week"
// card sections, by-period into one card section per period, by-student is the plain
// grid. Goal text opens Quick-Score, ⚑ marks score-later, ↗ opens the full-screen
// Goal Detail. Pending para points render as a full-width table strip above the cards.
//
// The grouping lens is owned by App (kept across Goal Detail and Back, reset on
// unlock); without a `lens` prop the screen keeps its own.

import { asTimestamp, type OpaqueId, type ProgressDataPoint } from "@teacher-assistant/schema";
import {
  buildToScoreQueue,
  buildWeeklyDashboard,
  type DashboardLens,
  groupDashboard,
  nextLens,
  renderHeader,
} from "@teacher-assistant/store";
import { type ReactElement, type ReactNode, useCallback, useMemo, useState } from "react";
import { isNonInstructionalWeek } from "../../data/calendar.js";
import { isoDateOf } from "../../data/date.js";
import type { DecryptedRecords } from "../../data/repository.js";
import type { DocMutator } from "../../data/session.js";
import { bookmarkMutator, DEFAULT_SETTING, unbookmarkMutator } from "../../data/writes.js";
import { type SheetTarget, targetForRow } from "../sheet-target.js";
import { GoalRow } from "./dashboard/GoalRow.js";
import {
  buildStudentCards,
  cardsFromOrderedRows,
  type Lookups,
  orderPeriodGroups,
  oldestFirst,
  orderRowsByStudent,
  periodLabelOfGroup,
  type RowVM,
  type StudentCardVM,
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

/** The mobile grouped body for a lens (desktop renders DesktopCards). */
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
  /** The grouping lens, when the caller owns it (App keeps it across Back). */
  readonly lens?: DashboardLens;
  readonly onLensChange?: (lens: DashboardLens) => void;
  /** Desktop student-card layout (TEACH-43). Absent/false → the validated mobile layout. */
  readonly isDesktop?: boolean;
  /** Desktop only: the full-width para-validation table strip, above the cards. */
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
    validationStrip,
  } = props;
  const [ownLens, setOwnLens] = useState<DashboardLens>("owes_first");
  const lens = props.lens ?? ownLens;
  const setLens = props.onLensChange ?? setOwnLens;
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

  const header = dashboard.header;

  if (isDesktop) {
    return (
      <div>
        <Headline
          header={header}
          pendingCount={pendingCount}
          onValidate={onValidate}
          showPendButton={false}
        />
        {validationStrip}
        <div className="listtoolbar">
          <GroupToggle lens={lens} onCycle={() => setLens(nextLens(lens))} />
        </div>
        <DesktopCards lens={lens} groups={groups} lk={lk} cards={cards} />
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

/** A labelled full-width card grid — one desktop section (TEACH-43). */
function CardSection({
  label,
  owes = false,
  studentCards,
  cards,
  empty,
}: {
  readonly label: string;
  readonly owes?: boolean;
  readonly studentCards: readonly StudentCardVM[];
  readonly cards: CardHandlers;
  readonly empty?: string;
}) {
  return (
    <section className="cardsection">
      <SectionLabel text={label} owes={owes} />
      {studentCards.length > 0 ? (
        <StudentCardGrid studentCards={studentCards} cards={cards} />
      ) : (
        <div className="note">{empty}</div>
      )}
    </section>
  );
}

function StudentCardGrid({
  studentCards,
  cards,
  testId,
}: {
  readonly studentCards: readonly StudentCardVM[];
  readonly cards: CardHandlers;
  readonly testId?: string;
}) {
  return (
    <div className="scardgrid" data-testid={testId}>
      {studentCards.map((card) => (
        <StudentCard
          key={card.studentId}
          card={card}
          queuedGoalIds={cards.queuedGoalIds}
          onScoreLater={cards.onScoreLater}
          onOpenScore={cards.onOpenScore}
          onOpenDetail={cards.onOpenDetail}
        />
      ))}
    </div>
  );
}

/**
 * Desktop body: StudentCards in every lens (TEACH-43). Owes-first puts each student
 * with an owed goal under "Owes a point" (with ALL their goals) and the rest under
 * "Done this week"; by-period gives each period its own section. Rows keep the
 * orderRowsByStudent order and cards follow it — nothing is re-sorted here.
 */
function DesktopCards({
  lens,
  groups,
  lk,
  cards,
}: {
  readonly lens: DashboardLens;
  readonly groups: DashboardGroups;
  readonly lk: Lookups;
  readonly cards: CardHandlers;
}) {
  if (lens === "by_student") {
    return (
      <StudentCardGrid
        studentCards={buildStudentCards(groups, lk)}
        cards={cards}
        testId="dashboard-body"
      />
    );
  }
  if (lens === "by_period") {
    return (
      <div data-testid="dashboard-body">
        {orderPeriodGroups(groups, lk).map((group) => (
          <CardSection
            key={group.key}
            label={`Period ${periodLabelOfGroup(group, lk)}`}
            studentCards={cardsFromOrderedRows(
              orderRowsByStudent(group.rows.map((row) => toRowVM(row, lk))),
            )}
            cards={cards}
          />
        ))}
      </div>
    );
  }
  const all = cardsFromOrderedRows(
    orderRowsByStudent((groups[0]?.rows ?? []).map((row) => toRowVM(row, lk))),
  );
  const done = all.filter((card) => card.todo === 0);
  return (
    <div data-testid="dashboard-body">
      <CardSection
        label="Owes a point"
        owes
        studentCards={all.filter((card) => card.todo > 0)}
        cards={cards}
        empty="Nothing owing right now."
      />
      {done.length > 0 ? (
        <CardSection label="Done this week" studentCards={done} cards={cards} />
      ) : null}
    </div>
  );
}
