// The one seam between the App and the device layer (device-enrollment-spec rev 2.5 §3.1,
// §4.1). The App never touches keys: it asks this port where the device stands, runs first
// setup through it, unlocks through it, and gets the session material from it. The browser
// implementation binds the real IndexedDB record, WebAuthn and the relay; component tests
// supply a crypto-free fake (libsodium does not run under jsdom).

import type { VaultTier } from "@teacher-assistant/crypto";
import { fetchTransport, type PersistenceAdapter, type Transport } from "@teacher-assistant/sync";
import { defaultPersistence, type TeacherVault } from "../data/session.js";
import { DeviceStore } from "./device-store.js";
import { type DeviceStatus, FirstSetup, readDeviceStatus, type RedeemStep } from "./first-setup.js";
import { BrowserPasskeyPrf, type PasskeyPrfPort, type TeacherDeviceLabel } from "./passkey-prf.js";
import { unlockDevice, type UnlockedDevice } from "./vault.js";

/** What the App holds while the device is unlocked: lock() zeroizes every device key. */
export interface DeviceHandle {
  readonly locked: boolean;
  lock(): void;
}

/** First setup as the screens drive it (first-setup.ts FirstSetup). */
export interface SetupPort {
  readonly label: TeacherDeviceLabel | undefined;
  setLabel(label: TeacherDeviceLabel): void;
  createPasskey(): Promise<VaultTier>;
  sealVault(passphrase?: string): Promise<{ readonly persisted: boolean }>;
  redeem(code: string): Promise<RedeemStep>;
  finish(): Promise<void>;
  issueRecoveryCode(): Promise<string>;
  confirmRecoveryCode(typed: string): Promise<boolean>;
  discardRecoveryCode(): void;
  /** The unlocked device, once the vault exists. */
  readonly device: DeviceHandle;
}

export interface DevicePort {
  status(): Promise<DeviceStatus>;
  /** A setup run: fresh (no device yet), or resumed around the device the unlock opened. */
  setup(device?: DeviceHandle): SetupPort;
  /** The unlock ceremony: the passkey (UV) and, on Tier W, the passphrase. */
  unlock(passphrase?: string): Promise<DeviceHandle>;
  /** The teacher session's material from an unlocked, set-up device. */
  teacherVault(device: DeviceHandle): Promise<TeacherVault>;
  /** The ciphertext store the session and setup share. */
  readonly persistence: PersistenceAdapter;
}

export interface BrowserDevicePortOptions {
  readonly synthetic: boolean;
  readonly relayBaseUrl?: string;
  readonly store?: DeviceStore;
  readonly passkey?: PasskeyPrfPort;
  readonly transport?: Transport;
  readonly persistence?: PersistenceAdapter;
}

/** The real port: IndexedDB device record, browser WebAuthn, the same-origin relay. */
export function browserDevicePort(options: BrowserDevicePortOptions): DevicePort {
  const store = options.store ?? new DeviceStore();
  const passkey = options.passkey ?? new BrowserPasskeyPrf();
  const transport = options.transport ?? fetchTransport(options.relayBaseUrl ?? "");
  const persistence = options.persistence ?? defaultPersistence();
  const asDevice = (handle: DeviceHandle): UnlockedDevice => handle as UnlockedDevice;
  return {
    persistence,
    status: () => readDeviceStatus(store),
    setup: (device) =>
      new FirstSetup(
        { store, passkey, transport, persistence, synthetic: options.synthetic },
        device === undefined ? null : asDevice(device),
      ),
    unlock: (passphrase) =>
      unlockDevice({ store, passkey, ...(passphrase === undefined ? {} : { passphrase }) }),
    teacherVault: async (handle) => {
      const device = asDevice(handle);
      const stored = await device.readGrant(store);
      if (stored?.role !== "teacher") {
        throw new Error("this device holds no teacher grant");
      }
      return { signer: device, boxKeypair: device.boxKeypair(), grant: stored.grant };
    },
  };
}
