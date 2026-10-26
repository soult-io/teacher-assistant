// The one seam between the App and the device layer (device-enrollment-spec rev 2.7 §3.1,
// §4.1, §4.2). The App never touches keys: it asks this port where the device stands, runs
// first setup and pairing through it, unlocks through it, and gets the session material
// from it. The browser implementation binds the real IndexedDB record, WebAuthn and the
// relay; component tests supply a crypto-free fake (libsodium does not run under jsdom).

import type { VaultTier } from "@teacher-assistant/crypto";
import { fetchTransport, type PersistenceAdapter, type Transport } from "@teacher-assistant/sync";
import { defaultPersistence, type TeacherVault } from "../data/session.js";
import { DeviceStore } from "./device-store.js";
import { type DeviceStatus, FirstSetup, readDeviceStatus, type RedeemStep } from "./first-setup.js";
import {
  type ApproveOutcome,
  type CodeOutcome,
  type JoinPollOutcome,
  type OpenOutcome,
  PairingApprover,
  PairingJoin,
  type PairingSession,
  type PollOutcome,
  type PostOutcome,
} from "./pairing.js";
import {
  BrowserPasskeyPrf,
  type DeviceLabel,
  type PasskeyPrfPort,
  type TeacherDeviceLabel,
} from "./passkey-prf.js";
import { browserSetupLock, type SetupLockPort } from "./setup-lock.js";
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
  /** The run is over (done, or a lock): release the one-setup-at-a-time lock. */
  end(): void;
  /** The unlocked device, once the vault exists. */
  readonly device: DeviceHandle;
}

/** Pairing on the trusted device, A0–A4 (pairing.ts PairingApprover). */
export interface ApprovePort {
  open(): Promise<OpenOutcome>;
  poll(): Promise<PollOutcome>;
  checkCode(typed: string): CodeOutcome;
  /** The fresh unlock ceremony, then the grant. Throws on a failed unlock (retry on A3). */
  approve(passphrase?: string): Promise<ApproveOutcome>;
  abandon(): void;
  /** True once the session can do nothing more (approve() ended it, or abandon()). */
  readonly over: boolean;
}

/** Pairing on the new device, B1–B4 (pairing.ts PairingJoin). */
export interface JoinPort {
  begin(code: string): boolean;
  readonly label: DeviceLabel | undefined;
  setLabel(label: DeviceLabel): void;
  createPasskey(): Promise<VaultTier>;
  sealVault(passphrase?: string): Promise<{ readonly persisted: boolean; readonly code: string }>;
  postRequest(): Promise<PostOutcome>;
  poll(): Promise<JoinPollOutcome>;
  discard(): Promise<void>;
  /** The unlocked device, once the vault exists. */
  readonly device: DeviceHandle;
}

export interface DevicePort {
  status(): Promise<DeviceStatus>;
  /** A setup run: fresh (no device yet), or resumed around the device the unlock opened. */
  setup(device?: DeviceHandle): SetupPort;
  /** Add this (new) device to her account by pairing with a trusted one. */
  pair(): JoinPort;
  /** Add another device from this unlocked, set-up one; the session writes the name. */
  approver(device: DeviceHandle, session: PairingSession): ApprovePort;
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
  readonly setupLock?: SetupLockPort;
}

/** The real port: IndexedDB device record, browser WebAuthn, the same-origin relay. */
export function browserDevicePort(options: BrowserDevicePortOptions): DevicePort {
  const store = options.store ?? new DeviceStore();
  const passkey = options.passkey ?? new BrowserPasskeyPrf();
  const transport = options.transport ?? fetchTransport(options.relayBaseUrl ?? "");
  const persistence = options.persistence ?? defaultPersistence();
  const setupLock = options.setupLock ?? browserSetupLock();
  const asDevice = (handle: DeviceHandle): UnlockedDevice => handle as UnlockedDevice;
  return {
    persistence,
    status: () => readDeviceStatus(store, Date.now(), setupLock),
    setup: (device) =>
      new FirstSetup(
        { store, passkey, transport, persistence, synthetic: options.synthetic, setupLock },
        device === undefined ? null : asDevice(device),
      ),
    pair: () => new PairingJoin({ store, passkey, transport, setupLock }),
    approver: (device, session) =>
      new PairingApprover({ store, passkey, transport, device: asDevice(device), session }),
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
