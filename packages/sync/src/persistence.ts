// Offline persistence (architecture §1.3, FERPA Item-2a). The at-rest payload is
// CIPHERTEXT ONLY: this adapter deals exclusively in opaque encrypted-update
// blobs (Uint8Array) + an opaque cursor + an optional encrypted snapshot. It
// never sees a decrypted Y.Doc or any plaintext field — decryption happens in
// memory on unlock, never on the path to disk.
//
// The browser implementation persists this via y-indexeddb / IndexedDB storing
// ONLY these ciphertext blobs (a plaintext response cache of student data would
// violate D1). InMemoryPersistence backs tests.

/** The persisted state of one (period,purpose) stream — all ciphertext + opaque metadata. */
export interface PersistedStream {
  /** Encrypted update blobs queued locally, not yet acked by the relay. */
  readonly pending: readonly Uint8Array[];
  /** Last relay cursor integrated, or null if never synced. */
  readonly cursor: string | null;
  /** Optional encrypted materialised snapshot (ciphertext). */
  readonly snapshot?: Uint8Array;
}

/** Per-stream ciphertext persistence. Keyed by opaque doc id. */
export interface PersistenceAdapter {
  load(docId: string): Promise<PersistedStream | null>;
  save(docId: string, state: PersistedStream): Promise<void>;
}

/** In-memory adapter for tests. Stores only what the interface allows: ciphertext + opaque metadata. */
export class InMemoryPersistence implements PersistenceAdapter {
  readonly #streams = new Map<string, PersistedStream>();

  load(docId: string): Promise<PersistedStream | null> {
    return Promise.resolve(this.#streams.get(docId) ?? null);
  }

  save(docId: string, state: PersistedStream): Promise<void> {
    this.#streams.set(docId, state);
    return Promise.resolve();
  }
}
