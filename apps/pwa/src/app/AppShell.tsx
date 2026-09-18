// The app chrome (design/prototype-p0.html + design/desktop-design-spec.md §2).
//
// MOBILE (<900px): the de-bezelled phone — status bar (offline/online badge,
// Teacher/Para role switch, theme toggle), the scrollable screen, and the bottom
// Track/Plan tab bar. The tab bar is hidden in the Para role (period-scoped surface).
//
// DESKTOP (>=900px): a persistent left SIDEBAR (brand + Track/Plan nav + the folded-in
// Track destinations) replaces the bottom tab bar, and a thin TOP BAR (screen title +
// back affordance on the left; the same offline/role/theme trio on the right) replaces
// the full-width status bar. The Para role collapses the sidebar to the single roster
// context — no Plan, no Track destinations, no deep links — the FERPA least-privilege
// boundary enforced by the SHELL (structural), exactly as the mobile tab bar is.
//
// The two chrome variants share the offline/role/theme controls (one component each) so
// the trio stays byte-identical between them. The mobile variant renders the exact
// prototype markup so the validated mobile layout is unchanged.

import type { ReactNode } from "react";
import type { Role } from "../data/session.js";
import { themeIcon, type ThemeChoice } from "./useTheme.js";

export type Tab = "track" | "plan";

/** The Track destinations folded into the desktop sidebar (teacher, Track context only). */
export interface ShellNav {
  readonly toScoreCount: number;
  readonly baselineCount: number;
  readonly onToScore: () => void;
  readonly onBaseline: () => void;
  readonly onNewGoal: () => void;
}

export interface AppShellProps {
  readonly isDesktop: boolean;
  readonly online: boolean;
  readonly role: Role;
  readonly onRole: (role: Role) => void;
  readonly theme: ThemeChoice;
  readonly onThemeCycle: () => void;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  /** Desktop top-bar title (current screen). Unused on mobile. */
  readonly title: string;
  /** Desktop top-bar back affordance (sub-screens only); undefined on top-level views. */
  readonly onBack?: (() => void) | undefined;
  /** Desktop sidebar Track destinations — present only in the teacher Track context. */
  readonly nav?: ShellNav | undefined;
  /** Desktop sidebar roster context label (Para role). */
  readonly paraContext?: string | undefined;
  readonly children: ReactNode;
  /** Phone-/shell-level overlay (the Quick-Score sheet/modal + scrim), above the chrome. */
  readonly overlay?: ReactNode;
}

function OfflineBadge({ online }: { readonly online: boolean }) {
  // data-testid is a stable hook for the J2 offline-sync journey to read reachability
  // independent of the glyph/copy or the CSS state class (additive; no behaviour change).
  return (
    <span className={`offline${online ? " online" : ""}`} data-testid="offline-badge">
      {online ? "⇅ online" : "⚡ offline · syncs later"}
    </span>
  );
}

function RoleSeg({ role, onRole }: { readonly role: Role; readonly onRole: (role: Role) => void }) {
  return (
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
  );
}

function ThemeToggle({
  theme,
  onThemeCycle,
}: {
  readonly theme: ThemeChoice;
  readonly onThemeCycle: () => void;
}) {
  return (
    <button
      type="button"
      className="iconbtn"
      onClick={onThemeCycle}
      aria-label={`theme: ${theme}`}
      title={`Theme: ${theme}`}
    >
      {themeIcon(theme)}
    </button>
  );
}

function TabButton({
  active,
  label,
  glyph,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly glyph: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className={active ? "on" : ""} aria-pressed={active} onClick={onClick}>
      <span className="ic" aria-hidden="true">
        {glyph}
      </span>
      {label}
    </button>
  );
}

/** MOBILE chrome — the exact prototype markup (status bar · screen · Track/Plan tab bar). */
function MobileChrome(props: AppShellProps) {
  const { online, role, onRole, theme, onThemeCycle, tab, onTab, children, overlay } = props;
  return (
    <div className="phone" id="phone">
      <div className="statusbar">
        <OfflineBadge online={online} />
        <span className="grow" />
        <RoleSeg role={role} onRole={onRole} />
        <ThemeToggle theme={theme} onThemeCycle={onThemeCycle} />
      </div>

      <div className="screen" id="screen">
        {children}
      </div>

      {role === "teacher" ? (
        <div className="tabbar">
          <TabButton
            active={tab === "track"}
            label="Track"
            glyph="●"
            onClick={() => onTab("track")}
          />
          <TabButton active={tab === "plan"} label="Plan" glyph="☰" onClick={() => onTab("plan")} />
        </div>
      ) : null}

      {overlay}
    </div>
  );
}

