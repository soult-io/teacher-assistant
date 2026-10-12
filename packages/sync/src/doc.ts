// One encrypted CRDT stream = one Yjs doc per (period,purpose) (architecture §1.4
// doc-granularity: a Period DEK maps cleanly to the para-visible doc, and no doc
// mixes key tiers). Local edits emit commutative Yjs updates; each is encrypted
// under the stream's scope key into an opaque blob before it ever leaves memory.
// Remote blobs are decrypted and applied with a REMOTE origin so they are not
// re-encrypted back onto the wire.

import { type Keyring, utf8 } from "@teacher-assistant/crypto";
import type { OpaqueId, ScopeTag } from "@teacher-assistant/schema";
import * as Y from "yjs";
import { IntegrateError } from "./errors.js";

/** Marks updates that arrived from the relay, so the update handler doesn't re-encrypt them. */
const REMOTE_ORIGIN = Symbol("remote");

export class EncryptedStream {
  readonly doc: Y.Doc;
  readonly #keyring: Keyring;
  /** AAD binds every blob to this opaque doc id (can't be replayed to another stream). */
  readonly #aad: Uint8Array;
  #onLocal: ((blob: Uint8Array) => void) | null = null;

  constructor(
    readonly docId: OpaqueId,
    readonly scopeTag: ScopeTag,
    keyring: Keyring,
  ) {
    this.doc = new Y.Doc();
    this.#keyring = keyring;
    this.#aad = utf8(docId);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) {
        return; // applied from the relay — already on the wire, do not re-encrypt
      }
      this.#onLocal?.(this.#keyring.sealUpdate(this.scopeTag, this.#aad, update));
    });
  }

  /** Register the sink for locally-produced encrypted update blobs (the offline queue). */
  onLocalUpdate(cb: (blob: Uint8Array) => void): void {
    this.#onLocal = cb;
  }

  /** Apply a local mutation in one transaction; its encrypted update is handed to the sink. */
  transact(mutator: (doc: Y.Doc) => void): void {
    this.doc.transact(() => mutator(this.doc));
  }

  /** Decrypt + apply a remote encrypted update. Idempotent (re-applying a known update is a no-op). */
  integrateRemote(blob: Uint8Array): void {
    let update: Uint8Array;
    try {
      update = this.#keyring.openUpdate(this.scopeTag, this.#aad, blob);
    } catch {
      // Identity-clean: reference the opaque doc id only, never the blob/plaintext.
      throw new IntegrateError(this.docId);
    }
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
  }

  /** An encrypted full-state snapshot (ciphertext) for at-rest persistence. */
  encryptedSnapshot(): Uint8Array {
    return this.#keyring.sealUpdate(this.scopeTag, this.#aad, Y.encodeStateAsUpdate(this.doc));
  }
}
