// The keyring — where least-privilege lives (architecture §1.4). Authorization is
// NOT a server check or a UI toggle; it is key possession. A keyring can decrypt
// a record only if it holds the key named by the record's scope_tag. The para
// keyring is handed ONLY its period's DEK, so it is cryptographically incapable
// of decrypting a goal-definition blob (master scope) or any other period.
//
// Keys live in a PRIVATE field (`#keys`) so they never appear in JSON.stringify,
// structured clone, a log line, or the wire. The only key material that ever
// leaves a keyring does so WRAPPED (sealed to a device, wrapped under MK, or
// recovery-wrapped).
//
// Ownership: a keyring TAKES OWNERSHIP of every key buffer handed to it (no copy, so
// no second long-lived reference). destroy() zeroizes those buffers in place and
// clears the map; any later use throws KeyringDestroyedError. This is the auto-lock
// primitive (device-enrollment-spec §3.1). JavaScript cannot force the GC to wipe
// copies made elsewhere — zeroize-and-drop is the best available.

import type { RecordEnvelope, ScopeTag } from "@teacher-assistant/schema";
import type { MasterKey, PeriodKey } from "./keys.js";
import { decryptWithKey, encryptWithKey } from "./records.js";
import {
  aeadDecrypt,
  aeadEncrypt,
  bytesEqual,
  isAllZero,
  sealTo,
  utf8,
  zeroize,
} from "./sodium.js";

/** Thrown when a keyring is asked to use a scope it does not hold (the para boundary). */
export class NoKeyForScopeError extends Error {
  constructor(readonly scopeTag: ScopeTag) {
    // Message references the opaque scope tag only — never a period name or student payload.
    super(`keyring holds no key for scope ${scopeTag}`);
    this.name = "NoKeyForScopeError";
  }
}

/** Thrown on any use of a keyring after destroy() (lock). */
export class KeyringDestroyedError extends Error {
  constructor() {
    super("keyring was destroyed (locked) — unlock again for a new keyring");
    this.name = "KeyringDestroyedError";
  }
}

/** Thrown when a key would replace a different key already held under the same scope tag. */
export class ScopeConflictError extends Error {
  constructor(readonly scopeTag: ScopeTag) {
    super(`keyring already holds a different key for scope ${scopeTag}`);
    this.name = "ScopeConflictError";
  }
}

/**
 * A set of symmetric keys addressed by opaque scope tag. Holds keys privately;
 * exposes encrypt/decrypt but never the keys themselves.
 */
export class Keyring {
  readonly #keys = new Map<ScopeTag, Uint8Array>();
  #destroyed = false;

