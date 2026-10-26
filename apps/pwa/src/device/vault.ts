// The device vault: enrollment-time tier choice, vault creation, unlock and lock
// (device-enrollment-spec rev 2.5 DN-1, DN-1a, §3.1, §11 EU-6). The crypto primitives live in
// @teacher-assistant/crypto (vault.ts); this module binds them to the passkey, the
// IndexedDB record and the platform gates.
//
//   - Tier P: unlock = a UV-required passkey assertion whose PRF output derives the KEK.
//     PRF output missing at unlock FAILS CLOSED (DeviceCannotUnlockError); a passphrase
//     is never consulted, so Tier P never falls back to Tier W.
//   - Tier W: unlock = the same UV-required assertion (a presence gate, not binding on
//     its own) plus KEK = HMAC(Kdev, Argon2id(passphrase, salt, ≥ MODERATE)). Wrong
//     passphrases start an on-device backoff (defence in depth; the real bound is the
//     Argon2id cost, on this device, because Kdev cannot leave it).
//
// The unlocked device holds signSk, boxSk and the record key in memory only. lock()
// zeroizes them; afterwards sign(), boxKeypair() and readGrant() throw
// DeviceLockedError, so no signing operation is possible while locked.
// The passphrase is a local factor: it is never stored, logged or sent anywhere.

import {
  type DeviceEnrollmentGrant,
  type DeviceKeypair,
  deriveTierPKek,
  deriveTierWKek,
  fromBase64,
  generateKdev,
  generateVaultSecrets,
  isAcceptablePassphrase,
  newVaultSalt,
  openGrantAtRest,
  openVault,
  type ParaEnrollmentGrant,
  sealGrantAtRest,
  sealVault,
  sign,
  sodiumReady,
  toBase64,
  utf8,
  VaultOpenError,
  type VaultSecrets,
  type VaultTier,
  zeroize,
  zeroizeVaultSecrets,
} from "@teacher-assistant/crypto";
import type { RequestSigner } from "@teacher-assistant/sync";
import { DeviceAlreadyEnrolledError, type DeviceRecord, type DeviceStore } from "./device-store.js";
import type { PasskeyPrfPort } from "./passkey-prf.js";
import {
  browserPlatform,
  isIosOutsideHomeScreen,
  type PlatformEnv,
  requestPersistentStorage,
} from "./platform.js";

export { DeviceAlreadyEnrolledError };

/** Thrown by any key operation on a locked device. */
export class DeviceLockedError extends Error {
  constructor() {
    super("the device is locked");
    this.name = "DeviceLockedError";
  }
}

/** Fail closed: this device cannot produce its unlock (Tier P PRF missing, Kdev gone, vault damaged). */
export class DeviceCannotUnlockError extends Error {
  constructor() {
    super("This device can't unlock anymore. Remove it from your other device and add it again.");
    this.name = "DeviceCannotUnlockError";
  }
}

export class NoDeviceError extends Error {
  constructor() {
    super("this device is not set up");
    this.name = "NoDeviceError";
  }
}

export class WeakPassphraseError extends Error {
  constructor() {
    super("Use at least 8 characters with letters and numbers, or at least 10 numbers.");
    this.name = "WeakPassphraseError";
  }
}

export class PassphraseRequiredError extends Error {
  constructor() {
    super("this device unlocks with a passphrase");
    this.name = "PassphraseRequiredError";
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase didn't match. Try again.");
    this.name = "WrongPassphraseError";
  }
}

/** Thrown while the on-device wait after repeated wrong passphrases is running. */
export class UnlockBackoffError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Too many tries. Wait, then try again.");
    this.name = "UnlockBackoffError";
  }
}

/** Thrown when an unlock starts while another is still running (one attempt at a time). */
export class UnlockInProgressError extends Error {
  constructor() {
    super("an unlock is already running");
    this.name = "UnlockInProgressError";
  }
}

/** iOS outside the Home Screen app: setup is refused (A-3). */
export class SetupNeedsHomeScreenError extends Error {
  constructor() {
    super("Add to Home Screen first");
    this.name = "SetupNeedsHomeScreenError";
  }
}

/** The grant the device keeps, tagged with the role it belongs to. */
export type StoredGrant =
  | { readonly role: "teacher"; readonly grant: DeviceEnrollmentGrant }
  | { readonly role: "para"; readonly grant: ParaEnrollmentGrant };

/** What the enrollment-time passkey probe found. Memory-only. */
export interface TierProbe {
  readonly credentialId: Uint8Array;
  readonly tier: VaultTier;
  /** Tier P: the PRF output from the test get(); consumed (zeroized) by createDeviceVault. */
  readonly prf: Uint8Array | null;
  /** BE/BS from the test get(): stored in the local record only (C4). */
  readonly credFlags: DeviceRecord["credFlags"];
}

