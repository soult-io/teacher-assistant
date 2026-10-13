// Auto-lock (device-enrollment-spec rev 2.4 §3.1, §11 EU-6 N2, §13 A-10). Fires on
// whichever comes first:
//   - idle: no user input for N (default 10 min, FERPA ceiling 15 min);
//   - hidden page: hidden for more than M (default 2 min, FERPA ceiling 5 min);
//   - lockNow(): the explicit Lock action.
//
// iOS suspends background timers, so a setTimeout alone may never fire. On every
// return to visible the WALL CLOCK is compared against the hidden timestamp and the last
// input, and the lock runs synchronously inside the visibilitychange dispatch — before
// the app renders anything.
//
// The idle warning shows at N − 1 min. Showing it never resets or extends the timer
// (A-10); only real input does. The hidden timer has no warning.
//
// AutoLock only decides WHEN. The onLock callback does the locking: destroy every
// keyring (para included), lock the device vault and drop the session.

export type LockReason = "idle" | "hidden" | "manual";

/** The slice of `document` auto-lock listens to (injected in tests). */
export interface AutoLockSurface extends EventTarget {
  readonly visibilityState: DocumentVisibilityState;
}

export interface AutoLockOptions {
  readonly surface: AutoLockSurface;
  readonly onLock: (reason: LockReason) => void;
  readonly onWarn?: () => void;
  readonly onWarnClear?: () => void;
  readonly idleMs?: number;
  readonly hiddenMs?: number;
}

const MINUTE = 60_000;
export const IDLE_DEFAULT_MS = 10 * MINUTE;
export const IDLE_CEILING_MS = 15 * MINUTE;
export const HIDDEN_DEFAULT_MS = 2 * MINUTE;
export const HIDDEN_CEILING_MS = 5 * MINUTE;
const WARN_BEFORE_MS = MINUTE;

// Real user input. Pointer movement alone is not input: a hover must not keep it open.
const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

export class AutoLock {
  readonly idleMs: number;
  readonly hiddenMs: number;
  readonly #options: AutoLockOptions;
  #lastInput = 0;
  #hiddenAt: number | null = null;
  #warnTimer: ReturnType<typeof setTimeout> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  #warned = false;
  #started = false;
  #locked = false;

  constructor(options: AutoLockOptions) {
    const idleMs = options.idleMs ?? IDLE_DEFAULT_MS;
    const hiddenMs = options.hiddenMs ?? HIDDEN_DEFAULT_MS;
    if (!(idleMs > WARN_BEFORE_MS && idleMs <= IDLE_CEILING_MS)) {
      throw new RangeError("idle auto-lock must be more than 1 and at most 15 minutes");
    }
    if (!(hiddenMs > 0 && hiddenMs <= HIDDEN_CEILING_MS)) {
      throw new RangeError("hidden-page auto-lock must be at most 5 minutes");
    }
    this.idleMs = idleMs;
    this.hiddenMs = hiddenMs;
    this.#options = options;
  }

  get locked(): boolean {
    return this.#locked;
  }

  start(): void {
    if (this.#started || this.#locked) {
      return;
    }
    this.#started = true;
    const { surface } = this.#options;
    for (const type of INPUT_EVENTS) {
      surface.addEventListener(type, this.#onInput, { capture: true, passive: true });
    }
    surface.addEventListener("visibilitychange", this.#onVisibility, { capture: true });
    this.#lastInput = Date.now();
    if (surface.visibilityState === "hidden") {
      this.#onHidden();
    }
    this.#scheduleIdle();
  }

  stop(): void {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    const { surface } = this.#options;
    for (const type of INPUT_EVENTS) {
      surface.removeEventListener(type, this.#onInput, { capture: true });
    }
    surface.removeEventListener("visibilitychange", this.#onVisibility, { capture: true });
    clearTimeout(this.#warnTimer);
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#hiddenTimer);
  }

  /** The explicit Lock action. */
  lockNow(): void {
    this.#lock("manual");
  }

  #lock(reason: LockReason): void {
    if (this.#locked) {
      return;
    }
    this.#locked = true;
    this.stop();
    this.#options.onLock(reason);
  }

  readonly #onInput = (): void => {
    if (this.#locked) {
      return;
    }
    // Timers can pause while the page stays visible (a sleeping laptop): the first input
    // after a long idle must lock, not reset the clock.
    if (Date.now() - this.#lastInput >= this.idleMs) {
      this.#lock("idle");
      return;
    }
    this.#lastInput = Date.now();
    if (this.#warned) {
      this.#warned = false;
      this.#options.onWarnClear?.();
    }
    this.#scheduleIdle();
  };

  #scheduleIdle(): void {
    clearTimeout(this.#warnTimer);
    clearTimeout(this.#idleTimer);
    const elapsed = Date.now() - this.#lastInput;
    const toWarn = this.idleMs - WARN_BEFORE_MS - elapsed;
    if (toWarn > 0) {
      this.#warnTimer = setTimeout(this.#onWarnDue, toWarn);
    }
    this.#idleTimer = setTimeout(this.#onIdleDue, Math.max(0, this.idleMs - elapsed));
  }

  // The warning reads the clock but never touches #lastInput (A-10).
  readonly #onWarnDue = (): void => {
    if (this.#locked || this.#warned) {
      return;
    }
    this.#warned = true;
    this.#options.onWarn?.();
  };

  readonly #onIdleDue = (): void => {
    if (Date.now() - this.#lastInput >= this.idleMs) {
      this.#lock("idle");
    } else {
      this.#scheduleIdle(); // a timer that fired early; re-arm from the wall clock
    }
  };

  #onHidden(): void {
    this.#hiddenAt = Date.now();
    clearTimeout(this.#hiddenTimer);
    this.#hiddenTimer = setTimeout(() => this.#lock("hidden"), this.hiddenMs);
  }

  readonly #onVisibility = (): void => {
    if (this.#locked) {
      return;
    }
    if (this.#options.surface.visibilityState === "hidden") {
      this.#onHidden();
      return;
    }
    clearTimeout(this.#hiddenTimer);
    const now = Date.now();
    const hiddenAt = this.#hiddenAt;
    this.#hiddenAt = null;
    // Synchronous wall-clock checks: lock before anything renders (timers may never have run).
    if (hiddenAt !== null && now - hiddenAt >= this.hiddenMs) {
      this.#lock("hidden");
      return;
    }
    if (now - this.#lastInput >= this.idleMs) {
      this.#lock("idle");
      return;
    }
    this.#scheduleIdle();
  };
}
