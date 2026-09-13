// App root — drives the unlock state machine (locked → unlocking → ready) and
// holds the chrome state (role, tab, theme, online). On unlock it runs the U1
// bootstrap (passkey → keyring → sync client → decrypt → project) and renders
// the live dashboard from the synthetic seed. Offline-first: a best-effort sync
// runs after unlock and never blocks render.

import { useCallback, useRef, useState } from "react";
import { AppShell, type Tab } from "./app/AppShell.js";
import { LockScreen } from "./app/LockScreen.js";
import { DashboardScreen } from "./app/screens/DashboardScreen.js";
import { StubScreen } from "./app/screens/StubScreen.js";
import { useOnline } from "./app/useOnline.js";
import { useTheme } from "./app/useTheme.js";
import {
  type BootstrapOptions,
  bootstrapTeacherSession,
  type Role,
  type Session,
} from "./data/session.js";

type Phase = "locked" | "unlocking" | "ready";

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
  const [role, setRole] = useState<Role>("teacher");
  const [tab, setTab] = useState<Tab>("track");
  // Pin "now" once so the seed's week and the dashboard's evaluation week agree.
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

  const trackContent =
    tab === "track" ? (
      <DashboardScreen records={session.records} now={nowRef.current} />
    ) : (
      <StubScreen title="Plan" note="Planner lands in Phase 2" />
    );

  return (
    <AppShell
      online={online}
      role={role}
      onRole={setRole}
      theme={theme.choice}
      onThemeCycle={theme.cycle}
      tab={tab}
      onTab={setTab}
    >
      {role === "para" ? (
        <StubScreen title="Para surface" note="Para view lands in U6" />
      ) : (
        trackContent
      )}
    </AppShell>
  );
}
