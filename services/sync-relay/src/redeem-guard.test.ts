// TEACH-58 (EU-2): the redeem lockout (spec §5.5) — per IP and global, 5
// failures in 15 min lock for 15 min; in-flight attempts count against the
// limit; more than 20 failures in any 24 h invalidate every unused owner code.

import { describe, expect, it } from "vitest";
import {
  BURN_AFTER_FAILURES,
  BURN_WINDOW_MS,
  REDEEM_LOCKOUT,
  RedeemGuard,
} from "./redeem-guard.js";

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** One attempt from `ip` that fails; returns whether a burn was asked for. */
function failOnce(g: RedeemGuard, ip: string): boolean {
  const a = g.begin(ip);
  expect(a, `${ip} should not be locked`).toBeDefined();
  const burn = a?.fail() ?? false;
  a?.release();
  return burn;
}

describe("RedeemGuard", () => {
  it("locks an IP after 5 failures in the window, for exactly 15 minutes", () => {
    const c = clock();
    const g = new RedeemGuard(c.now);
    for (let i = 0; i < REDEEM_LOCKOUT.maxFailures - 1; i++) {
      failOnce(g, "203.0.113.1");
      c.advance(1000);
    }
    failOnce(g, "203.0.113.1");
    expect(g.begin("203.0.113.1")).toBeUndefined();
    c.advance(REDEEM_LOCKOUT.lockoutMs - 1);
    expect(g.begin("203.0.113.1")).toBeUndefined();
    c.advance(1);
    expect(g.begin("203.0.113.1")).toBeDefined();
  });

  it("failures spread past the window do not lock", () => {
    const c = clock();
    const g = new RedeemGuard(c.now);
    for (let i = 0; i < 10; i++) {
      failOnce(g, "203.0.113.1");
      c.advance(REDEEM_LOCKOUT.windowMs / 4 + 1);
    }
  });

  it("the global key locks every IP after 5 failures from different IPs", () => {
    const g = new RedeemGuard(clock().now);
    for (let i = 0; i < REDEEM_LOCKOUT.maxFailures; i++) {
      failOnce(g, `203.0.113.${i}`);
    }
    expect(g.begin("198.51.100.1")).toBeUndefined();
  });

  it("a refused attempt leaves no state: a many-address flood during a lockout does not grow the map", () => {
    const g = new RedeemGuard(clock().now);
    for (let i = 0; i < REDEEM_LOCKOUT.maxFailures; i++) {
      failOnce(g, `203.0.113.${i}`);
    }
    const before = g.size;
    for (let i = 0; i < 20_000; i++) {
      expect(g.begin(`2001:db8::${i.toString(16)}`)).toBeUndefined();
    }
    expect(g.size).toBe(before);
  });

  it("in-flight attempts count: a parallel burst gets at most 5 attempts through", () => {
    const g = new RedeemGuard(clock().now);
    const started = Array.from({ length: 20 }, () => g.begin("203.0.113.1"));
    expect(started.filter((a) => a !== undefined)).toHaveLength(REDEEM_LOCKOUT.maxFailures);
    for (const a of started) {
      a?.fail();
      a?.release();
    }
    expect(g.begin("203.0.113.1")).toBeUndefined();
  });

  it("a released attempt (400, 5xx) frees its slot without counting", () => {
    const g = new RedeemGuard(clock().now);
    for (let i = 0; i < 20; i++) {
      const a = g.begin("203.0.113.1");
      expect(a).toBeDefined();
      a?.release();
      a?.release(); // idempotent
    }
  });

  it("success clears its IP but never the global count", () => {
    const g = new RedeemGuard(clock().now);
    for (let i = 0; i < REDEEM_LOCKOUT.maxFailures - 1; i++) {
      failOnce(g, "203.0.113.1");
    }
    const ok = g.begin("203.0.113.1");
    ok?.succeed();
    ok?.release();
    failOnce(g, "203.0.113.1");
    expect(g.begin("203.0.113.1")).toBeUndefined(); // the global key reached 5
  });

  it("the 21st failure within 24 h asks for a burn; until burned() every failure asks again", () => {
    const c = clock();
    const g = new RedeemGuard(c.now);
    const outlast = (ip: string) => {
      const probe = g.begin(ip);
      if (probe === undefined) {
        c.advance(REDEEM_LOCKOUT.lockoutMs);
      } else {
        probe.release();
      }
    };
    for (let i = 1; i <= BURN_AFTER_FAILURES; i++) {
      outlast(`ip-${i}`);
      expect(failOnce(g, `ip-${i}`)).toBe(false);
    }
    outlast("ip-21");
    expect(failOnce(g, "ip-21")).toBe(true);
    outlast("ip-22");
    expect(failOnce(g, "ip-22")).toBe(true); // the invalidation did not happen: ask again
    g.burned();
    outlast("ip-23");
    expect(failOnce(g, "ip-23")).toBe(false);
  });

  it("the 24 h window slides: only failures in the last 24 h count", () => {
    const c = clock();
    const g = new RedeemGuard(c.now);
    // 20 failures, each past any lockout, spread over just under 24 h.
    const step = (BURN_WINDOW_MS - 60_000) / BURN_AFTER_FAILURES;
    for (let i = 1; i <= BURN_AFTER_FAILURES; i++) {
      expect(failOnce(g, `ip-${i}`)).toBe(false);
      c.advance(step);
    }
    // The first failure has aged out: still 20 in the window after this one.
    c.advance(60_000 + 1);
    expect(failOnce(g, "ip-late")).toBe(false);
    // One more while all 20 are inside the window → 21.
    c.advance(REDEEM_LOCKOUT.lockoutMs);
    expect(failOnce(g, "ip-later")).toBe(true);
  });
});
