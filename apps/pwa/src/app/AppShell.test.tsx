import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell, type AppShellProps, type ShellNav } from "./AppShell.js";

const nav: ShellNav = {
  toScoreCount: 2,
  baselineCount: 1,
  onToScore: vi.fn(),
  onBaseline: vi.fn(),
  onNewGoal: vi.fn(),
};

function base(over: Partial<AppShellProps>): AppShellProps {
  return {
    isDesktop: false,
    online: true,
    role: "teacher",
    onRole: vi.fn(),
    theme: "system",
    onThemeCycle: vi.fn(),
    tab: "track",
    onTab: vi.fn(),
    title: "Weekly Dashboard",
    children: <div data-testid="child">content</div>,
    ...over,
  };
}

describe("AppShell", () => {
  it("mobile renders the status bar + bottom Track/Plan tab bar (teacher)", () => {
    const { container } = render(<AppShell {...base({ isDesktop: false })} />);
    expect(container.querySelector(".tabbar")).not.toBeNull();
    expect(container.querySelector(".sidebar")).toBeNull();
    expect(screen.getByRole("button", { name: "Track" })).toBeInTheDocument();
  });

  it("desktop renders the sidebar shell with the folded-in Track destinations (teacher)", () => {
    const { container } = render(<AppShell {...base({ isDesktop: true, nav })} />);
    expect(container.querySelector(".sidebar")).not.toBeNull();
    expect(container.querySelector(".tabbar")).toBeNull();
    // Track/Plan nav + the destinations moved up from the dashboard footer.
    expect(screen.getByRole("button", { name: /Track/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Plan/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /To-score/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Baseline \/ proposed/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New goal/ })).toBeInTheDocument();
    // The top bar carries the screen title.
    expect(screen.getByText("Weekly Dashboard")).toBeInTheDocument();
  });

  it("desktop PARA collapses the shell — no Plan, no Track destinations (FERPA §2)", () => {
    render(
      <AppShell
        {...base({
          isDesktop: true,
          role: "para",
          paraContext: "3rd period · Math 81 Resource · JT",
        })}
      />,
    );
    // The structural boundary: none of the teacher navigation exists in the DOM.
    expect(screen.queryByRole("button", { name: /Plan/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Track$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /To-score/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Baseline/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New goal/ })).toBeNull();
    expect(screen.getByText("3rd period · Math 81 Resource · JT")).toBeInTheDocument();
  });

  it("desktop shows the top-bar back affordance only when onBack is provided", () => {
    const onBack = vi.fn();
    const { rerender } = render(<AppShell {...base({ isDesktop: true, nav })} />);
    expect(screen.queryByRole("button", { name: "‹ Dashboard" })).toBeNull();
    rerender(<AppShell {...base({ isDesktop: true, nav, onBack, title: "Goal Detail" })} />);
    expect(screen.getByRole("button", { name: "‹ Dashboard" })).toBeInTheDocument();
  });
});
