// App root — the unlock state machine (locked → unlocking → ready) plus, once
// ready, the two-session device: a TEACHER session (master records + the two-doc
// para publish/validate surface) and a PARA session (the Period-DEK para doc only,
// unlocked with a ParaKeyring). The role toggle renders the ACTUAL para session — not
// a filter over the teacher's records — so the confidentiality boundary is the key,
// not the UI (architecture/para-doc-topology.md).

import {
  type BaselineFix,
  type BaselineMethod,
  createBaselinePoint,
  duplicateGoalLabels,
  editArcDate,
  setGoalLabel,
} from "@teacher-assistant/domain-core";
import {
  type BaselinePoint,
  type BaselineRemoveReason,
  type IEPGoal,
  type IsoDate,
  normalizeInitials,
  type OpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { buildToScoreQueue, type DashboardLens } from "@teacher-assistant/store";
import type { VaultTier } from "@teacher-assistant/crypto";
import { SyncError } from "@teacher-assistant/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AppShell, type ShellNav, type Tab } from "./app/AppShell.js";
import { LockScreen } from "./app/LockScreen.js";
import { SetupFlow } from "./app/setup/SetupFlow.js";
import { isSyntheticBuild } from "./build-flags.js";
import type { SetupStageName } from "./device/device-store.js";
import {
  browserDevicePort,
  type DeviceHandle,
  type DevicePort,
  type SetupPort,
} from "./device/device-port.js";
import {
  DeviceCannotUnlockError,
  PassphraseRequiredError,
  UnlockBackoffError,
  WrongPassphraseError,
} from "./device/vault.js";
import {
  AutoLock,
  HIDDEN_DEFAULT_MS,
  IDLE_DEFAULT_MS,
  type LockReason,
  WARN_BEFORE_MS,
} from "./device/auto-lock.js";
import { QuickScoreSheet, type ParaFixEdit } from "./app/QuickScoreSheet.js";
import { BaselineScreen } from "./app/screens/baseline/BaselineScreen.js";
import { DashboardScreen } from "./app/screens/DashboardScreen.js";
import {
  GoalDetailScreen,
  type GoalDetailScreenProps,
} from "./app/screens/goal-detail/GoalDetailScreen.js";
import { ValidationStrip } from "./app/screens/dashboard/ValidationStrip.js";
import { useIsDesktop } from "./app/useIsDesktop.js";
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
import {
  buildLookups,
  orderValidationQueue,
  periodLabelOf,
} from "./app/screens/dashboard/dashboard-vm.js";
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
  fixBaselinePointMutator,
  keepBaselineTotalMutator,
  removeBaselinePointMutator,
  upsertGoalMutator,
} from "./data/writes.js";

type Phase = "loading" | "setup" | "locked" | "unlocking" | "ready";
type TrackView = "dashboard" | "toscore" | "new_goal" | "goal_detail" | "baseline" | "validation";

/** Desktop top-bar titles per Track view (design §2). */
const SCREEN_TITLES: Readonly<Record<TrackView, string>> = {
  dashboard: "Weekly Dashboard",
  toscore: "To-score",
  new_goal: "New goal",
  goal_detail: "Goal Detail",
  baseline: "Baseline / proposed goals",
  validation: "Para points to confirm",
};

/** The desktop sidebar roster context for the Para role (period-scoped, non-PII). */
const PARA_CONTEXT = "3rd period · Math 81 Resource · JT";

interface ShellProps {
  readonly title: string;
  readonly onBack: (() => void) | undefined;
  readonly nav: ShellNav | undefined;
}

/**
 * Derive the desktop shell chrome (top-bar title + back affordance + sidebar Track
 * destinations) from the current role/tab/view. Pure — kept out of ReadyApp so the
 * component stays under the complexity bar. The Track destinations + back exist only
 * in the teacher Track context (the Para role collapses the shell; §2 FERPA).
 */
