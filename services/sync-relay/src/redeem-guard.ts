// Lockout for POST /sync/enroll/redeem (device-enrollment spec §5.5, H-PUB-5).
//
// - Per client IP (the trusted req.ip, EU-0) and one global key: 5 failures in
//   15 minutes lock that key for 15 minutes (the DEFAULT_THROTTLE policy of
//   packages/auth, restated here because the relay must not depend on that
//   package: it imports @teacher-assistant/crypto, and the relay never does).
// - More than 20 failures in 24 hours across all IPs: every unused owner code
//   is invalidated and the operator reissues. fail() reports that moment.
//
// State is in-process, like the rate limiter (single relay instance). A
// locked-out attempt is refused before the code is looked at, so it neither
// counts as a failure nor can succeed.

export interface LockoutPolicy {
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly lockoutMs: number;
}

export const REDEEM_LOCKOUT: LockoutPolicy = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
};

/** Failures across all IPs, within BURN_WINDOW_MS, above which unused codes are invalidated. */
export const BURN_AFTER_FAILURES = 20;
export const BURN_WINDOW_MS = 24 * 60 * 60_000;

/** Above this many tracked IPs, entries whose window and lockout have both passed are dropped. */
const SWEEP_AT = 10_000;

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

const GLOBAL_KEY = "\u0000global";

export class RedeemGuard {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  #burn: { failures: number; windowStart: number } = { failures: 0, windowStart: 0 };

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** True while this IP or the global key is locked out. */
  locked(ip: string): boolean {
    const now = this.#now();
    return [ip, GLOBAL_KEY].some((k) => (this.#entries.get(k)?.lockedUntil ?? 0) > now);
  }

  /** Count a failed redeem from `ip`. Returns true when unused codes must now be invalidated. */
  fail(ip: string): boolean {
    const now = this.#now();
    this.#count(ip, now);
    this.#count(GLOBAL_KEY, now);
    if (now - this.#burn.windowStart > BURN_WINDOW_MS) {
      this.#burn = { failures: 0, windowStart: now };
    }
    this.#burn.failures += 1;
    if (this.#burn.failures > BURN_AFTER_FAILURES) {
      this.#burn = { failures: 0, windowStart: now };
      return true;
    }
    return false;
  }

  /** A successful redeem clears its IP's failures (never the global count). */
  succeed(ip: string): void {
    this.#entries.delete(ip);
  }

  #count(key: string, now: number): void {
    let e = this.#entries.get(key);
    if (e === undefined || now - e.windowStart > REDEEM_LOCKOUT.windowMs) {
      if (this.#entries.size >= SWEEP_AT) {
        this.#sweep(now);
      }
      e = { failures: 0, windowStart: now, lockedUntil: 0 };
      this.#entries.set(key, e);
    }
    e.failures += 1;
    if (e.failures >= REDEEM_LOCKOUT.maxFailures) {
      e.lockedUntil = now + REDEEM_LOCKOUT.lockoutMs;
    }
  }

  #sweep(now: number): void {
    for (const [k, e] of this.#entries) {
      if (e.lockedUntil <= now && now - e.windowStart > REDEEM_LOCKOUT.windowMs) {
        this.#entries.delete(k);
      }
    }
  }
}
