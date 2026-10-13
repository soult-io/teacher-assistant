// EU-6 — auto-lock (device-enrollment-spec §3.1, §11 EU-6 N2, §13 A-10): idle timeout
// (default 10 min, ceiling 15), hidden-page timeout (default 2 min, ceiling 5), manual
// lock, a wall-clock check on resume that locks synchronously (iOS suspends timers), and
// an idle warning at N−1 that never extends the timer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoLock, type AutoLockSurface, type LockReason } from "./auto-lock.js";

const MIN = 60_000;

/** A fake document: an EventTarget with a settable visibilityState. */
class FakeDoc extends EventTarget implements AutoLockSurface {
  visibilityState: DocumentVisibilityState = "visible";
  hide(): void {
    this.visibilityState = "hidden";
    this.dispatchEvent(new Event("visibilitychange"));
  }
  show(): void {
    this.visibilityState = "visible";
    this.dispatchEvent(new Event("visibilitychange"));
  }
  tap(): void {
    this.dispatchEvent(new Event("pointerdown"));
  }
}

function setup(options: { idleMs?: number; hiddenMs?: number } = {}) {
  const doc = new FakeDoc();
  const locks: LockReason[] = [];
  let warnings = 0;
  let cleared = 0;
  const lock = new AutoLock({
    surface: doc,
    ...options,
    onLock: (reason) => locks.push(reason),
    onWarn: () => {
      warnings += 1;
    },
    onWarnClear: () => {
      cleared += 1;
    },
  });
  lock.start();
  return {
    doc,
    lock,
    locks,
    warnings: () => warnings,
    cleared: () => cleared,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ceilings (N2)", () => {
  it("defaults to 10 min idle and 2 min hidden", () => {
    const { lock } = setup();
    expect(lock.idleMs).toBe(10 * MIN);
    expect(lock.hiddenMs).toBe(2 * MIN);
  });

  it("refuses idle above 15 min and hidden above 5 min", () => {
    const doc = new FakeDoc();
    const onLock = () => {};
    expect(() => new AutoLock({ surface: doc, onLock, idleMs: 15 * MIN + 1 })).toThrow();
    expect(() => new AutoLock({ surface: doc, onLock, hiddenMs: 5 * MIN + 1 })).toThrow();
    expect(
      () => new AutoLock({ surface: doc, onLock, idleMs: 15 * MIN, hiddenMs: 5 * MIN }),
    ).not.toThrow();
  });
});

describe("idle", () => {
  it("warns at N−1 and locks at N", () => {
    const { locks, warnings } = setup();
    vi.advanceTimersByTime(9 * MIN - 1);
    expect(warnings()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(warnings()).toBe(1);
    expect(locks).toEqual([]);
    vi.advanceTimersByTime(MIN - 1);
    expect(locks).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(locks).toEqual(["idle"]);
  });

  it("A-10: the warning never extends the timer", () => {
    const { locks, warnings } = setup();
    vi.advanceTimersByTime(9 * MIN);
    expect(warnings()).toBe(1);
    vi.advanceTimersByTime(MIN);
    expect(locks).toEqual(["idle"]); // exactly N after the last input, warning or not
  });

  it("a real input resets the timer and clears the warning", () => {
    const { doc, locks, cleared } = setup();
    vi.advanceTimersByTime(9.5 * MIN);
    doc.tap();
    expect(cleared()).toBe(1);
    vi.advanceTimersByTime(MIN);
    expect(locks).toEqual([]);
    vi.advanceTimersByTime(9 * MIN);
    expect(locks).toEqual(["idle"]);
  });
});

describe("paused timers while visible (a sleeping laptop)", () => {
  it("the first input after more than N idle locks instead of resetting the timer", () => {
    const { doc, locks } = setup();
    vi.setSystemTime(Date.now() + 11 * MIN); // no timer ran; the page never went hidden
    doc.tap();
    expect(locks).toEqual(["idle"]);
  });
});

describe("hidden page", () => {
  it("locks after M minutes hidden", () => {
    const { doc, locks } = setup();
    doc.hide();
    vi.advanceTimersByTime(2 * MIN);
    expect(locks).toEqual(["hidden"]);
  });

  it("returning before M does not lock", () => {
    const { doc, locks } = setup();
    doc.hide();
    vi.advanceTimersByTime(MIN);
    doc.show();
    vi.advanceTimersByTime(2 * MIN);
    expect(locks).toEqual([]);
  });

  it("timers suspended (iOS): the wall-clock check locks synchronously on resume", () => {
    const { doc, locks } = setup();
    doc.hide();
    // Background timers never ran; only the wall clock moved.
    vi.setSystemTime(Date.now() + 3 * MIN);
    doc.show();
    expect(locks).toEqual(["hidden"]); // inside the visibilitychange dispatch — before render
  });

  it("the idle limit is also checked on resume by wall clock", () => {
    const { doc, locks } = setup({ hiddenMs: 5 * MIN });
    vi.advanceTimersByTime(8 * MIN);
    doc.hide();
    vi.setSystemTime(Date.now() + 3 * MIN); // 11 min since the last input, 3 min hidden
    doc.show();
    expect(locks).toEqual(["idle"]);
  });
});

describe("manual lock and teardown", () => {
  it("locks once with reason manual, then ignores every later trigger", () => {
    const { doc, lock, locks } = setup();
    lock.lockNow();
    lock.lockNow();
    doc.hide();
    vi.advanceTimersByTime(30 * MIN);
    doc.show();
    expect(locks).toEqual(["manual"]);
    expect(lock.locked).toBe(true);
  });

  it("stop() detaches every listener and timer", () => {
    const { doc, lock, locks } = setup();
    lock.stop();
    doc.hide();
    vi.advanceTimersByTime(30 * MIN);
    doc.show();
    expect(locks).toEqual([]);
  });
});