/** The desktop sidebar Track destinations (folded up from the mobile dashboard footer). */
function SidebarDestinations({ nav }: { readonly nav: ShellNav }) {
  return (
    <>
      <div className="navdiv" />
      <div className="navsec">This week</div>
      <button type="button" className="navitem" onClick={nav.onToScore}>
        <span className="ic" aria-hidden="true">
          ◷
        </span>
        To-score
        <span className="badge">{nav.toScoreCount}</span>
      </button>
      <button type="button" className="navitem" onClick={nav.onBaseline}>
        <span className="ic" aria-hidden="true">
          ⏳
        </span>
        Baseline / proposed
        <span className="badge">{nav.baselineCount}</span>
      </button>
      <button type="button" className="navitem" onClick={nav.onNewGoal}>
        <span className="ic" aria-hidden="true">
          ＋
        </span>
        New goal
      </button>
    </>
  );
}

function Sidebar({
  role,
  tab,
  onTab,
  nav,
  paraContext,
}: {
  readonly role: Role;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly nav?: ShellNav;
  readonly paraContext?: string;
}) {
  // Para role: roster context ONLY — no Track/Plan, no destinations (FERPA §2).
  if (role === "para") {
    return (
      <aside className="sidebar">
        <div className="brand">
          Teacher Assistant<small>Para surface</small>
        </div>
        <div className="navsec">Your class</div>
        <div className="sidefoot">{paraContext ?? "Period-scoped roster"}</div>
      </aside>
    );
  }
  return (
    <aside className="sidebar">
      <div className="brand">
        Teacher Assistant<small>Track · Plan</small>
      </div>
      <button
        type="button"
        className={`navitem${tab === "track" ? " on" : ""}`}
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
        className={`navitem${tab === "plan" ? " on" : ""}`}
        aria-pressed={tab === "plan"}
        onClick={() => onTab("plan")}
      >
        <span className="ic" aria-hidden="true">
          ☰
        </span>
        Plan
      </button>
      {nav !== undefined && tab === "track" ? <SidebarDestinations nav={nav} /> : null}
      <div className="sidefoot">Signed in · initials only</div>
    </aside>
  );
}

/** DESKTOP chrome — persistent sidebar + thin top bar + capped, centered content column. */
function DesktopShell(props: AppShellProps) {
  const { online, role, onRole, theme, onThemeCycle, tab, onTab, title, onBack, nav, paraContext } =
    props;
  return (
    <div className="phone shell" id="phone">
      <Sidebar
        role={role}
        tab={tab}
        onTab={onTab}
        {...(nav !== undefined ? { nav } : {})}
        {...(paraContext !== undefined ? { paraContext } : {})}
      />
      <div className="main">
        <div className="topbar">
          {/* The band spans the full main column (background + divider); its content is
              held in the same centered 1180px inner column as `.screen-inner`, so the
              title aligns with the content's left edge and the offline/role/theme trio
              aligns with its right edge — one coherent column. */}
          <div className="topbar-inner">
            {onBack !== undefined ? (
              <button type="button" className="backlink" onClick={onBack}>
                ‹ Dashboard
              </button>
            ) : null}
            <span className="title">{title}</span>
            <span className="topgrow" />
            <OfflineBadge online={online} />
            <RoleSeg role={role} onRole={onRole} />
            <ThemeToggle theme={theme} onThemeCycle={onThemeCycle} />
          </div>
        </div>
        <div className="screen" id="screen">
          <div className="screen-inner">{props.children}</div>
        </div>
      </div>
      {props.overlay}
    </div>
  );
}

export function AppShell(props: AppShellProps) {
  return props.isDesktop ? <DesktopShell {...props} /> : <MobileChrome {...props} />;
}
