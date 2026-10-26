// A crypto-free DevicePort for component tests (libsodium does not run under jsdom). By
// default it is a finished teacher device (Style P): unlock hands back a lockable handle
// and the session material is a placeholder the fake bootstraps ignore. Tests that drive
// first setup pass their own SetupPort.

import type { VaultTier } from "@teacher-assistant/crypto";
import { InMemoryPersistence } from "@teacher-assistant/sync";
import type { TeacherVault } from "../data/session.js";
import type { DeviceHandle, DevicePort, SetupPort } from "../device/device-port.js";
import type { DeviceStatus } from "../device/first-setup.js";

export interface FakeDevice extends DevicePort {
  /** How many times a device handle was locked. */
  readonly locks: () => number;
  /** The passphrases unlock() was called with (Style W). */
  readonly unlockedWith: (string | undefined)[];
}

export function fakeDevicePort(
  options: {
    readonly status?: DeviceStatus;
    readonly tier?: VaultTier;
    readonly setup?: (device?: DeviceHandle) => SetupPort;
    readonly unlock?: (passphrase?: string) => Promise<DeviceHandle>;
  } = {},
): FakeDevice {
  let locks = 0;
  const unlockedWith: (string | undefined)[] = [];
  const handle = (): DeviceHandle => {
    let locked = false;
    return {
      get locked() {
        return locked;
      },
      lock: () => {
        if (!locked) {
          locks += 1;
        }
        locked = true;
      },
    };
  };
  return {
    locks: () => locks,
    unlockedWith,
    persistence: new InMemoryPersistence(),
    status: () =>
      Promise.resolve(
        options.status ?? { kind: "enrolled", tier: options.tier ?? "prf", stage: "done" },
      ),
    setup:
      options.setup ??
      (() => {
        throw new Error("no setup in this fake");
      }),
    unlock: (passphrase) => {
      unlockedWith.push(passphrase);
      return options.unlock?.(passphrase) ?? Promise.resolve(handle());
    },
    teacherVault: () => Promise.resolve({} as TeacherVault),
  };
}
