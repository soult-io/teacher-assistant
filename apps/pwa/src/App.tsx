// App root — the unlock state machine (locked → unlocking → ready) plus, once
// ready, the two-session device: a TEACHER session (master records + the two-doc
// para publish/validate surface) and a PARA session (the Period-DEK para doc only,
// unlocked with a ParaKeyring). The role toggle renders the ACTUAL para session — not
// a filter over the teacher's records — so the confidentiality boundary is the key,
// not the UI (architecture/para-doc-topology.md).

import { type BaselineMethod, editArcDate } from "@teacher-assistant/domain-core";
import {
  type BaselinePoint,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type OpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, type Tab } from "./app/AppShell.js";
import { LockScreen } from "./app/LockScreen.js";
import { QuickScoreSheet, type ParaFixEdit } from "./app/QuickScoreSheet.js";
import { BaselineScreen } from "./app/screens/baseline/BaselineScreen.js";
import { DashboardScreen } from "./app/screens/DashboardScreen.js";
import { GoalDetailScreen } from "./app/screens/goal-detail/GoalDetailScreen.js";
import {
  assembleGoal,
  makeStudent,
  type NewGoalForm,
  nowTs,
} from "./app/screens/new-goal/assemble.js";
import { NewGoalScreen } from "./app/screens/new-goal/NewGoalScreen.js";
import { ParaScreen } from "./app/screens/para/ParaScreen.js";
import { ValidationQueueScreen } from "./app/screens/para/ValidationQueueScreen.js";
import { StubScreen } from "./app/screens/StubScreen.js";
import { ToScoreScreen } from "./app/screens/ToScoreScreen.js";
import { buildLookups } from "./app/screens/dashboard/dashboard-vm.js";
import { type SheetTarget, targetForGoal, targetForQueued } from "./app/sheet-target.js";
import { useOnline } from "./app/useOnline.js";
import { useSessionRecords } from "./app/useSessionRecords.js";
import { useTheme, type ThemeControl } from "./app/useTheme.js";
import { isNonInstructionalWeek } from "./data/calendar.js";
import { isoDateOf } from "./data/date.js";
import type { ParaDocRecords } from "./data/repository.js";
import { hueClassForInitials } from "./design/hues.js";
import {
  type BootstrapOptions,
  bootstrapParaSession,
  bootstrapTeacherSession,
  type DocMutator,
  type ParaHandoff,
  type ParaSession,
  type Role,
  type Session,
} from "./data/session.js";
import {
  acknowledgeMasteryMutator,
  addBaselinePointMutator,
  adoptGoalMutator,
  createGoalMutator,
  upsertGoalMutator,
} from "./data/writes.js";

type Phase = "locked" | "unlocking" | "ready";
type TrackView = "dashboard" | "toscore" | "new_goal" | "goal_detail" | "baseline" | "validation";

interface Sessions {
  readonly teacher: Session;
  readonly para: ParaSession;
}

export interface AppProps {
  /** Injectable teacher bootstrap (tests supply a crypto-free fake); defaults to the real pipeline. */
  readonly bootstrap?: (options: BootstrapOptions) => Promise<Session>;
  /** Injectable para-device bootstrap (from the teacher handoff); defaults to the real ParaKeyring path. */
  readonly bootstrapPara?: (handoff: ParaHandoff) => Promise<ParaSession>;
}

export function App({
  bootstrap = bootstrapTeacherSession,
  bootstrapPara = bootstrapParaSession,
}: AppProps = {}) {
  const theme = useTheme();
  const online = useOnline();
  const [phase, setPhase] = useState<Phase>("locked");
  const [sessions, setSessions] = useState<Sessions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nowRef = useRef<Date>(new Date());

  const unlock = useCallback(() => {
    setError(null);
    setPhase("unlocking");
    bootstrap({ now: nowRef.current })
      .then(async (teacher) => {
        // Enter the para-device session from the handoff (wrapped Period DEK only) —
        // it opens ONLY the para stream and cannot decrypt master.
        const para = await bootstrapPara(teacher.paraHandoff);
        setSessions({ teacher, para });
        setPhase("ready");
        void teacher.sync(); // best-effort reconcile; offline-first, non-blocking
      })
      .catch(() => {
        // Identity-clean: no student data in the message; generic guidance only.
        setPhase("locked");
        setError("Unlock failed. Check your passkey and try again.");
      });
  }, [bootstrap, bootstrapPara]);

  if (phase !== "ready" || sessions === null) {
    return (
      <div className="phone">
        <LockScreen onUnlock={unlock} busy={phase === "unlocking"} error={error} />
      </div>
    );
  }
  return (
    <ReadyApp
      teacher={sessions.teacher}
      para={sessions.para}
      online={online}
      theme={theme}
      now={nowRef.current}
    />
  );
}