function buildShellProps(args: {
  readonly role: Role;
  readonly tab: Tab;
  readonly trackView: TrackView;
  readonly toScoreCount: number;
  readonly baselineCount: number;
  readonly go: (view: TrackView) => void;
}): ShellProps {
  const { role, tab, trackView, toScoreCount, baselineCount, go } = args;
  const inTeacherTrack = role === "teacher" && tab === "track";
  const title =
    role === "para" ? "Your students today" : tab === "plan" ? "Plan" : SCREEN_TITLES[trackView];
  const onBack = inTeacherTrack && trackView !== "dashboard" ? () => go("dashboard") : undefined;
  const nav: ShellNav | undefined = inTeacherTrack
    ? {
        toScoreCount,
        baselineCount,
        onToScore: () => go("toscore"),
        onBaseline: () => go("baseline"),
        onNewGoal: () => go("new_goal"),
      }
    : undefined;
  return { title, onBack, nav };
}

interface Sessions {
  readonly teacher: Session;
  /** The in-process para session (QA/synthetic builds only); null on a production build. */
  readonly para: ParaSession | null;
}

export interface AppProps {
  /** Injectable teacher bootstrap (tests supply a crypto-free fake); defaults to the real pipeline. */
  readonly bootstrap?: (options: BootstrapOptions) => Promise<Session>;
  /** Injectable para-device bootstrap (from the teacher handoff); defaults to the real ParaKeyring path. */
  readonly bootstrapPara?: (handoff: ParaHandoff) => Promise<ParaSession>;
  /** The device layer: setup, unlock, session material. Tests supply a crypto-free fake. */
  readonly device?: DevicePort;
  /** QA/synthetic build (defaults to the VITE_TA_SYNTHETIC build flag). */
  readonly synthetic?: boolean;
}

const PASSKEY_RETRY =
  "Try your passkey again. If Bitwarden doesn't pop up, choose Bitwarden in the window that appears.";

/**
 * Copy for a FAILED unlock (flows §4 "Unlock errors"). A relay/sync error (defensive:
 * bootstrap does no blocking relay I/O) gets neutral, non-blaming copy. Identity-clean:
 * never echoes an error's message unless it is the app's own fixed copy.
 */
function unlockErrorMessage(err: unknown): string {
  // Every sync/relay failure is a SyncError (RelayRequestError extends it).
  if (err instanceof SyncError) {
    return "Couldn't reach the sync server. Your local data is unaffected — try again.";
  }
  if (err instanceof UnlockBackoffError) {
    return `Too many tries. Try again in ${Math.ceil(err.retryAfterMs / 1000)} seconds.`;
  }
  if (err instanceof WrongPassphraseError || err instanceof DeviceCannotUnlockError) {
    return err.message;
  }
  if (err instanceof PassphraseRequiredError) {
    return "Type your passphrase, then unlock with your passkey.";
  }
  return PASSKEY_RETRY;
}

/** Where a set-up device's resume opens (flows §2 screen map). */
interface SetupState {
  readonly port: SetupPort;
  readonly resumeAt: SetupStageName | null;
}

