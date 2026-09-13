// The app chrome (design/prototype-p0.html): the centered phone frame, the
// status bar (offline/online badge, Teacher/Para role switch, theme toggle), the
// scrollable screen, and the bottom Track/Plan tab bar. The tab bar is hidden in
// the Para role (period-scoped surface, prototype behavior).

import type { ReactNode } from "react";
import type { Role } from "../data/session.js";
import { themeIcon, type ThemeChoice } from "./useTheme.js";

export type Tab = "track" | "plan";

export interface AppShellProps {
  readonly online: boolean;
  readonly role: Role;
  readonly onRole: (role: Role) => void;
  readonly theme: ThemeChoice;
  readonly onThemeCycle: () => void;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly children: ReactNode;
}

export function AppShell(props: AppShellProps) {
  const { online, role, onRole, theme, onThemeCycle, tab, onTab, children } = props;
  return (
    <div className="phone" id="phone">
      <div className="statusbar">
        <span className={`offline${online ? " online" : ""}`}>
          {online ? "⇅ online" : "⚡ offline · syncs later"}
        </span>
        <span className="grow" />
        <div className="roleseg">
          <button
            type="button"
            className={role === "teacher" ? "on" : ""}
            aria-pressed={role === "teacher"}
            onClick={() => onRole("teacher")}
          >
            Teacher
          </button>
          <button
            type="button"
            className={role === "para" ? "on" : ""}
            aria-pressed={role === "para"}
            onClick={() => onRole("para")}
          >
            Para (JT)
          </button>
        </div>
        <button
          type="button"
          className="iconbtn"
          onClick={onThemeCycle}
          aria-label={`theme: ${theme}`}
          title={`Theme: ${theme}`}
        >
          {themeIcon(theme)}
        </button>
      </div>

      <div className="screen" id="screen">
        {children}
      </div>

      {role === "teacher" ? (
        <div className="tabbar">
          <button
            type="button"
            className={tab === "track" ? "on" : ""}
            aria-pressed={tab === "track"}
            onClick={() => onTab("track")}
          >
            <span className="ic" aria-hidden="true">
              ●
            </span>
            Track
          </button>
          <button
            type="button"
            className={tab === "plan" ? "on" : ""}
            aria-pressed={tab === "plan"}
            onClick={() => onTab("plan")}
          >
            <span className="ic" aria-hidden="true">
              ☰
            </span>
            Plan
          </button>
        </div>
      ) : null}
    </div>
  );
}
