// The relay's append-only encrypted-update store + per-opaque-id ACL
// (architecture §1.5). It holds ONLY opaque ids, opaque scope tags, device
// signing public keys, and base64 ciphertext blobs — never plaintext, never a
// student-identifying field. It cannot decrypt anything it stores.
//
// Phase 0 uses an in-memory implementation to prove the protocol + the ACL
// behaviour by test; the durable (Postgres ciphertext-blob) backing is a
// deploy-time implementation of this same interface and does not change the wire
// protocol or the authorization logic.

export interface FetchResult {
  readonly cursor: string;
  readonly updates: string[];
}

export interface RelayStore {
  /** Whether a device (by signing pubkey) may access a scope. */
  isAuthorized(devicePublicKeyB64: string, scopeTag: string): boolean;
  /** Grant a device access to a scope (provisioning; seeded in tests). */
  authorize(devicePublicKeyB64: string, scopeTag: string): void;
  /** The scope a doc is bound to, or undefined if the doc is unknown. */
  docScope(docId: string): string | undefined;
  /** Append ciphertext updates; registers docId→scope on first write. Returns the new cursor. */
  append(docId: string, scopeTag: string, blobsB64: readonly string[]): string;
  /** Fetch updates after `since` (0 = from the start). */
  fetch(docId: string, since: number): FetchResult;
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

  isAuthorized(devicePublicKeyB64: string, scopeTag: string): boolean {
    return this.#acl.get(devicePublicKeyB64)?.has(scopeTag) ?? false;
  }

  authorize(devicePublicKeyB64: string, scopeTag: string): void {
    const scopes = this.#acl.get(devicePublicKeyB64) ?? new Set<string>();
    scopes.add(scopeTag);
    this.#acl.set(devicePublicKeyB64, scopes);
  }

  docScope(docId: string): string | undefined {
    return this.#docs.get(docId)?.scopeTag;
  }

  append(docId: string, scopeTag: string, blobsB64: readonly string[]): string {
    let doc = this.#docs.get(docId);
    if (doc === undefined) {
      doc = { scopeTag, updates: [] };
      this.#docs.set(docId, doc);
    }
    for (const blobB64 of blobsB64) {
      doc.updates.push({ seq: doc.updates.length + 1, blobB64 });
    }
    return String(doc.updates.length);
  }

  fetch(docId: string, since: number): FetchResult {
    const doc = this.#docs.get(docId);
    if (doc === undefined) {
      return { cursor: String(since), updates: [] };
    }
    const updates = doc.updates.filter((u) => u.seq > since).map((u) => u.blobB64);
    return { cursor: String(doc.updates.length), updates };
  }
}