const BACKOFF_FREE_TRIES = 2;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/** The wait after `count` consecutive wrong passphrases: none for 2, then 30 s doubling, capped at 15 min. */
export function unlockBackoffMs(count: number): number {
  if (count <= BACKOFF_FREE_TRIES) {
    return 0;
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** (count - BACKOFF_FREE_TRIES - 1), BACKOFF_CAP_MS);
}

/**
 * Enrollment step 1: create the passkey (UV required) under its display name — the
 * device's name, chosen before this call (DN-1a) — and run a test get() against that one
 * credential (C1). PRF output → Tier P; none → Tier W (C8). The tier is then fixed for
 * this device.
 */
export async function probeTier(
  passkey: PasskeyPrfPort,
  displayName: string,
  platform: PlatformEnv = browserPlatform(),
): Promise<TierProbe> {
  // A-3 before the ceremony: no passkey is created in an iOS Safari tab (no orphan credential).
  if (isIosOutsideHomeScreen(platform)) {
    throw new SetupNeedsHomeScreenError();
  }
  const { credentialId } = await passkey.create(displayName);
  const { prf, backupEligible, backedUp } = await passkey.assert(credentialId);
  return {
    credentialId,
    tier: prf === null ? "passphrase" : "prf",
    prf,
    credFlags: { be: backupEligible, bs: backedUp },
  };
}

function bindingOf(record: Pick<DeviceRecord, "tier" | "signPk" | "boxPk">) {
  return { tier: record.tier, signPk: fromBase64(record.signPk), boxPk: fromBase64(record.boxPk) };
}

function parseStoredGrant(bytes: Uint8Array): StoredGrant {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const value = parsed as { role?: unknown; grant?: Record<string, unknown> };
  const g = value.grant;
  if (typeof g !== "object" || g === null) {
    throw new VaultOpenError();
  }
  const strings = (...keys: string[]) => keys.every((k) => typeof g[k] === "string");
  if (value.role === "teacher" && strings("wrappedMasterKeyB64", "masterScopeTag", "masterDocId")) {
    return parsed as StoredGrant;
  }
  if (value.role === "para" && strings("wrappedDekB64", "scopeTag", "paraDocId")) {
    return parsed as StoredGrant;
  }
  throw new VaultOpenError();
}

/**
 * An unlocked device: the persistent relay identity and the box key, in memory only.
 * Implements RequestSigner, so a RelayClient built on it signs with the same key across
 * reloads and cannot sign once the device is locked.
 */
export class UnlockedDevice implements RequestSigner {
  readonly publicKey: Uint8Array;
  readonly #boxPk: Uint8Array;
  readonly role: "teacher" | "para";
  readonly #secrets: VaultSecrets;
  #locked = false;

  constructor(record: DeviceRecord, secrets: VaultSecrets) {
    this.publicKey = fromBase64(record.signPk);
    this.#boxPk = fromBase64(record.boxPk);
    this.role = record.role;
    this.#secrets = secrets;
  }

  /** Explicit lock state. Never infer "unlocked" from a keyring (hasScope is not proof of unlock). */
  get locked(): boolean {
    return this.#locked;
  }

