// The sync-relay wire contract (architecture §1.3/§1.5, M1↔M2). Lives in schema
// because it is the one neutral package both the client (@teacher-assistant/sync)
// and the server (services/sync-relay) can share — the relay must NOT import the
// crypto package (it never decrypts), so the shared contract cannot live there.
//
// Every field here is identity-clean by construction (H-PUB-4): opaque ids,
// opaque scope tags, base64 ciphertext, and cursors — never initials, goal text,
// or scores. A 4xx/5xx body carries only an opaque `record_id`.

/** HTTP header names carrying the per-request device signature (lower-case, as seen server-side). */
export const SYNC_HEADERS = {
  /** base64 Ed25519 device signing public key — the ACL identity. */
  device: "x-ta-device",
  /** the opaque scope tag the request reads/writes under. */
  scope: "x-ta-scope",
  /** request timestamp (epoch ms, as a string) — replay window. */
  timestamp: "x-ta-timestamp",
  /** per-request random nonce (base64). */
  nonce: "x-ta-nonce",
  /** base64 detached Ed25519 signature over the canonical request. */
  signature: "x-ta-signature",
} as const;

/** POST /sync/:docId body — a batch of opaque encrypted CRDT updates (base64 ciphertext). */
export interface SyncPushBody {
  readonly updates: readonly string[];
}

/** POST /sync/:docId success — the new high-water cursor after append. */
export interface SyncPushResult {
  readonly cursor: string;
}

/** GET /sync/:docId?since=<cursor> success — missing updates + the new cursor. */
export interface SyncPullResult {
  readonly cursor: string;
  readonly updates: readonly string[];
}

/** Any 4xx/5xx body. Identity-clean: an opaque reference id only (H-PUB-4). */
export interface SyncErrorBody {
  readonly error: string;
  readonly record_id: string;
}

/**
 * The exact byte sequence a request signature covers — the M1↔M2 contract. The
 * client signs it and the relay reconstructs it; they must be byte-identical or
 * every signature fails to verify, so it is defined ONCE here (no crypto needed,
 * so the relay can import it without breaching its no-decrypt boundary). Changing
 * the format (adding/reordering fields) is a breaking protocol change.
 */
export function canonicalRequest(
  method: string,
  path: string,
  scope: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
): Uint8Array {
  const head = new TextEncoder().encode(`${method}\n${path}\n${scope}\n${timestamp}\n${nonce}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}