export function App({
  bootstrap = bootstrapTeacherSession,
  bootstrapPara = bootstrapParaSession,
  device: injectedDevice,
  synthetic = isSyntheticBuild(),
}: AppProps = {}) {
  const theme = useTheme();
  const online = useOnline();
  const isDesktop = useIsDesktop();
  const [device] = useState<DevicePort>(() => injectedDevice ?? browserDevicePort({ synthetic }));
  const [phase, setPhase] = useState<Phase>("loading");
  const [tier, setTier] = useState<VaultTier>("prf");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [sessions, setSessions] = useState<Sessions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockReason, setLockReason] = useState<LockReason | null>(null);
  const [lockWarning, setLockWarning] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const autoLockRef = useRef<AutoLock | null>(null);
  const nowRef = useRef<Date>(new Date());
  const sessionsRef = useRef<Sessions | null>(null);
  const deviceRef = useRef<DeviceHandle | null>(null);
  const setupRef = useRef<SetupPort | null>(null);

  // Where the device stands on open: no record → first setup; a record → the lock screen.
  useEffect(() => {
    let live = true;
    void device.status().then(
      (status) => {
        if (!live) {
          return;
        }
        if (status.kind === "none") {
          const port = device.setup();
          setupRef.current = port;
          setSetup({ port, resumeAt: null });
          setError(status.cleared ? "Start over with a new setup code." : null);
          setPhase("setup");
          return;
        }
        setTier(status.tier);
        // An unlock already started from the lock screen keeps its own phase.
        setPhase((p) => (p === "loading" ? "locked" : p));
      },
      () => {
        if (live) {
          setPhase((p) => (p === "loading" ? "locked" : p));
          setError(PASSKEY_RETRY);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [device]);

  // Lock (device-enrollment-spec §3.1): destroy BOTH sessions' keys — the para keyring
  // included — then the device's own keys, then drop everything. flushSync commits the
  // lock screen inside the triggering event, so on a resume from a hidden page nothing
  // else renders first (N2).
  const lock = useCallback((reason: LockReason) => {
    const held = sessionsRef.current;
    const heldDevice = deviceRef.current;
    sessionsRef.current = null;
    deviceRef.current = null;
    try {
      held?.teacher.lock();
    } finally {
      try {
        held?.para?.lock();
      } finally {
        try {
          heldDevice?.lock(); // signSk, boxSk, record key: nothing can sign or open a grant
        } finally {
          setupRef.current?.discardRecoveryCode();
          setupRef.current = null;
          flushSync(() => {
            setSessions(null);
            setSetup(null);
            setDeviceOpen(false);
            setPhase("locked");
            setLockReason(reason);
            setLockWarning(false);
          });
        }
      }
    }
  }, []);

  useEffect(() => {
    if (!deviceOpen) {
      return;
    }
    const controller = new AutoLock({
      surface: document,
      onLock: lock,
      onWarn: () => setLockWarning(true),
      onWarnClear: () => setLockWarning(false),
    });
    controller.start();
    autoLockRef.current = controller;
    return () => {
      controller.stop();
      autoLockRef.current = null;
    };
  }, [deviceOpen, lock]);

  // The unlocked, set-up device opens the teacher session (and, on a QA build, the
  // in-process para session). Any failure locks the device again.
  const openSession = useCallback(
    async (handle: DeviceHandle) => {
      let teacher: Session | null = null;
      try {
        const vault = await device.teacherVault(handle);
        teacher = await bootstrap({
          vault,
          persistence: device.persistence,
          inProcessPara: synthetic,
        });
        // Enter the para-device session from the handoff (wrapped Period DEK only) —
        // it opens ONLY the para stream and cannot decrypt master.
        const para = teacher.paraHandoff === null ? null : await bootstrapPara(teacher.paraHandoff);
        // The local encrypted store is open — unlock has SUCCEEDED. The relay reconcile
        // is best-effort and offline-first: fire-and-forget, and swallow even a contract
        // violation so it can NEVER surface as an unlock error or an unhandled rejection.
        sessionsRef.current = { teacher, para };
        setSessions({ teacher, para });
        setLockReason(null);
        setPhase("ready");
        void teacher.sync().catch(() => {});
      } catch (err) {
        teacher?.lock(); // never leave MK and the period keys behind a failed unlock
        handle.lock();
        deviceRef.current = null;
        setDeviceOpen(false);
        setPhase("locked");
        setError(unlockErrorMessage(err));
      }
    },
    [device, bootstrap, bootstrapPara, synthetic],
  );

  const unlock = useCallback(
    (passphrase?: string) => {
      setError(null);
      setPhase("unlocking");
      void (async () => {
        let handle: DeviceHandle;
        try {
          handle = await device.unlock(passphrase);
        } catch (err) {
          setPhase("locked");
          setError(unlockErrorMessage(err));
          return;
        }
        deviceRef.current = handle;
        setDeviceOpen(true);
        const status = await device.status().catch(() => null);
        if (status?.kind === "enrolled" && status.stage !== "done") {
          // An unfinished setup resumes only after this full unlock (A-2, A-8).
          const port = device.setup(handle);
          setupRef.current = port;
          setSetup({ port, resumeAt: status.stage });
          setPhase("setup");
          return;
        }
        await openSession(handle);
      })();
    },
    [device, openSession],
  );

  if (phase === "setup" && setup !== null) {
    return (
      <div className="phone">
        <SetupFlow
          port={setup.port}
          resumeAt={setup.resumeAt}
          resumeTier={tier}
          online={online}
          deviceWord={isDesktop ? "laptop" : "phone"}
          startNotice={error}
          onDone={(handle) => {
            deviceRef.current = handle;
            setupRef.current = null;
            setDeviceOpen(true);
            setPhase("unlocking");
            void openSession(handle);
          }}
        />
      </div>
    );
  }
  if (phase !== "ready" || sessions === null) {
    return (
      <div className="phone">
        <LockScreen
          onUnlock={unlock}
          busy={phase === "unlocking"}
          error={error}
          tier={tier}
          reason={lockReason === null ? null : lockReasonCopy(lockReason)}
        />
      </div>
    );
  }
  return (
    <>
      <ReadyApp
        teacher={sessions.teacher}
        para={sessions.para}
        online={online}
        theme={theme}
        now={nowRef.current}
        onLock={() => {
          if (autoLockRef.current === null) {
            lock("manual");
          } else {
            autoLockRef.current.lockNow();
          }
        }}
      />
      {lockWarning ? <LockWarning onKeepOpen={() => setLockWarning(false)} /> : null}
    </>
  );
}

/** The lock screen's reason line (flows U3). Minutes come from the auto-lock defaults. */
function lockReasonCopy(reason: LockReason): string {
  switch (reason) {
    case "manual":
      return "You locked the app.";
    case "idle":
      return `Locked after ${IDLE_DEFAULT_MS / 60_000} minutes without use. Everything you saved is still here.`;
    case "hidden":
      return `Locked because you left the app for more than ${HIDDEN_DEFAULT_MS / 60_000} minutes.`;
  }
}

/**
 * The idle warning at N − 1 (flows U3). Showing it never extends the timer (A-10); the
 * tap on Keep open is ordinary input, which is what resets the timer.
 */
function LockWarning({ onKeepOpen }: { readonly onKeepOpen: () => void }) {
  return (
    <div className="locktoast" role="status" data-testid="lock-warning">
      <span>Locking in {WARN_BEFORE_MS / 1000} seconds</span>
      <button type="button" className="btn primary" onClick={onKeepOpen}>
        Keep open
      </button>
    </div>
  );
}

function ReadyApp({
  teacher,
  para,
  online,
  theme,
  now,
  onLock,
}: {
  readonly teacher: Session;
  /** Null on a production build: no in-process para device, no role switch (A-6). */
  readonly para: ParaSession | null;
  readonly online: boolean;
  readonly theme: ThemeControl;
  readonly now: Date;
  readonly onLock: () => void;
}) {
  const { records, apply, refresh } = useSessionRecords(teacher);
  const isDesktop = useIsDesktop();
  const [role, setRole] = useState<Role>("teacher");
  const [tab, setTab] = useState<Tab>("track");
  const [trackView, setTrackView] = useState<TrackView>("dashboard");
  // The dashboard grouping lives here, not in DashboardScreen, so it survives Goal
  // Detail, the score modal and tab switches (TEACH-43). ReadyApp mounts on unlock, so
  // each unlock starts on owes-first; it is never persisted across reloads.
  const [lens, setLens] = useState<DashboardLens>("owes_first");
  const lensControl = useMemo(() => ({ lens, onChange: setLens }), [lens]);
  const [detailGoalId, setDetailGoalId] = useState<OpaqueId | null>(null);
  const [sheetTarget, setSheetTarget] = useState<SheetTarget | null>(null);
  const [paraFix, setParaFix] = useState<ProgressDataPoint | null>(null);
  const [paraRecords, setParaRecords] = useState<ParaDocRecords | null>(para?.paraRecords ?? null);
  const [paraQueue, setParaQueue] = useState<readonly ProgressDataPoint[]>(() =>
    teacher.readParaQueue(),
  );
  // Owes rows still show the ⏳ "awaiting your OK" cue — sourced from the para-doc
  // queue (D3 master-truth), since the para pending no longer live in master.
  const lk = useMemo(
    () => buildLookups(records, new Set(paraQueue.map((p) => p.goal_id))),
    [records, paraQueue],
  );
  // Both validation surfaces (mobile queue + desktop strip) render this display order.
  const validationQueue = useMemo(() => orderValidationQueue(paraQueue, lk), [paraQueue, lk]);
  const today = isoDateOf(now);

  // Pull any para-device captures into the teacher's para stream (ciphertext) and
  // re-derive the master-truth queue. Runs when the teacher role is (re)shown.
  const refreshParaQueue = useCallback(async () => {
    await teacher.refreshPara();
    setParaQueue(teacher.readParaQueue());
  }, [teacher]);

  useEffect(() => {
    if (role === "teacher" || para === null) {
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
  // The roster match New-Goal uses: the submit below and the form's IEP goal #
  // duplicate warning resolve initials to the SAME existing student.
  const studentForInitials = useCallback(
    (raw: string) => {
      const initials = normalizeInitials(raw);
      if (initials === undefined) {
        return undefined;
      }
      // Normalize the stored side too, so a pre-TEACH-40 "J.A.S." still matches "JAS".
      return records.students.find((s) => normalizeInitials(s.initials) === initials);
    },
    [records.students],
  );

  const submitNewGoal = useCallback(
    (form: NewGoalForm) => {
      // Canonical initials for the roster match + hue. The form gates submit on
      // valid initials, so this guard is defensive.
      const initials = normalizeInitials(form.initials);
      if (initials === undefined) {
        return;
      }
      const existing = studentForInitials(initials);
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
    [apply, studentForInitials],
  );

  // U5 baseline track handlers (M7). Baseline points share the goal's assigned probe
  // id as their comparable condition; adoption + arc-date edits go through the engine.
  const addBaselinePoint = useCallback(
    (goal: IEPGoal, numerator: number, denominator: number) => {
      // TEACH-46: the engine builds the point (proposed-only, teacher-only, whole
      // numbers, 0 ≤ n ≤ d) and flags a total that differs from the probe's (C8).
      const point = createBaselinePoint({
        goal,
        probe: records.probes.find((p) => p.goal_id === goal.goal_id),
        adminDate: today,
        numerator,
        denominator,
        who: "teacher",
        entryTs: nowTs(),
      });
      void apply(addBaselinePointMutator(point));
    },
    [apply, today, records.probes],
  );

  // TEACH-46 audited baseline edits — each appends a Revision; nothing is deleted.
  const fixBaseline = useCallback(
    (goal: IEPGoal, point: BaselinePoint, fix: BaselineFix) => {
      void apply(fixBaselinePointMutator(point, goal, fix, nowTs()));
    },
    [apply],
  );
  const removeBaseline = useCallback(
    (goal: IEPGoal, point: BaselinePoint, reason: BaselineRemoveReason) => {
      void apply(removeBaselinePointMutator(point, goal, reason, nowTs()));
    },
    [apply],
  );
  const keepBaseline = useCallback(
    (goal: IEPGoal, point: BaselinePoint) => {
      void apply(keepBaselineTotalMutator(point, goal, nowTs()));
    },
    [apply],
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

  // TEACH-41: every IEP goal # change is an audited Revision (setGoalLabel), persisted
  // through the same goal upsert as any other goal edit.
  const saveGoalLabel = useCallback(
    (goal: IEPGoal, label: string | undefined) => {
      void apply(upsertGoalMutator(setGoalLabel(goal, label, { who: "teacher", when: nowTs() })));
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
      if (para === null) {
        return;
      }
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
    (sid: OpaqueId): string | null => periodLabelOf(sid, lk),
    [lk],
  );

  const detailGoal =
    detailGoalId !== null ? records.goals.find((g) => g.goal_id === detailGoalId) : undefined;

  // ── U7 desktop shell wiring (design §2). Inert on mobile: the mobile chrome and the
  // mobile DashboardScreen path ignore isDesktop/validationStrip. ──
  const toScoreCount = buildToScoreQueue(records.points).length;
  const baselineCount = records.goals.filter((g) => g.status === "proposed").length;

  // The Goal Detail props for a goal (everything but onBack).
  const goalBodyProps = useCallback(
    (g: IEPGoal): Omit<GoalDetailScreenProps, "onBack"> => ({
      goal: g,
      points: records.points,
      observations: records.observations,
      initials: lk.initialsById.get(g.student_id) ?? "??",
      periodLabel: periodLabelByStudent(g.student_id),
      probeLabel: lk.probeByGoal.get(g.goal_id)?.label ?? "probe",
      labelDuplicates: duplicateGoalLabels(records.goals, g.student_id).get(g.goal_id) ?? [],
      onSetGoalLabel: (label) => saveGoalLabel(g, label),
      isNonInstructional: isNonInstructionalWeek,
      onAddPoint: () => setSheetTarget(targetForGoal(g, lk, today)),
      onEditPoint: (point) => setSheetTarget(targetForGoal(g, lk, today, point)),
      onAckMastery: (candidate) => void apply(acknowledgeMasteryMutator(candidate)),
      baselinePoints: records.baselinePoints,
      onFixBaselinePoint: (point, fix) => fixBaseline(g, point, fix),
    }),
    [
      records.goals,
      records.points,
      records.observations,
      lk,
      periodLabelByStudent,
      today,
      apply,
      saveGoalLabel,
      records.baselinePoints,
      fixBaseline,
    ],
  );

  // The full-width "Needs your OK" table strip (desktop dashboard); reuses the teacher
  // validate handlers. Null when nothing is pending.
  const validationStrip =
    paraQueue.length > 0 ? (
      <ValidationStrip
        queue={validationQueue}
        initialsById={lk.initialsById}
        goalTextById={lk.goalTextById}
        goalLabelById={lk.goalLabelById}
        periodLabelByStudent={periodLabelByStudent}
        onConfirm={confirmPara}
        onFix={fixPara}
      />
    ) : null;

  const shell = buildShellProps({
    role,
    tab,
    trackView,
    toScoreCount,
    baselineCount,
    go: setTrackView,
  });

  const track = (() => {
    if (trackView === "new_goal") {
      return (
        <NewGoalScreen
          goals={records.goals}
          studentIdForInitials={(initials) => studentForInitials(initials)?.student_id}
          onSubmit={submitNewGoal}
          onBack={() => setTrackView("dashboard")}
        />
      );
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
          onSetGoalLabel={saveGoalLabel}
          onFixBaselinePoint={fixBaseline}
          onRemoveBaselinePoint={removeBaseline}
          onKeepBaselineTotal={keepBaseline}
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
          queue={validationQueue}
          initialsById={lk.initialsById}
          goalTextById={lk.goalTextById}
          goalLabelById={lk.goalLabelById}
          onConfirm={confirmPara}
          onFix={fixPara}
          onBack={() => setTrackView("dashboard")}
        />
      );
    }
    if (trackView === "goal_detail" && detailGoal !== undefined) {
      return (
        <GoalDetailScreen {...goalBodyProps(detailGoal)} onBack={() => setTrackView("dashboard")} />
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
        lensControl={lensControl}
        isDesktop={isDesktop}
        validationStrip={validationStrip}
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
      isDesktop={isDesktop}
      online={online}
      role={role}
      onRole={para === null ? undefined : setRole}
      theme={theme.choice}
      onThemeCycle={theme.cycle}
      onLock={onLock}
      tab={tab}
      onTab={onTab}
      title={shell.title}
      onBack={shell.onBack}
      nav={shell.nav}
      paraContext={PARA_CONTEXT}
      overlay={overlay}
    >
      {role === "para" && paraRecords !== null ? (
        <ParaScreen paraRecords={paraRecords} now={now} capturePara={capturePara} />
      ) : tab === "track" ? (
        track
      ) : (
        <StubScreen title="Plan" note="Planner lands in Phase 2" />
      )}
    </AppShell>
  );
}
