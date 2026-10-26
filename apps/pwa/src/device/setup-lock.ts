// One setup at a time per browser profile (EU-8, TEACH-75: two setups at the same time).
//
// A device is one storage partition with ONE device record. Two windows of the same
// profile could otherwise both run first setup or pairing: both would create a passkey,
// and the second would fail at the record write (an orphan passkey in her password
// manager), or a window opening later would wipe a pairing another window is still
// running. So setup and pairing hold an exclusive Web Lock from the passkey's creation
// until they finish or stop, and a window that finds the lock held leaves the record alone.
//
// Web Locks are released by the browser when a window closes or crashes, so a held lock
// always means a live window. Where the API is missing (it exists in every browser the
// app supports), acquire always succeeds and nothing counts as held elsewhere.

const SETUP_LOCK = "ta-device-setup";

/** Release a held setup lock. Idempotent. */
export type ReleaseSetupLock = () => void;

export interface SetupLockPort {
  /** Take the lock if no window holds it; null when another window does. */
  tryAcquire(): Promise<ReleaseSetupLock | null>;
  /** True when some window currently holds the lock. */
  held(): Promise<boolean>;
}

/** Thrown when setup or pairing is already running in another window of this app. */
export class SetupBusyError extends Error {
  constructor() {
    super("setup is running in another window");
    this.name = "SetupBusyError";
  }
}

export function browserSetupLock(
  locks: LockManager | undefined = globalThis.navigator?.locks,
): SetupLockPort {
  if (locks === undefined) {
    return { tryAcquire: () => Promise.resolve(() => {}), held: () => Promise.resolve(false) };
  }
  return {
    tryAcquire: () =>
      new Promise<ReleaseSetupLock | null>((resolve, reject) => {
        locks
          .request(SETUP_LOCK, { ifAvailable: true }, (lock) => {
            if (lock === null) {
              resolve(null);
              return undefined;
            }
            // Held until release() settles this promise (or the window goes away).
            return new Promise<void>((release) => {
              let released = false;
              resolve(() => {
                if (!released) {
                  released = true;
                  release();
                }
              });
            });
          })
          .catch(reject);
      }),
    held: async () => {
      const state = await locks.query();
      return (state.held ?? []).some((l) => l.name === SETUP_LOCK);
    },
  };
}

/** An in-process lock for tests: the same rules, shared by every port built on one instance. */
export function memorySetupLock(): SetupLockPort {
  let holder: object | null = null;
  return {
    tryAcquire: () => {
      if (holder !== null) {
        return Promise.resolve(null);
      }
      const token = {};
      holder = token;
      return Promise.resolve(() => {
        if (holder === token) {
          holder = null;
        }
      });
    },
    held: () => Promise.resolve(holder !== null),
  };
}
