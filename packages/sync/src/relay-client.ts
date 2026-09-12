// The encrypted-update relay client (architecture §1.3). Pushes/pulls opaque
// ciphertext blobs to the sync-relay (M2). Every request is signed with the
// device Ed25519 signing key over a canonical descriptor + the raw body, proving
// possession of the device identity the relay's ACL keys on. The client sends
// only opaque ids, an opaque scope tag, and base64 ciphertext — no student
// payload ever reaches a URL or body (H-PUB-4).

import {
  type DeviceSigningKeypair,
  fromBase64,
  sign,
  toBase64,
  utf8,
} from "@teacher-assistant/crypto";
import {
  canonicalRequest,
  SYNC_HEADERS,
  type SyncErrorBody,
  type SyncPullResult,
  type SyncPushBody,
  type SyncPushResult,
} from "@teacher-assistant/schema";
import { RelayRequestError } from "./errors.js";

export interface RelayHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface RelayHttpResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

/** Pluggable transport: real `fetch` in the app, Fastify `inject` in tests. */
export type Transport = (req: RelayHttpRequest) => Promise<RelayHttpResponse>;

/** A `fetch`-backed transport against a relay base URL (app/browser use). */
export function fetchTransport(baseUrl: string): Transport {
  return async (req) => {
    const res = await fetch(`${baseUrl}${req.path}`, {
      method: req.method,
      headers: req.headers,
      // Copy into a fresh ArrayBuffer-backed view so it satisfies BodyInit.
      body: req.method === "GET" ? null : new Uint8Array(req.body),
    });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  };
}

export interface RelayClientConfig {
  readonly transport: Transport;
  readonly signingKeypair: DeviceSigningKeypair;
  /** Clock for the request timestamp (injectable for tests). */
  readonly now?: () => number;
}

function parseRecordId(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Partial<SyncErrorBody>;
    return typeof parsed.record_id === "string" ? parsed.record_id : null;
  } catch {
    return null;
  }
}

export class RelayClient {
  readonly #transport: Transport;
  readonly #signing: DeviceSigningKeypair;
  readonly #now: () => number;

  constructor(config: RelayClientConfig) {
    this.#transport = config.transport;
    this.#signing = config.signingKeypair;
    this.#now = config.now ?? Date.now;
  }

  #signedHeaders(
    method: "GET" | "POST",
    path: string,
    scope: string,
    body: Uint8Array,
  ): Record<string, string> {
    const timestamp = String(this.#now());
    const nonce = toBase64(crypto.getRandomValues(new Uint8Array(16)));
    const canonical = canonicalRequest(method, path, scope, timestamp, nonce, body);
    const signature = sign(canonical, this.#signing.privateKey);
    return {
      [SYNC_HEADERS.device]: toBase64(this.#signing.publicKey),
      [SYNC_HEADERS.scope]: scope,
      [SYNC_HEADERS.timestamp]: timestamp,
      [SYNC_HEADERS.nonce]: nonce,
      [SYNC_HEADERS.signature]: toBase64(signature),
    };
  }

  /** Append encrypted updates for a (period,purpose) stream. Returns the new cursor. */
  async push(docId: string, scope: string, updates: readonly Uint8Array[]): Promise<string> {
    const path = `/sync/${encodeURIComponent(docId)}`;
    const payload: SyncPushBody = { updates: updates.map((u) => toBase64(u)) };
    const body = utf8(JSON.stringify(payload));
    const res = await this.#transport({
      method: "POST",
      path,
      headers: {
        ...this.#signedHeaders("POST", path, scope, body),
        "content-type": "application/json",
      },
      body,
    });
    if (res.status !== 200) {
      throw new RelayRequestError(res.status, docId, parseRecordId(res.body));
    }
    return (JSON.parse(new TextDecoder().decode(res.body)) as SyncPushResult).cursor;
  }

  /** Fetch updates after `since` (null = from the start). Returns the new cursor + ciphertext blobs. */
  async pull(
    docId: string,
    scope: string,
    since: string | null,
  ): Promise<{ cursor: string; updates: Uint8Array[] }> {
    const path = `/sync/${encodeURIComponent(docId)}?since=${encodeURIComponent(since ?? "")}`;
    const body = new Uint8Array(0);
    const res = await this.#transport({
      method: "GET",
      path,
      headers: this.#signedHeaders("GET", path, scope, body),
      body,
    });
    if (res.status !== 200) {
      throw new RelayRequestError(res.status, docId, parseRecordId(res.body));
    }
    const result = JSON.parse(new TextDecoder().decode(res.body)) as SyncPullResult;
    return { cursor: result.cursor, updates: result.updates.map((u) => fromBase64(u)) };
  }
}