  #assertLive(): void {
    if (this.#destroyed) {
      throw new KeyringDestroyedError();
    }
  }

  /**
   * Register a symmetric key under its scope tag; the keyring takes ownership of the
   * buffer. Re-adding the identical key is a no-op; a different key under a held tag
   * throws ScopeConflictError (a key is never silently replaced).
   */
  protected putScopeKey(scopeTag: ScopeTag, key: Uint8Array): void {
    this.#assertLive();
    const held = this.#keys.get(scopeTag);
    if (held === undefined) {
      this.#keys.set(scopeTag, key);
      return;
    }
    if (held !== key && !bytesEqual(held, key)) {
      throw new ScopeConflictError(scopeTag);
    }
  }

  /**
   * The key for a scope (for in-package subclasses that wrap it). Throws if absent.
   * An all-zero key means its buffer was zeroized by another keyring's destroy() (the
   * buffer was shared); it throws KeyringDestroyedError rather than encrypt under zeros.
   */
  protected scopeKey(scopeTag: ScopeTag): Uint8Array {
    this.#assertLive();
    const key = this.#keys.get(scopeTag);
    if (key === undefined) {
      throw new NoKeyForScopeError(scopeTag);
    }
    if (isAllZero(key)) {
      throw new KeyringDestroyedError();
    }
    return key;
  }

  /** The scope tags this keyring can use. Opaque ids only — safe to expose. */
  scopes(): readonly ScopeTag[] {
    this.#assertLive();
    return [...this.#keys.keys()];
  }

  /** Whether this keyring holds the key for a scope. */
  hasScope(scopeTag: ScopeTag): boolean {
    this.#assertLive();
    return this.#keys.has(scopeTag);
  }

  /** Encrypt a record payload under the key named by `env.scope_tag`. */
  encryptRecord(env: RecordEnvelope, plaintext: Uint8Array): Uint8Array {
    return encryptWithKey(this.scopeKey(env.scope_tag), env, plaintext);
  }

  /**
   * Decrypt a record blob. Throws NoKeyForScopeError if this keyring does not
   * hold the scope's key (the para least-privilege boundary), or a sodium error
   * if the ciphertext/AAD do not verify.
   */
  decryptRecord(env: RecordEnvelope, blob: Uint8Array): Uint8Array {
    return decryptWithKey(this.scopeKey(env.scope_tag), env, blob);
  }

  /**
   * Seal (wrap) a scope's key to a device public key. Throws if the scope is absent.
   * Protected: outside the package a key is sealed only through the guarded
   * TeacherKeyring methods (sealMasterKeyToDevice, sealPeriodKeyToDevice).
   */
  protected sealScopeKeyToDevice(scopeTag: ScopeTag, devicePublicKey: Uint8Array): Uint8Array {
    return sealTo(this.scopeKey(scopeTag), devicePublicKey);
  }

  /**
   * Encrypt an opaque CRDT update under a scope's key, binding caller-supplied
   * context (e.g. the opaque doc id) as AEAD additional data so a blob cannot be
   * replayed under a different stream. Throws NoKeyForScopeError if the scope is
   * not held — the para boundary applies to sync updates too.
   */
  sealUpdate(scopeTag: ScopeTag, contextAad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return aeadEncrypt(this.scopeKey(scopeTag), plaintext, contextAad);
  }

  /** Decrypt an opaque CRDT update. Throws if the scope is absent or the AAD/tag mismatch. */
  openUpdate(scopeTag: ScopeTag, contextAad: Uint8Array, blob: Uint8Array): Uint8Array {
    return aeadDecrypt(this.scopeKey(scopeTag), blob, contextAad);
  }

  /**
   * Lock: zeroize every key buffer in place, clear the map, and refuse all later use
   * (KeyringDestroyedError). Idempotent.
   */
  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    for (const key of this.#keys.values()) {
      zeroize(key);
    }
    this.#keys.clear();
    this.#destroyed = true;
  }

  /**
   * Keys are withheld from serialisation — only opaque scope tags are exposed. Safe on
   * a destroyed keyring (no scopes), so a log line that stringifies one never throws.
   */
  toJSON(): { readonly scopes: readonly ScopeTag[]; readonly keys: "[withheld]" } {
    return { scopes: [...this.#keys.keys()], keys: "[withheld]" };
  }
}

/** AAD binding a period key wrapped under MK to its scope tag (spec §3.3 `periodKeys`). */
function periodKeyAad(scopeTag: ScopeTag): Uint8Array {
  return utf8(`ta-period-key-v1|${scopeTag}`);
}

/**
 * The teacher keyring: holds the master key (under its master scope tag) plus
 * every Period DEK. Adds the master-key-only operations (enrollment wrapping,
 * period-key wrapping under MK) while keeping MK private.
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

  /** Refuse the master tag where only a period scope is meaningful. */
  #assertPeriodScope(scopeTag: ScopeTag, onMaster: Error): void {
    if (scopeTag === this.masterScopeTag) {
      throw onMaster;
    }
  }

  /** Add a Period DEK to the teacher keyring. Never under the master tag (MK cannot be replaced). */
  addPeriodKey(periodKey: PeriodKey): void {
    this.#assertPeriodScope(periodKey.scopeTag, new ScopeConflictError(periodKey.scopeTag));
    this.putScopeKey(periodKey.scopeTag, periodKey.dek);
  }

  /** Seal the master key to a new teacher device's public key (enrollment). Returns ciphertext. */
  sealMasterKeyToDevice(devicePublicKey: Uint8Array): Uint8Array {
    return this.sealScopeKeyToDevice(this.masterScopeTag, devicePublicKey);
  }

  /**
   * Seal a PERIOD key to a para device's public key. The master tag is refused with
   * NoKeyForScopeError: a para grant can never carry MK, whatever tag the caller passes.
   */
  sealPeriodKeyToDevice(periodScopeTag: ScopeTag, devicePublicKey: Uint8Array): Uint8Array {
    this.#assertPeriodScope(periodScopeTag, new NoKeyForScopeError(periodScopeTag));
    return this.sealScopeKeyToDevice(periodScopeTag, devicePublicKey);
  }

  /**
   * Wrap a period DEK under MK, binding its scope tag as AAD — the `periodKeys` entry of
   * the master doc, from which another teacher device rebuilds its keyring. The master
   * tag is refused (NoKeyForScopeError).
   */
  wrapScopeKeyUnderMaster(scopeTag: ScopeTag): Uint8Array {
    this.#assertPeriodScope(scopeTag, new NoKeyForScopeError(scopeTag));
    return aeadEncrypt(
      this.scopeKey(this.masterScopeTag),
      this.scopeKey(scopeTag),
      periodKeyAad(scopeTag),
    );
  }

  /**
   * The inverse of wrapScopeKeyUnderMaster: unwrap with MK and add the period key.
   * Idempotent for the key already held; a different key under a held tag, or the
   * master tag, throws ScopeConflictError; a blob bound to another tag fails AEAD.
   */
  addWrappedPeriodKey(scopeTag: ScopeTag, wrapped: Uint8Array): void {
    this.#assertPeriodScope(scopeTag, new ScopeConflictError(scopeTag));
    const dek = aeadDecrypt(this.scopeKey(this.masterScopeTag), wrapped, periodKeyAad(scopeTag));
    const alreadyHeld = this.hasScope(scopeTag);
    try {
      this.putScopeKey(scopeTag, dek);
    } catch (err) {
      zeroize(dek);
      throw err;
    }
    if (alreadyHeld) {
      zeroize(dek); // the held buffer was kept; this duplicate is not referenced
    }
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
