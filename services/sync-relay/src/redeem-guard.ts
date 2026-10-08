// Lockout for POST /sync/enroll/redeem (device-enrollment spec §5.5, H-PUB-5).
//
// - Per client IP (the trusted req.ip, EU-0) and one global key: 5 failures in
//   15 minutes lock that key for 15 minutes (the DEFAULT_THROTTLE policy of
//   packages/auth, restated here because the relay must not depend on that
//   package: it imports @teacher-assistant/crypto, and the relay never does).
// - More than 20 failures in any 24 hours across all IPs: every unused owner
//   code is invalidated and the operator reissues.
//
// An attempt is reserved (begin) BEFORE the store is consulted, so parallel
// requests cannot all pass the check while earlier ones are still awaiting the
// database: in-flight attempts count against the limit as if they had failed.
// A locked-out attempt is refused before the code is looked at, so it neither
// counts as a failure nor can succeed.
//
// State is in-process, like the rate limiter (single relay instance).

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

/** Above this many tracked IPs, idle entries (no window, lockout or attempt running) are dropped. */
const SWEEP_AT = 10_000;

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  inFlight: number;
}

const GLOBAL_KEY = "\u0000global";

/** One reserved redeem attempt. Exactly one of fail/succeed, or neither; release always. */
export interface RedeemAttempt {
  /** Count the failure. True when unused codes must now be invalidated (then call burned()). */
  fail(): boolean;
  /** A successful redeem clears its IP's failures (never the global count). */
  succeed(): void;
  /** End the attempt (idempotent; call in `finally`). */
  release(): void;
}

export class RedeemGuard {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  /** Timestamps of failures within the last BURN_WINDOW_MS (sliding). */
  #burnFailures: number[] = [];

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Reserve an attempt from `ip`, or undefined while it or the global key is locked out. */
  begin(ip: string): RedeemAttempt | undefined {
    const now = this.#now();
    const keys = [ip, GLOBAL_KEY];
    if (keys.some((k) => this.#blocked(this.#current(k, now), now))) {
      return undefined;
    }
    for (const k of keys) {
      this.#current(k, now).inFlight += 1;
    }
    let open = true;
    const release = () => {
      if (open) {
        open = false;
        for (const k of keys) {
          const e = this.#entries.get(k);
          if (e !== undefined) {
            e.inFlight -= 1;
          }
        }
      }
    };
    return {
      fail: () => {
        release();
        const at = this.#now();
        for (const k of keys) {
          this.#count(this.#current(k, at), at);
        }
        this.#burnFailures = [...this.#burnFailures.filter((t) => at - t < BURN_WINDOW_MS), at];
        return this.#burnFailures.length > BURN_AFTER_FAILURES;
      },
      succeed: () => {
        release();
        const e = this.#entries.get(ip);
        if (e !== undefined && e.inFlight === 0) {
          this.#entries.delete(ip);
        } else if (e !== undefined) {
          e.failures = 0;
        }
      },
      release,
    };
  }

  /**
   * Unused codes were invalidated: start counting afresh. Until this is called
   * (e.g. the invalidation failed) every further failure asks again.
   */
  burned(): void {
    this.#burnFailures = [];
  }

  #blocked(e: Entry, now: number): boolean {
    return e.lockedUntil > now || e.failures + e.inFlight >= REDEEM_LOCKOUT.maxFailures;
  }

  /** The key's entry, with its failure window restarted if it has elapsed. */
  #current(key: string, now: number): Entry {
    let e = this.#entries.get(key);
    if (e === undefined) {
      if (this.#entries.size >= SWEEP_AT) {
        this.#sweep(now);
      }
      e = { failures: 0, windowStart: now, lockedUntil: 0, inFlight: 0 };
      this.#entries.set(key, e);
    } else if (
      e.lockedUntil === 0 ? now - e.windowStart > REDEEM_LOCKOUT.windowMs : e.lockedUntil <= now // a lockout that has run out starts a fresh window
    ) {
      e.failures = 0;
      e.windowStart = now;
      e.lockedUntil = 0;
    }
    return e;
  }

  #count(e: Entry, now: number): void {
    if (e.failures === 0) {
      e.windowStart = now;
    }
    e.failures += 1;
    if (e.failures >= REDEEM_LOCKOUT.maxFailures) {
      e.lockedUntil = now + REDEEM_LOCKOUT.lockoutMs;
    }
  }

  #sweep(now: number): void {
    for (const [k, e] of this.#entries) {
      if (
        e.inFlight === 0 &&
        e.lockedUntil <= now &&
        now - e.windowStart > REDEEM_LOCKOUT.windowMs
      ) {
        this.#entries.delete(k);
      }
    }
  }
}
