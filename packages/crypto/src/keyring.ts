// The keyring — where least-privilege lives (architecture §1.4). Authorization is
// NOT a server check or a UI toggle; it is key possession. A keyring can decrypt
// a record only if it holds the key named by the record's scope_tag. The para
// keyring is handed ONLY its period's DEK, so it is cryptographically incapable
// of decrypting a goal-definition blob (master scope) or any other period.
//
// Keys live in a PRIVATE field (`#keys`) so they never appear in JSON.stringify,
// structured clone, a log line, or the wire. The only key material that ever
// leaves a keyring does so WRAPPED (sealed to a device, or recovery-wrapped).

import type { RecordEnvelope, ScopeTag } from "@teacher-assistant/schema";
import type { MasterKey, PeriodKey } from "./keys.js";
import { decryptWithKey, encryptWithKey } from "./records.js";
import { aeadDecrypt, aeadEncrypt, sealTo } from "./sodium.js";

/** Thrown when a keyring is asked to use a scope it does not hold (the para boundary). */
export class NoKeyForScopeError extends Error {
  constructor(readonly scopeTag: ScopeTag) {
    // Message references the opaque scope tag only — never a period name or student payload.
    super(`keyring holds no key for scope ${scopeTag}`);
    this.name = "NoKeyForScopeError";
  }
}

/**
 * A set of symmetric keys addressed by opaque scope tag. Holds keys privately;
 * exposes encrypt/decrypt but never the keys themselves.
 */
export class Keyring {
  readonly #keys = new Map<ScopeTag, Uint8Array>();

  /** Register a symmetric key under its scope tag. */
  protected putScopeKey(scopeTag: ScopeTag, key: Uint8Array): void {
    this.#keys.set(scopeTag, key);
  }

  /** The scope tags this keyring can use. Opaque ids only — safe to expose. */
  scopes(): readonly ScopeTag[] {
    return [...this.#keys.keys()];
  }

  /** Whether this keyring holds the key for a scope. */
  hasScope(scopeTag: ScopeTag): boolean {
    return this.#keys.has(scopeTag);
  }

  #keyFor(scopeTag: ScopeTag): Uint8Array {
    const key = this.#keys.get(scopeTag);
    if (key === undefined) {
      throw new NoKeyForScopeError(scopeTag);
    }
    return key;
  }

  /** Encrypt a record payload under the key named by `env.scope_tag`. */
  encryptRecord(env: RecordEnvelope, plaintext: Uint8Array): Uint8Array {
    return encryptWithKey(this.#keyFor(env.scope_tag), env, plaintext);
  }

  /**
   * Decrypt a record blob. Throws NoKeyForScopeError if this keyring does not
   * hold the scope's key (the para least-privilege boundary), or a sodium error
   * if the ciphertext/AAD do not verify.
   */
  decryptRecord(env: RecordEnvelope, blob: Uint8Array): Uint8Array {
    return decryptWithKey(this.#keyFor(env.scope_tag), env, blob);
  }

  /** Seal (wrap) a scope's key to a device public key. Throws if the scope is absent. */
  sealScopeKeyToDevice(scopeTag: ScopeTag, devicePublicKey: Uint8Array): Uint8Array {
    return sealTo(this.#keyFor(scopeTag), devicePublicKey);
  }

  /**
   * Encrypt an opaque CRDT update under a scope's key, binding caller-supplied
   * context (e.g. the opaque doc id) as AEAD additional data so a blob cannot be
   * replayed under a different stream. Throws NoKeyForScopeError if the scope is
   * not held — the para boundary applies to sync updates too.
   */
  sealUpdate(scopeTag: ScopeTag, contextAad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return aeadEncrypt(this.#keyFor(scopeTag), plaintext, contextAad);
  }

  /** Decrypt an opaque CRDT update. Throws if the scope is absent or the AAD/tag mismatch. */
  openUpdate(scopeTag: ScopeTag, contextAad: Uint8Array, blob: Uint8Array): Uint8Array {
    return aeadDecrypt(this.#keyFor(scopeTag), blob, contextAad);
  }

  /** Keys are withheld from serialisation — only opaque scope tags are exposed. */
  toJSON(): { readonly scopes: readonly ScopeTag[]; readonly keys: "[withheld]" } {
    return { scopes: this.scopes(), keys: "[withheld]" };
  }
}

/**
 * The teacher keyring: holds the master key (under its master scope tag) plus
 * every Period DEK. Adds the master-key-only operations (enrollment wrapping,
 * recovery export) while keeping MK private.
 */
export class TeacherKeyring extends Keyring {
  constructor(
    readonly masterScopeTag: ScopeTag,
    mk: MasterKey,
  ) {
    super();
    // MK is held once, in the parent's private key map under the master scope
    // tag — no second long-lived reference (the point of the key-hygiene design).
    this.putScopeKey(masterScopeTag, mk);
  }

  /** Add a Period DEK to the teacher keyring. */
  addPeriodKey(periodKey: PeriodKey): void {
    this.putScopeKey(periodKey.scopeTag, periodKey.dek);
  }

  /** Seal the master key to a new teacher device's public key (enrollment). Returns ciphertext. */
  sealMasterKeyToDevice(devicePublicKey: Uint8Array): Uint8Array {
    return this.sealScopeKeyToDevice(this.masterScopeTag, devicePublicKey);
  }
}

/**
 * The para keyring: a plain Keyring carrying ONLY the assigned period's DEK(s).
 * It has no master key and no other period key, so goal definitions and other
 * periods are undecryptable by construction.
 */
export class ParaKeyring extends Keyring {
  constructor(periodKeys: readonly PeriodKey[]) {
    super();
    for (const pk of periodKeys) {
      this.putScopeKey(pk.scopeTag, pk.dek);
    }
  }
}
