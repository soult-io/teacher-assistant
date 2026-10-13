// EU-6 (TEACH-66) — the app-level lock (device-enrollment-spec rev 2.4 §3.1, §11 EU-6,
// §13 A-10; flows U3): the Lock action, idle auto-lock with its N−1 warning, and the
// hidden-page lock that runs on resume before anything renders. Every lock calls
// lock() on BOTH sessions (the para keyring included) and drops them.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import type { BootstrapOptions, ParaHandoff, ParaSession, Session } from "./data/session.js";
import { buildSyntheticSeed } from "./data/synthetic-seed.js";
import { makeFakeParaSession, makeFakeSession } from "./test/fake-session.js";

const MIN = 60_000;

function harness() {
  const locks = { teacher: 0, para: 0 };
  const bootstrap = (options: BootstrapOptions): Promise<Session> => {
    const session = makeFakeSession(buildSyntheticSeed(options.now));
    return Promise.resolve({
      ...session,
      lock: () => {
        locks.teacher += 1;
      },
    });
  };
  const bootstrapPara = async (handoff: ParaHandoff): Promise<ParaSession> => {
    const para = await makeFakeParaSession(handoff);
    return {
      ...para,
      lock: () => {
        locks.para += 1;
      },
    };
  };
  return { locks, bootstrap, bootstrapPara };
}

async function unlockApp(h: ReturnType<typeof harness>) {
  render(<App bootstrap={h.bootstrap} bootstrapPara={h.bootstrapPara} />);
  fireEvent.click(screen.getByTestId("unlock"));
  await screen.findByTestId("header-line");
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
});

describe("App — Lock", () => {
  it("the Lock button locks both sessions and shows the lock screen with its reason", async () => {
    const h = harness();
    await unlockApp(h);
    fireEvent.click(screen.getByTestId("lock"));
    expect(screen.getByTestId("unlock")).toBeInTheDocument();
    expect(screen.queryByTestId("header-line")).toBeNull();
    expect(screen.getByTestId("lock-reason")).toHaveTextContent("You locked the app.");
    expect(h.locks).toEqual({ teacher: 1, para: 1 });
  });

  it("a fresh unlock after a lock gets new sessions", async () => {
    const h = harness();
    await unlockApp(h);
    fireEvent.click(screen.getByTestId("lock"));
    fireEvent.click(screen.getByTestId("unlock"));
    await screen.findByTestId("header-line");
    expect(screen.queryByTestId("lock-reason")).toBeNull();
  });
});

describe("App — hidden page", () => {
  it("returning after more than 2 minutes locks synchronously, before any render", async () => {
    const h = harness();
    await unlockApp(h);
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(t0);
    act(() => setVisibility("hidden"));
    now.mockReturnValue(t0 + 2 * MIN + 1); // background timers never ran (iOS)
    setVisibility("visible"); // no act(): the DOM must already be the lock screen
    expect(screen.queryByTestId("header-line")).toBeNull();
    expect(screen.getByTestId("lock-reason")).toHaveTextContent(
      "Locked because you left the app for more than 2 minutes.",
    );
    expect(h.locks).toEqual({ teacher: 1, para: 1 });
    now.mockRestore();
  });
});

describe("App — idle", () => {
  it("warns at 9 minutes, the warning does not extend the timer, and it locks at 10", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness();
    await unlockApp(h);
    act(() => {
      vi.advanceTimersByTime(9 * MIN);
    });
    expect(screen.getByTestId("lock-warning")).toHaveTextContent("Locking in 60 seconds");
    act(() => {
      vi.advanceTimersByTime(MIN);
    });
    expect(screen.queryByTestId("header-line")).toBeNull();
    expect(screen.getByTestId("lock-reason")).toHaveTextContent(
      "Locked after 10 minutes without use. Everything you saved is still here.",
    );
    expect(h.locks).toEqual({ teacher: 1, para: 1 });
  });

  it("Keep open (a real tap) resets the timer and hides the warning", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = harness();
    await unlockApp(h);
    act(() => {
      vi.advanceTimersByTime(9 * MIN);
    });
    const keep = screen.getByRole("button", { name: "Keep open" });
    act(() => {
      fireEvent.pointerDown(keep);
      fireEvent.click(keep);
    });
    expect(screen.queryByTestId("lock-warning")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(5 * MIN);
    });
    expect(screen.getByTestId("header-line")).toBeInTheDocument();
    expect(h.locks).toEqual({ teacher: 0, para: 0 });
  });
});
