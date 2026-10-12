// The sync engine (architecture §1.3, PRD §5). Ties a local EncryptedStream to
// the relay + ciphertext persistence. Offline captures queue locally and persist
// as ciphertext; reconnect reconciles CONFLICT-FREE via Yjs (no overwrite, no
// duplicate, no silent denominator change) — the merge is commutative, so apply
// order never matters and re-applying a known update is a no-op.
//
// Cursor discipline: the cursor only advances from a PULL (what we have actually
// integrated). A push never advances it, so updates appended by other devices
// between our pull and our push are never skipped — the next pull re-fetches from
// the integrated cursor, re-applying our own updates idempotently.

import type { EncryptedStream } from "./doc.js";
import type { PersistenceAdapter, PersistedStream } from "./persistence.js";
import type { RelayClient } from "./relay-client.js";

export class SyncEngine {
  readonly #stream: EncryptedStream;
  readonly #relay: RelayClient;
  readonly #persistence: PersistenceAdapter;
  #pending: Uint8Array[] = [];
  #cursor: string | null = null;

  constructor(stream: EncryptedStream, relay: RelayClient, persistence: PersistenceAdapter) {
    this.#stream = stream;
    this.#relay = relay;
    this.#persistence = persistence;
    // Local updates queue synchronously; capture()/sync() own the (async) persist.
    stream.onLocalUpdate((blob) => this.#pending.push(blob));
  }

  /** Number of captured-but-unsent updates (offline backlog). */
  get pendingCount(): number {
    return this.#pending.length;
  }

  #state(): PersistedStream {
    return {
      pending: this.#pending,
      cursor: this.#cursor,
      snapshot: this.#stream.encryptedSnapshot(),
    };
  }

  /** Restore queued updates + the doc state from ciphertext persistence (e.g. after a reload/crash). */
  async load(): Promise<void> {
    const st = await this.#persistence.load(this.#stream.docId);
    if (st === null) {
      return;
    }
    if (st.snapshot !== undefined) {
      this.#stream.integrateRemote(st.snapshot); // rebuild doc from the encrypted snapshot
    }
    this.#pending = [...st.pending];
    this.#cursor = st.cursor;
  }

  /** Apply a local change offline; it is queued + persisted as ciphertext before returning. */
  async capture(mutator: (doc: EncryptedStream["doc"]) => void): Promise<void> {
    this.#stream.transact(mutator);
    await this.#persistence.save(this.#stream.docId, this.#state());
  }

  /**
   * Reconcile with the relay: pull+integrate missing updates, then push the local
   * backlog. Call serially per engine — concurrent sync() calls on the same engine
   * are not supported yet (both would snapshot the same pending prefix); the app
   * drives this on reconnect/interval, not concurrently. (A sync-in-flight guard is
   * a tracked follow-on.)
   */
  async sync(): Promise<void> {
    const { cursor, updates } = await this.#relay.pull(
      this.#stream.docId,
      this.#stream.scopeTag,
      this.#cursor,
    );
    for (const update of updates) {
      this.#stream.integrateRemote(update);
    }
    this.#cursor = cursor;

    if (this.#pending.length > 0) {
      // Snapshot the batch, then remove exactly those entries after the push
      // resolves. A capture() that runs DURING the await appends to #pending and
      // must survive — clearing the whole array here would silently drop it (and
      // with it a committed point that never reaches the other device).
      const batch = [...this.#pending];
      await this.#relay.push(this.#stream.docId, this.#stream.scopeTag, batch);
      this.#pending.splice(0, batch.length);
    }
    await this.#persistence.save(this.#stream.docId, this.#state());
  }
}
