// The relay's append-only encrypted-update store + per-opaque-id ACL
// (architecture §1.5). It holds ONLY opaque ids, opaque scope tags, device
// signing public keys, and base64 ciphertext blobs — never plaintext, never a
// student-identifying field. It cannot decrypt anything it stores.
//
// Two implementations of one contract (store.contract.test.ts runs against both):
//   - InMemoryRelayStore (this file) — tests and local development only.
//   - PostgresRelayStore (postgres-store.ts) — the durable deploy backing.
// The choice is made at startup from configuration (config.ts); it does not
// change the wire protocol or the authorization logic.

export interface FetchResult {
  readonly cursor: string;
  readonly updates: string[];
}

export interface RelayStore {
  /** Whether a device (by signing pubkey) may access a scope. */
  isAuthorized(devicePublicKeyB64: string, scopeTag: string): Promise<boolean>;
  /** Grant a device access to a scope (provisioning; seeded in tests). Idempotent. */
  authorize(devicePublicKeyB64: string, scopeTag: string): Promise<void>;
  /** The scope a doc is bound to, or undefined if the doc is unknown. */
  docScope(docId: string): Promise<string | undefined>;
  /**
   * Atomically append ciphertext updates; binds docId→scope on first write.
   * Returns the new cursor, or undefined (nothing written) when the doc is
   * already bound to a DIFFERENT scope — the check and the write are one step,
   * so two concurrent first writers under different scopes cannot both land.
   */
  append(docId: string, scopeTag: string, blobsB64: readonly string[]): Promise<string | undefined>;
  /**
   * Fetch updates after `since` (0 = from the start). The cursor is the doc's
   * head sequence, read in the same snapshot as the updates; an unknown doc
   * echoes `since` with no updates.
   */
  fetch(docId: string, since: number): Promise<FetchResult>;
}

interface StoredUpdate {
  readonly seq: number;
  readonly blobB64: string;
}

interface StoredDoc {
  readonly scopeTag: string;
  readonly updates: StoredUpdate[];
}

export class InMemoryRelayStore implements RelayStore {
  readonly #docs = new Map<string, StoredDoc>();
  readonly #acl = new Map<string, Set<string>>();

  async isAuthorized(devicePublicKeyB64: string, scopeTag: string): Promise<boolean> {
    return this.#acl.get(devicePublicKeyB64)?.has(scopeTag) ?? false;
  }

  async authorize(devicePublicKeyB64: string, scopeTag: string): Promise<void> {
    const scopes = this.#acl.get(devicePublicKeyB64) ?? new Set<string>();
    scopes.add(scopeTag);
    this.#acl.set(devicePublicKeyB64, scopes);
  }

  async docScope(docId: string): Promise<string | undefined> {
    return this.#docs.get(docId)?.scopeTag;
  }

  async append(
    docId: string,
    scopeTag: string,
    blobsB64: readonly string[],
  ): Promise<string | undefined> {
    let doc = this.#docs.get(docId);
    if (doc === undefined) {
      doc = { scopeTag, updates: [] };
      this.#docs.set(docId, doc);
    } else if (doc.scopeTag !== scopeTag) {
      return undefined;
    }
    for (const blobB64 of blobsB64) {
      doc.updates.push({ seq: doc.updates.length + 1, blobB64 });
    }
    return String(doc.updates.length);
  }

  async fetch(docId: string, since: number): Promise<FetchResult> {
    const doc = this.#docs.get(docId);
    if (doc === undefined) {
      return { cursor: String(since), updates: [] };
    }
    const updates = doc.updates.filter((u) => u.seq > since).map((u) => u.blobB64);
    return { cursor: String(doc.updates.length), updates };
  }
}
