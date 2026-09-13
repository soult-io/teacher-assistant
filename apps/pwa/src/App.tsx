// App root — the unlock state machine (locked → unlocking → ready) plus, once
// ready, the record store + write surfaces. ReadyApp is split out so its
// record/sheet hooks are unconditional (they need a live session).

import { useCallback, useMemo, useRef, useState } from "react";
import type { OpaqueId } from "@teacher-assistant/schema";
import { AppShell, type Tab } from "./app/AppShell.js";
import { LockScreen } from "./app/LockScreen.js";
import { QuickScoreSheet } from "./app/QuickScoreSheet.js";
import { DashboardScreen } from "./app/screens/DashboardScreen.js";
import { GoalDetailScreen } from "./app/screens/goal-detail/GoalDetailScreen.js";
import { StubScreen } from "./app/screens/StubScreen.js";
import { ToScoreScreen } from "./app/screens/ToScoreScreen.js";
import { buildLookups } from "./app/screens/dashboard/dashboard-vm.js";
import { type SheetTarget, targetForGoal, targetForQueued } from "./app/sheet-target.js";
import { useOnline } from "./app/useOnline.js";
import { useSessionRecords } from "./app/useSessionRecords.js";
import { useTheme, type ThemeControl } from "./app/useTheme.js";
import { isNonInstructionalWeek } from "./data/calendar.js";
import { isoDateOf } from "./data/date.js";
import {
  type BootstrapOptions,
  bootstrapTeacherSession,
  type Role,
  type Session,
} from "./data/session.js";
import { acknowledgeMasteryMutator } from "./data/writes.js";

type Phase = "locked" | "unlocking" | "ready";
type TrackView = "dashboard" | "toscore" | "new_goal" | "goal_detail";

export interface AppProps {
  /** Injectable bootstrap (tests supply a crypto-free fake); defaults to the real pipeline. */
  readonly bootstrap?: (options: BootstrapOptions) => Promise<Session>;
}

export function App({ bootstrap = bootstrapTeacherSession }: AppProps = {}) {
  const theme = useTheme();
  const online = useOnline();
  const [phase, setPhase] = useState<Phase>("locked");
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nowRef = useRef<Date>(new Date());

  const unlock = useCallback(() => {
    setError(null);
    setPhase("unlocking");
    bootstrap({ now: nowRef.current })
      .then((s) => {
        setSession(s);
        setPhase("ready");
        void s.sync(); // best-effort reconcile; offline-first, non-blocking
      })
      .catch(() => {
        // Identity-clean: no student data in the message; generic guidance only.
        setPhase("locked");
        setError("Unlock failed. Check your passkey and try again.");
      });
  }, [bootstrap]);

  if (phase !== "ready" || session === null) {
    return (
      <div className="phone">
        <LockScreen onUnlock={unlock} busy={phase === "unlocking"} error={error} />
      </div>
    );
  }
  return <ReadyApp session={session} online={online} theme={theme} now={nowRef.current} />;
}

function ReadyApp({
  session,
  online,
  theme,
  now,
}: {
  readonly session: Session;
  readonly online: boolean;
  readonly theme: ThemeControl;
  readonly now: Date;
}) {
  const { records, apply } = useSessionRecords(session);
  const lk = useMemo(() => buildLookups(records), [records]);
  const [role, setRole] = useState<Role>("teacher");
  const [tab, setTab] = useState<Tab>("track");
  const [trackView, setTrackView] = useState<TrackView>("dashboard");
  const [detailGoalId, setDetailGoalId] = useState<OpaqueId | null>(null);
  const [sheetTarget, setSheetTarget] = useState<SheetTarget | null>(null);
  const today = isoDateOf(now);

  const onTab = useCallback((next: Tab) => {
    setTrackView("dashboard");
    setTab(next);
  }, []);

  const openDetail = useCallback((goalId: OpaqueId) => {
    setDetailGoalId(goalId);
    setTrackView("goal_detail");
  }, []);

  const commit = useCallback(
    async (mutator: Parameters<typeof apply>[0]) => {
      await apply(mutator);
      setSheetTarget(null);
    },
    [apply],
  );

  const detailGoal =
    detailGoalId !== null ? records.goals.find((g) => g.goal_id === detailGoalId) : undefined;

  const track = (() => {
    if (trackView === "new_goal") {
      return (
        <StubScreen
          title="New goal"
          note="New-goal flow lands in U5"
          onBack={() => setTrackView("dashboard")}
        />
      );
    }
    if (trackView === "toscore") {
      return (
        <ToScoreScreen
          records={records}
          lk={lk}
          onOpen={(point) => setSheetTarget(targetForQueued(point, lk))}
          onBack={() => setTrackView("dashboard")}
        />
      );
    }
    if (trackView === "goal_detail" && detailGoal !== undefined) {
      const periodId = lk.periodByStudent(detailGoal.student_id);
      const periodLabel = periodId !== null ? (lk.periodLabelById.get(periodId) ?? null) : null;
      return (
        <GoalDetailScreen
          goal={detailGoal}
          points={records.points}
          observations={records.observations}
          initials={lk.initialsById.get(detailGoal.student_id) ?? "??"}
          periodLabel={periodLabel}
          probeLabel={lk.probeByGoal.get(detailGoal.goal_id)?.label ?? "probe"}
          isNonInstructional={isNonInstructionalWeek}
          onBack={() => setTrackView("dashboard")}
          onAddPoint={() => setSheetTarget(targetForGoal(detailGoal, lk, today))}
          onEditPoint={(point) => setSheetTarget(targetForGoal(detailGoal, lk, today, point))}
          onAckMastery={(candidate) => void apply(acknowledgeMasteryMutator(candidate))}
        />
      );
    }
    return (
      <DashboardScreen
        records={records}
        lk={lk}
        now={now}
        onNewGoal={() => setTrackView("new_goal")}
        onToScore={() => setTrackView("toscore")}
        onOpenScore={setSheetTarget}
        onOpenDetail={openDetail}
        apply={apply}
      />
    );
  })();

  const overlay =
    sheetTarget !== null ? (
      <QuickScoreSheet
        target={sheetTarget}
        onCommit={commit}
        onClose={() => setSheetTarget(null)}
      />
    ) : null;

  return (
    <AppShell
      online={online}
      role={role}
      onRole={setRole}
      theme={theme.choice}
      onThemeCycle={theme.cycle}
      tab={tab}
      onTab={onTab}
      overlay={overlay}
    >
      {role === "para" ? (
        <StubScreen title="Para surface" note="Para view lands in U6" />
      ) : tab === "track" ? (
        track
      ) : (
        <StubScreen title="Plan" note="Planner lands in Phase 2" />
      )}
    </AppShell>
  );
}