function ReadyApp({
  teacher,
  para,
  online,
  theme,
  now,
}: {
  readonly teacher: Session;
  readonly para: ParaSession;
  readonly online: boolean;
  readonly theme: ThemeControl;
  readonly now: Date;
}) {
  const { records, apply, refresh } = useSessionRecords(teacher);
  const [role, setRole] = useState<Role>("teacher");
  const [tab, setTab] = useState<Tab>("track");
  const [trackView, setTrackView] = useState<TrackView>("dashboard");
  const [detailGoalId, setDetailGoalId] = useState<OpaqueId | null>(null);
  const [sheetTarget, setSheetTarget] = useState<SheetTarget | null>(null);
  const [paraFix, setParaFix] = useState<ProgressDataPoint | null>(null);
  const [paraRecords, setParaRecords] = useState<ParaDocRecords>(para.paraRecords);
  const [paraQueue, setParaQueue] = useState<readonly ProgressDataPoint[]>(() =>
    teacher.readParaQueue(),
  );
  // Owes rows still show the ⏳ "awaiting your OK" cue — sourced from the para-doc
  // queue (D3 master-truth), since the para pending no longer live in master.
  const lk = useMemo(
    () => buildLookups(records, new Set(paraQueue.map((p) => p.goal_id))),
    [records, paraQueue],
  );
  const today = isoDateOf(now);

  // Pull any para-device captures into the teacher's para stream (ciphertext) and
  // re-derive the master-truth queue. Runs when the teacher role is (re)shown.
  const refreshParaQueue = useCallback(async () => {
    await teacher.refreshPara();
    setParaQueue(teacher.readParaQueue());
  }, [teacher]);

  useEffect(() => {
    if (role === "teacher") {
      void refreshParaQueue();
    } else {
      // Entering the para role: integrate any teacher republish (a new/adopted goal
      // changes the roster/administer slice) before re-reading the para doc.
      void (async () => {
        await para.refreshRecords();
        setParaRecords(para.readParaRecords());
      })();
    }
  }, [role, para, refreshParaQueue]);

  const onTab = useCallback((next: Tab) => {
    setTrackView("dashboard");
    setTab(next);
  }, []);

  const openDetail = useCallback((goalId: OpaqueId) => {
    setDetailGoalId(goalId);
    setTrackView("goal_detail");
  }, []);

  // U5 create: resolve the student by initials (existing, else a new roster entry),
  // assemble the goal + probe (engine gate ran in the form), persist, then land on
  // the dashboard (adopt → active) or the baseline track (draft → proposed).
  const submitNewGoal = useCallback(
    (form: NewGoalForm) => {
      const initials = form.initials.trim().toUpperCase();
      const existing = records.students.find((s) => s.initials.toUpperCase() === initials);
      const student =
        existing ?? makeStudent(initials, `--s-${hueClassForInitials(initials)}` as const);
      const assembled = assembleGoal(
        form,
        student.student_id,
        nowTs(),
        existing ? undefined : student,
      );
      void apply(createGoalMutator(assembled.goal, assembled.probe, assembled.student));
      setTrackView(form.path === "adopt" ? "dashboard" : "baseline");
    },
    [apply, records.students],
  );

  // U5 baseline track handlers (M7). Baseline points share the goal's assigned probe
  // id as their comparable condition; adoption + arc-date edits go through the engine.
  const addBaselinePoint = useCallback(
    (goal: IEPGoal, numerator: number, denominator: number) => {
      const point: BaselinePoint = {
        baseline_point_id: newOpaqueId(),
        goal_id: goal.goal_id,
        student_id: goal.student_id,
        admin_date: today,
        entry_ts: nowTs(),
        numerator,
        denominator_used: denominator,
        computed_value: numerator / denominator,
        probe_condition_id: goal.probe_definition_id ?? goal.goal_id,
        scorer: "teacher",
      };
      void apply(addBaselinePointMutator(point));
    },
    [apply, today],
  );

  const adopt = useCallback(
    (goal: IEPGoal, points: readonly BaselinePoint[], method: BaselineMethod) => {
      void apply(adoptGoalMutator(goal, points, { who: "teacher", when: nowTs(), method }));
      setTrackView("dashboard");
    },
    [apply],
  );

  const editArc = useCallback(
    (goal: IEPGoal, newArcDate: string) => {
      const result = editArcDate(goal, newArcDate as IsoDate, isNonInstructionalWeek);
      void apply(upsertGoalMutator(result.goal));
      return result.alert;
    },
    [apply],
  );

  // U6 teacher validation (M13, C-4): the session promotes the pending point → the
  // master record FIRST, then tombstones the para doc; the queue re-derives.
  const confirmPara = useCallback(
    async (pending: ProgressDataPoint) => {
      await teacher.validatePara(pending, nowTs());
      refresh();
      await refreshParaQueue();
    },
    [teacher, refresh, refreshParaQueue],
  );
  // [Fix]: open the teacher Quick-Score sheet prefilled from the pending values; Save
  // there routes through validateParaWithEdit (correct + validate in one action).
  const fixPara = useCallback(
    (pending: ProgressDataPoint) => {
      const goal = records.goals.find((g) => g.goal_id === pending.goal_id);
      if (goal !== undefined) {
        setParaFix(pending);
        setSheetTarget(targetForGoal(goal, lk, today, pending));
      }
    },
    [records.goals, lk, today],
  );
  const commitParaFix = useCallback(
    async (edit: ParaFixEdit) => {
      if (paraFix === null) {
        return;
      }
      await teacher.validateParaWithEdit(
        paraFix,
        { numerator: edit.numerator, denominator_used: edit.denominatorUsed },
        nowTs(),
      );
      setSheetTarget(null);
      setParaFix(null);
      refresh();
      await refreshParaQueue();
    },
    [teacher, paraFix, refresh, refreshParaQueue],
  );

  const commit = useCallback(
    async (mutator: Parameters<typeof apply>[0]) => {
      await apply(mutator);
      setSheetTarget(null);
    },
    [apply],
  );

  const capturePara = useCallback(
    async (mutator: DocMutator) => {
      await para.capturePara(mutator);
      setParaRecords(para.readParaRecords());
    },
    [para],
  );

  const closeSheet = useCallback(() => {
    setSheetTarget(null);
    setParaFix(null);
  }, []);

  // Period label for one student (baseline track needs it per-row); hoisted out of
  // the track cascade so each branch below is a flat return with no nested ternary.
  const periodLabelByStudent = useCallback(
    (sid: OpaqueId): string | null => {
      const pid = lk.periodByStudent(sid);
      return pid !== null ? (lk.periodLabelById.get(pid) ?? null) : null;
    },
    [lk],
  );

  const detailGoal =
    detailGoalId !== null ? records.goals.find((g) => g.goal_id === detailGoalId) : undefined;
  const detailPeriodLabel =
    detailGoal !== undefined ? periodLabelByStudent(detailGoal.student_id) : null;

  const track = (() => {
    if (trackView === "new_goal") {
      return <NewGoalScreen onSubmit={submitNewGoal} onBack={() => setTrackView("dashboard")} />;
    }
    if (trackView === "baseline") {
      return (
        <BaselineScreen
          records={records}
          initialsById={lk.initialsById}
          periodLabelByStudent={periodLabelByStudent}
          isNonInstructional={isNonInstructionalWeek}
          onBack={() => setTrackView("dashboard")}
          onNewGoal={() => setTrackView("new_goal")}
          onAddBaselinePoint={addBaselinePoint}
          onAdopt={adopt}
          onEditArcDate={editArc}
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
    if (trackView === "validation") {
      return (
        <ValidationQueueScreen
          queue={paraQueue}
          initialsById={lk.initialsById}
          goalTextById={lk.goalTextById}
          onConfirm={confirmPara}
          onFix={fixPara}
          onBack={() => setTrackView("dashboard")}
        />
      );
    }
    if (trackView === "goal_detail" && detailGoal !== undefined) {
      return (
        <GoalDetailScreen
          goal={detailGoal}
          points={records.points}
          observations={records.observations}
          initials={lk.initialsById.get(detailGoal.student_id) ?? "??"}
          periodLabel={detailPeriodLabel}
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
        onBaseline={() => setTrackView("baseline")}
        onValidate={() => setTrackView("validation")}
        paraPendingCount={paraQueue.length}
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
        onClose={closeSheet}
        {...(paraFix !== null ? { onValidateEdit: commitParaFix } : {})}
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
        <ParaScreen paraRecords={paraRecords} now={now} capturePara={capturePara} />
      ) : tab === "track" ? (
        track
      ) : (
        <StubScreen title="Plan" note="Planner lands in Phase 2" />
      )}
    </AppShell>
  );
}