  #assertUnlocked(): void {
    if (this.#locked) {
      throw new DeviceLockedError();
    }
  }

  sign(message: Uint8Array): Uint8Array {
    this.#assertUnlocked();
    return sign(message, this.#secrets.signSk);
  }

  /** The X25519 keypair that opens grants sealed to this device. Valid until lock(). */
  boxKeypair(): DeviceKeypair {
    this.#assertUnlocked();
    return { publicKey: this.#boxPk, privateKey: this.#secrets.boxSk };
  }

  /** The grant AEAD-sealed under the vault's record key (base64url), for the record. */
  #sealGrant(grant: StoredGrant): string {
    this.#assertUnlocked();
    if (grant.role !== this.role) {
      throw new Error("the grant is for the other role");
    }
    const plaintext = utf8(JSON.stringify(grant));
    try {
      return toBase64(sealGrantAtRest(this.#secrets.recordKey, this.publicKey, plaintext));
    } finally {
      zeroize(plaintext);
    }
  }

  /** Store the enrollment grant, AEAD-sealed under the vault's record key. */
  async storeGrant(store: DeviceStore, grant: StoredGrant): Promise<void> {
    const sealed = this.#sealGrant(grant);
    await store.update((record) => ({ ...record, grant: sealed }));
  }

  /** Read the stored grant (null when none yet). */
  async readGrant(store: DeviceStore): Promise<StoredGrant | null> {
    this.#assertUnlocked();
    const record = await store.load();
    if (record?.grant === undefined) {
      return null;
    }
    this.#assertUnlocked(); // a lock may have landed while the read was pending
    const plaintext = openGrantAtRest(
      this.#secrets.recordKey,
      this.publicKey,
      fromBase64(record.grant),
    );
    try {
      return parseStoredGrant(plaintext);
    } finally {
      zeroize(plaintext);
    }
  }

  /**
   * A paired device (F2): store the grant and mark setup done in ONE record write, so a
   * device never holds a grant while its stage still says the pairing is unfinished.
   */
  async storePairedGrant(store: DeviceStore, grant: StoredGrant, now: number): Promise<void> {
    const sealed = this.#sealGrant(grant);
    await store.update((record) => ({
      ...record,
      grant: sealed,
      enrolled: true,
      setupStage: { stage: "done", at: now },
    }));
  }

  /** Zeroize every private key buffer in place. Idempotent. */
  lock(): void {
    if (this.#locked) {
      return;
    }
    zeroizeVaultSecrets(this.#secrets);
    this.#locked = true;
  }
}

/** The tier's KEK at enrollment, plus the Tier W fields stored beside the vault. */
async function enrollmentKek(input: CreateVaultInput): Promise<{
  readonly kek: Uint8Array;
  readonly tierFields: Pick<DeviceRecord, "pwSalt" | "kdev">;
}> {
  const { probe } = input;
  if (probe.tier === "prf") {
    if (probe.prf === null) {
      throw new DeviceCannotUnlockError();
    }
    try {
      return { kek: deriveTierPKek(probe.prf), tierFields: {} };
    } finally {
      zeroize(probe.prf);
    }
  }
  const passphrase = input.passphrase;
  if (passphrase === undefined || !isAcceptablePassphrase(passphrase)) {
    throw new WeakPassphraseError();
  }
  const kdev = await generateKdev();
  const salt = newVaultSalt();
  return {
    kek: await deriveTierWKek(kdev, passphrase, salt),
    tierFields: { pwSalt: toBase64(salt), kdev },
  };
}

export interface CreateVaultInput {
  readonly store: DeviceStore;
  readonly probe: TierProbe;
  readonly role: "teacher" | "para";
  /** Required for Tier W; ignored for Tier P. */
  readonly passphrase?: string;
  readonly platform?: PlatformEnv;
  /** Clock for the setup stage's timestamp (A-8 resume window). */
  readonly now?: () => number;
  /** The first stage: `keys_created` for first setup (default), `pairing` for a paired device. */
  readonly stage?: "keys_created" | "pairing";
}

/**
 * Enrollment step 2: generate the device keys once, seal them into the vault under the
 * tier's KEK and write the one record. Refuses on iOS outside the Home Screen app, and
 * refuses to replace an existing record. Requests persistent storage; `persisted` says
 * whether the browser agreed (the UI warns when it did not).
 */
export async function createDeviceVault(
  input: CreateVaultInput,
): Promise<{ readonly device: UnlockedDevice; readonly persisted: boolean }> {
  await sodiumReady();
  const platform = input.platform ?? browserPlatform();
  const refuse = (err: Error): never => {
    if (input.probe.prf !== null) {
      zeroize(input.probe.prf); // the probe's PRF output never outlives a refused setup
    }
    throw err;
  };
  if (isIosOutsideHomeScreen(platform)) {
    refuse(new SetupNeedsHomeScreenError());
  }
  if ((await input.store.load()) !== null) {
    refuse(new DeviceAlreadyEnrolledError());
  }
  const { probe } = input;
  let kek: Uint8Array | null = null;
  let secrets: VaultSecrets | null = null;
  try {
    const enrollment = await enrollmentKek(input);
    kek = enrollment.kek;
    const tierFields = enrollment.tierFields;
    const generated = generateVaultSecrets();
    secrets = generated.secrets;
    const record: DeviceRecord = {
      version: 1,
      signPk: toBase64(generated.signPk),
      boxPk: toBase64(generated.boxPk),
      tier: probe.tier,
      credentialId: toBase64(probe.credentialId),
      credFlags: probe.credFlags,
      ...tierFields,
      vault: "",
      role: input.role,
      enrolled: false,
      setupStage: { stage: input.stage ?? "keys_created", at: (input.now ?? Date.now)() },
    };
    const vault = sealVault(kek, secrets, bindingOf(record));
    await input.store.create({ ...record, vault: toBase64(vault) });
    const persisted = await requestPersistentStorage(platform);
    return { device: new UnlockedDevice(record, secrets), persisted };
  } catch (err) {
    if (secrets !== null) {
      zeroizeVaultSecrets(secrets);
    }
    throw err;
  } finally {
    if (kek !== null) {
      zeroize(kek);
    }
  }
}

export interface UnlockInput {
  readonly store: DeviceStore;
  readonly passkey: PasskeyPrfPort;
  /** Tier W only. Never consulted for Tier P. */
  readonly passphrase?: string;
  readonly now?: () => number;
}

async function recordFailure(store: DeviceStore, now: number): Promise<void> {
  await store.update((record) => ({
    ...record,
    unlockFailures: { count: (record.unlockFailures?.count ?? 0) + 1, lastAt: now },
  }));
}

async function clearFailures(store: DeviceStore, record: DeviceRecord): Promise<void> {
  if (record.unlockFailures === undefined) {
    return;
  }
  await store.update(({ unlockFailures: _cleared, ...rest }) => rest);
}

/** Tier W: refuse (UnlockBackoffError) while the wait after wrong passphrases is running. */
async function enforceBackoff(
  store: DeviceStore,
  record: DeviceRecord,
  now: number,
): Promise<void> {
  const failures = record.unlockFailures;
  if (record.tier !== "passphrase" || failures === undefined) {
    return;
  }
  if (now < failures.lastAt) {
    // The clock moved backwards: restart the wait from now rather than from a future time.
    await store.update((r) => ({
      ...r,
      unlockFailures: { count: failures.count, lastAt: now },
    }));
  }
  const remaining = unlockBackoffMs(failures.count) - Math.max(0, now - failures.lastAt);
  if (remaining > 0) {
    throw new UnlockBackoffError(remaining);
  }
}

/** Tier W: KEK from Kdev + passphrase, then the vault. Counts a wrong passphrase. */
async function openTierW(
  input: UnlockInput,
  record: DeviceRecord,
  now: number,
): Promise<VaultSecrets> {
  if (record.kdev === undefined || record.pwSalt === undefined) {
    throw new DeviceCannotUnlockError();
  }
  const passphrase = input.passphrase;
  if (passphrase === undefined || passphrase.length === 0) {
    throw new PassphraseRequiredError();
  }
  if (!isAcceptablePassphrase(passphrase)) {
    await recordFailure(input.store, now);
    throw new WrongPassphraseError();
  }
  const kek = await deriveTierWKek(record.kdev, passphrase, fromBase64(record.pwSalt));
  try {
    return openVault(kek, fromBase64(record.vault), bindingOf(record));
  } catch (err) {
    if (err instanceof VaultOpenError) {
      await recordFailure(input.store, now);
      throw new WrongPassphraseError();
    }
    throw err;
  } finally {
    zeroize(kek);
  }
}

/** Tier P: KEK from the PRF output. Missing or wrong PRF fails closed — never Tier W. */
function openTierP(record: DeviceRecord, prf: Uint8Array | null): VaultSecrets {
  if (prf === null) {
    throw new DeviceCannotUnlockError();
  }
  let kek: Uint8Array;
  try {
    kek = deriveTierPKek(prf);
  } catch {
    throw new DeviceCannotUnlockError();
  } finally {
    zeroize(prf);
  }
  try {
    return openVault(kek, fromBase64(record.vault), bindingOf(record));
  } catch {
    throw new DeviceCannotUnlockError();
  } finally {
    zeroize(kek);
  }
}

let unlockRunning = false;

/**
 * Unlock: the passkey gesture, then the tier's KEK, then the vault. One attempt at a time,
 * so parallel guesses cannot all pass the backoff check before any failure is recorded.
 */
export async function unlockDevice(input: UnlockInput): Promise<UnlockedDevice> {
  if (unlockRunning) {
    throw new UnlockInProgressError();
  }
  unlockRunning = true;
  try {
    return await unlockOnce(input);
  } finally {
    unlockRunning = false;
  }
}

async function unlockOnce(input: UnlockInput): Promise<UnlockedDevice> {
  await sodiumReady();
  const record = await input.store.load();
  if (record === null) {
    throw new NoDeviceError();
  }
  const now = (input.now ?? Date.now)();
  await enforceBackoff(input.store, record, now);
  const { prf } = await input.passkey.assert(fromBase64(record.credentialId));
  let secrets: VaultSecrets;
  if (record.tier === "prf") {
    secrets = openTierP(record, prf);
  } else {
    if (prf !== null) {
      zeroize(prf); // Tier W ignores PRF output; the tier never changes after enrollment
    }
    secrets = await openTierW(input, record, now);
    try {
      await clearFailures(input.store, record);
    } catch (err) {
      zeroizeVaultSecrets(secrets);
      throw err;
    }
  }
  return new UnlockedDevice(record, secrets);
}
