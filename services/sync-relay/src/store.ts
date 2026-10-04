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

import { randomUUID } from "node:crypto";

export interface FetchResult {
  readonly cursor: string;
  readonly updates: string[];
}

/**
 * A client cursor, parsed. On the wire it is the opaque string
 * `<epoch>.<seq>`: `seq` is the last sequence number the client has, and
 * `epoch` is a random id minted when the doc row is created. Restoring the
 * relay from a backup re-mints every doc's epoch (see migrations.ts), so a
 * cursor from before the restore no longer matches and the client is served
 * from 0 — sequence numbers are reused after a restore, so `seq` alone cannot
 * tell an old history from the current one.
 */
export interface Cursor {
  readonly epoch: string | undefined;
  readonly seq: number;
}

const START: Cursor = { epoch: undefined, seq: 0 };
const MAX_CURSOR_LENGTH = 128;

/** Parse `?since=`. Anything that is not `<epoch>.<non-negative int>` is "from the start". */
export function parseCursor(raw: string | undefined): Cursor {
  if (raw === undefined || raw.length > MAX_CURSOR_LENGTH) {
    return START;
  }
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) {
    return START;
  }
  const digits = raw.slice(dot + 1);
  const seq = Number(digits);
  return /^\d+$/.test(digits) && Number.isSafeInteger(seq)
    ? { epoch: raw.slice(0, dot), seq }
    : START;
}

export function formatCursor(epoch: string, seq: number | string): string {
  return `${epoch}.${seq}`;
}

/** Mint a doc epoch (random; carries no information). */
export function newEpoch(): string {
  return randomUUID();
}

export interface RelayStore {
  /** Whether a device (by signing pubkey) may access a scope. */
  isAuthorized(devicePublicKeyB64: string, scopeTag: string): Promise<boolean>;
  /** Grant a device access to a scope (provisioning; seeded in tests). Idempotent. */
  authorize(devicePublicKeyB64: string, scopeTag: string): Promise<void>;
  /** The scope a doc is bound to, or undefined if the doc is unknown. */
  docScope(docId: string): Promise<string | undefined>;
  /**
   * Atomically append ciphertext updates; binds docId→scope (and mints the doc's
   * epoch) on first write. Returns the new cursor, or undefined (nothing written) when the doc is
   * already bound to a DIFFERENT scope — the check and the write are one step,
   * so two concurrent first writers under different scopes cannot both land.
   */
  append(docId: string, scopeTag: string, blobsB64: readonly string[]): Promise<string | undefined>;
  /**
   * Fetch updates after `since`. The returned cursor is `<epoch>.<head>`, read in
   * the same snapshot as the updates; an unknown doc returns cursor "0" and no
   * updates. `since` is honoured only if its epoch is the doc's AND its seq is
   * not past the head; otherwise (a cursor from before a restore, a legacy or
   * malformed cursor) every update is returned, so the client re-applies them
   * (idempotent for CRDT updates) instead of silently skipping any.
   * (Pagination, when it lands, will make the cursor "last seq returned"; do not
   * rely on cursor == head elsewhere.)
   */
  fetch(docId: string, since: Cursor): Promise<FetchResult>;
}

interface StoredUpdate {
  readonly seq: number;
  readonly blobB64: string;
}

interface StoredDoc {
  readonly scopeTag: string;
  readonly epoch: string;
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
      doc = { scopeTag, epoch: newEpoch(), updates: [] };
      this.#docs.set(docId, doc);
    } else if (doc.scopeTag !== scopeTag) {
      return undefined;
    }
    for (const blobB64 of blobsB64) {
      doc.updates.push({ seq: doc.updates.length + 1, blobB64 });
    }
    return formatCursor(doc.epoch, doc.updates.length);
  }

  async fetch(docId: string, since: Cursor): Promise<FetchResult> {
    const doc = this.#docs.get(docId);
    if (doc === undefined) {
      return { cursor: "0", updates: [] };
    }
    const head = doc.updates.length;
    const from = since.epoch === doc.epoch && since.seq <= head ? since.seq : 0;
    const updates = doc.updates.filter((u) => u.seq > from).map((u) => u.blobB64);
    return { cursor: formatCursor(doc.epoch, head), updates };
  }

  /** Test hook: what a backup restore does to every doc (see migrations.ts). */
  rotateEpochs(): void {
    for (const [id, doc] of this.#docs) {
      this.#docs.set(id, { ...doc, epoch: newEpoch() });
    }
  }
}
