// TEACH-58 (EU-2): the redeem lockout (spec §5.5) — per IP and global, 5
// failures in 15 min lock for 15 min; more than 20 failures in 24 h invalidate
// every unused owner code.

import { describe, expect, it } from "vitest";
import { BURN_AFTER_FAILURES, REDEEM_LOCKOUT, RedeemGuard } from "./redeem-guard.js";

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("RedeemGuard", () => {
  it("locks an IP after 5 failures in the window, for 15 minutes", () => {
    const c = clock();
    const g = new RedeemGuard(c.now);
    for (let i = 0; i < REDEEM_LOCKOUT.maxFailures - 1; i++) {
      g.fail("203.0.113.1");
      c.advance(1000);
    }
    expect(g.locked("203.0.113.1")).toBe(false);
    g.fail("203.0.113.1");
    expect(g.locked("203.0.113.1")).toBe(true);
    c.advance(REDEEM_LOCKOUT.lockoutMs - 1);
    expect(g.locked("203.0.113.1")).toBe(true);
    c.advance(1);
    expect(g.locked("203.0.113.1")).toBe(false);
  });

  it("failures spread past the window do not lock", () => {
    const c = clock();
    const g = new RedeemGuard(c.now);
    for (let i = 0; i < 10; i++) {
      g.fail("203.0.113.1");
      c.advance(REDEEM_LOCKOUT.windowMs / 4 + 1);
      if ((i + 1) % 4 === 0) {
        expect(g.locked("203.0.113.1")).toBe(false);
      }
    }
  });

  it("the global key locks every IP after 5 failures from different IPs", () => {
    const g = new RedeemGuard(clock().now);
    for (let i = 0; i < REDEEM_LOCKOUT.maxFailures; i++) {
      g.fail(`203.0.113.${i}`);
    }
    expect(g.locked("198.51.100.1")).toBe(true);
  });

  it("success clears its IP but never the global count", () => {
    const g = new RedeemGuard(clock().now);
    for (let i = 0; i < REDEEM_LOCKOUT.maxFailures - 1; i++) {
      g.fail("203.0.113.1");
    }
    g.succeed("203.0.113.1");
    g.fail("203.0.113.1");
    expect(g.locked("203.0.113.1")).toBe(true); // the global key reached 5
  });

  it("the 21st failure within 24 h asks for the codes to be invalidated, then counting restarts", () => {
    const c = clock();
    const g = new RedeemGuard(c.now);
    const burns: number[] = [];
    for (let i = 1; i <= 2 * (BURN_AFTER_FAILURES + 1); i++) {
      // Outlast every lockout so each attempt is a real failure.
      if (g.locked(`ip-${i}`)) {
        c.advance(REDEEM_LOCKOUT.lockoutMs);
      }
      if (g.fail(`ip-${i}`)) {
        burns.push(i);
      }
    }
    expect(burns).toEqual([BURN_AFTER_FAILURES + 1, 2 * (BURN_AFTER_FAILURES + 1)]);
  });

  it("failures older than 24 h do not count toward invalidation", () => {
    const c = clock();
    const g = new RedeemGuard(c.now);
    for (let i = 1; i <= BURN_AFTER_FAILURES; i++) {
      if (g.locked(`ip-${i}`)) {
        c.advance(REDEEM_LOCKOUT.lockoutMs);
      }
      expect(g.fail(`ip-${i}`)).toBe(false);
    }
    c.advance(24 * 60 * 60_000 + 1);
    expect(g.fail("ip-late")).toBe(false);
  });
});
