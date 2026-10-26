// The device record at rest (device-enrollment-spec rev 2.5 §3.1, §13): IndexedDB database
// `ta-device`, object store `device`, ONE record. Everything in it is non-secret or
// ciphertext:
//   - signPk / boxPk / credentialId / pwSalt: public or non-secret values;
//   - vault: the one AEAD wrap of the device private keys under the KEK;
//   - grant: the enrollment grant, AEAD-sealed under a key that exists only in the vault;
//   - kdev (Tier W only): the NON-EXTRACTABLE WebCrypto HMAC key. It is the only key kept
//     at rest; structured clone stores the CryptoKey handle, never its bytes;
//   - credFlags: the passkey's BE/BS flags, local only — no relay body carries them (C4);
//   - setupStage: how far first setup got — the stage, the mode and when it was written,
//     nothing else. Neither the setup code nor the recovery code is ever stored (A-8).
// The KEK, the PRF output, the Argon2id output and every private key are never stored.
//
// The tier and both public keys are fixed at enrollment: update() refuses to change them
// (changing tier means re-enrolling, a new identity), and create() refuses to replace an
// existing record (keys are never regenerated).

import type { VaultTier } from "@teacher-assistant/crypto";
import { openSingleStoreDb, promisifyRequest, transactionDone } from "../data/idb.js";

export const DEVICE_DB_NAME = "ta-device";
const STORE = "device";
const RECORD_KEY = "self";
const DB_VERSION = 1;

/**
 * First-setup progress (spec §13 "Local setup state"). Written before each network step.
 * `pairing`: a device being added by pairing (F2, EU-8) whose grant has not arrived. The
 * pairing secret lives in memory only, so this stage never resumes: once no window is
 * running the pairing, the next open wipes it.
 */
export type SetupStageName =
  | "keys_created"
  | "pairing"
  | "redeemed"
  | "scopes_granted"
  | "recovery_pending"
  | "done";

export interface SetupStage {
  readonly stage: SetupStageName;
  /** From the redeem response, once known. */
  readonly mode?: "first" | "recovery";
  /** When this stage was written (ms since epoch). */
  readonly at: number;
}

export interface DeviceRecord {
  readonly version: 1;
  /** Ed25519 public key — the relay identity (base64url). */
  readonly signPk: string;
  /** X25519 public key — grants are sealed to it (base64url). */
  readonly boxPk: string;
  readonly tier: VaultTier;
  /** The passkey credential id (base64url). Not PII. get() allows only this id (C1). */
  readonly credentialId: string;
  /** BE/BS (backup eligible / backed up) read at enrollment. Local only, never sent (C4). */
  readonly credFlags: { readonly be: boolean; readonly bs: boolean };
  /** Tier W Argon2id salt (base64url). */
  readonly pwSalt?: string;
  /** Tier W: the non-extractable HMAC key. */
  readonly kdev?: CryptoKey;
  /** AEAD_KEK(signSk ‖ boxSk ‖ recordKey) (base64url). */
  readonly vault: string;
  /** The enrollment grant, AEAD-sealed under the vault's record key (base64url). */
  readonly grant?: string;
  readonly role: "teacher" | "para";
  /** Relay-side enrollment completed. */
  readonly enrolled: boolean;
  /** Wrong-passphrase count for the on-device backoff (Tier W). Non-secret. */
  readonly unlockFailures?: { readonly count: number; readonly lastAt: number };
  /** First-setup progress; absent on a device that was never set up through F1. */
  readonly setupStage?: SetupStage;
}

/** Thrown when an update would change a field fixed at enrollment. */
export class DeviceRecordImmutableError extends Error {
  constructor(field: string) {
    super(`device record field ${field} is fixed at enrollment`);
    this.name = "DeviceRecordImmutableError";
  }
}

/** Thrown when a record already exists: a device is enrolled once. */
export class DeviceAlreadyEnrolledError extends Error {
  constructor() {
    super("this device is already set up");
    this.name = "DeviceAlreadyEnrolledError";
  }
}

const IMMUTABLE = ["tier", "signPk", "boxPk", "credentialId", "credFlags", "kdev", "role"] as const;

/** The one device record in IndexedDB. */
export class DeviceStore {
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory | undefined = globalThis.indexedDB) {
    if (factory === undefined) {
      throw new Error("IndexedDB is unavailable in this environment");
    }
    this.#factory = factory;
  }

  #database(): Promise<IDBDatabase> {
    this.#db ??= openSingleStoreDb(this.#factory, DEVICE_DB_NAME, DB_VERSION, STORE).then(
      (db) => {
        // Yield to a delete or upgrade from elsewhere (a wipe, another tab); reopen on next use.
        db.onversionchange = () => {
          db.close();
          this.#db = null;
        };
        return db;
      },
      (err: unknown) => {
        this.#db = null; // a failed open is retried on the next call, not cached
        throw err;
      },
    );
    return this.#db;
  }

  async load(): Promise<DeviceRecord | null> {
    const db = await this.#database();
    const tx = db.transaction(STORE, "readonly");
    const value = await promisifyRequest<unknown>(tx.objectStore(STORE).get(RECORD_KEY));
    return (value as DeviceRecord | undefined) ?? null;
  }

  /** Write the first record. Refuses (DeviceAlreadyEnrolledError) if one exists. */
  async create(record: DeviceRecord): Promise<void> {
    const db = await this.#database();
    const tx = db.transaction(STORE, "readwrite");
    const added = promisifyRequest(tx.objectStore(STORE).add(record, RECORD_KEY));
    try {
      await Promise.all([added, transactionDone(tx)]);
    } catch (err) {
      if (err instanceof DOMException && err.name === "ConstraintError") {
        throw new DeviceAlreadyEnrolledError();
      }
      throw err;
    }
  }

  /**
   * Delete the record: the vault, Kdev and the grant go with it (A-8: an unfinished setup
   * past the code's 24 h). Afterwards this device is not set up.
   */
  async wipe(): Promise<void> {
    const db = await this.#database();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(RECORD_KEY);
    await transactionDone(tx);
  }

  /** Read-modify-write in one transaction. Refuses changes to fields fixed at enrollment. */
  async update(change: (record: DeviceRecord) => DeviceRecord): Promise<DeviceRecord> {
    const db = await this.#database();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const committed = transactionDone(tx);
    const current = (await promisifyRequest<unknown>(store.get(RECORD_KEY))) as
      | DeviceRecord
      | undefined;
    if (current === undefined) {
      tx.abort();
      await committed.catch(() => {});
      throw new Error("no device record");
    }
    const next = change(current);
    for (const field of IMMUTABLE) {
      if (next[field] !== current[field]) {
        tx.abort();
        await committed.catch(() => {});
        throw new DeviceRecordImmutableError(field);
      }
    }
    store.put(next, RECORD_KEY);
    await committed;
    return next;
  }
}
