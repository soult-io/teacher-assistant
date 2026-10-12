// Rate-limiting + lockout (H-PUB-5). Pure, deterministic state machine with an
// injected clock so it is fully unit-testable. The caller guards auth/enrollment
// on BOTH a per-account key and a per-IP key (guardAll below); a lockout on
// either blocks the attempt. NPM/WAF filtering sits in front of this as a second
// layer — this is the application-level backstop.

export interface ThrottlePolicy {
  /** Failures within the window before lockout. */
  readonly maxFailures: number;
  /** Fixed window for counting failures (ms); the count resets once it elapses. */
  readonly windowMs: number;
  /** Lockout duration once maxFailures is reached (ms). */
  readonly lockoutMs: number;
}

export const DEFAULT_THROTTLE: ThrottlePolicy = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
};

export interface ThrottleDecision {
  readonly allowed: boolean;
  /** Milliseconds until the caller may retry (0 when allowed). */
  readonly retryAfterMs: number;
}

interface Entry {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export class AuthThrottle {
  readonly #entries = new Map<string, Entry>();
  readonly #policy: ThrottlePolicy;
  readonly #now: () => number;

  constructor(policy: ThrottlePolicy = DEFAULT_THROTTLE, now: () => number = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  /** Whether an attempt on `key` is currently allowed. */
  check(key: string): ThrottleDecision {
    const e = this.#entries.get(key);
    if (e === undefined) {
      return { allowed: true, retryAfterMs: 0 };
    }
    const now = this.#now();
    if (e.lockedUntil > now) {
      return { allowed: false, retryAfterMs: e.lockedUntil - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Check several keys (e.g. account + IP); blocked if ANY is locked out. */
  guardAll(keys: readonly string[]): ThrottleDecision {
    let worst: ThrottleDecision = { allowed: true, retryAfterMs: 0 };
    for (const key of keys) {
      const d = this.check(key);
      if (!d.allowed && d.retryAfterMs > worst.retryAfterMs) {
        worst = d;
      }
    }
    return worst;
  }

  /** Record a failed attempt on `key`; locks out at maxFailures within the window. */
  recordFailure(key: string): void {
    const now = this.#now();
    const existing = this.#entries.get(key);
    if (existing !== undefined && existing.lockedUntil > now) {
      return; // already locked out — a failure changes nothing (caller should have checked first)
    }
    // Start a fresh window on first failure or after the window elapsed.
    let e = existing;
    if (e === undefined || now - e.windowStart > this.#policy.windowMs) {
      e = { failures: 0, windowStart: now, lockedUntil: 0 };
      this.#entries.set(key, e);
    }
    e.failures += 1;
    if (e.failures >= this.#policy.maxFailures) {
      e.lockedUntil = now + this.#policy.lockoutMs;
    }
  }

  /** Record a success on `key`; clears its failure/lockout state. */
  recordSuccess(key: string): void {
    this.#entries.delete(key);
  }
}
