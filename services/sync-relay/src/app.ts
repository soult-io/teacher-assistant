// sync-relay (M2) — the authenticated append-only encrypted-update relay.
// It NEVER decrypts, merges, indexes, or computes: it stores and serves opaque
// ciphertext keyed by opaque doc-id, gated by a per-device-pubkey ACL.
//
// H-PUB-3 (hard): an authenticated-but-UNAUTHORIZED device gets ZERO bytes and
// ZERO existence signal outside its scope — an unknown doc and an unauthorized
// doc return the byte-identical 404, so membership of a stream cannot be probed.
// H-PUB-4 (hard): the public surface is identity-clean — URLs/bodies carry only
// opaque ids + base64 ciphertext, request bodies are never logged, and every
// 4xx/5xx references an opaque `record_id` only.

import { randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import {
  canonicalRequest,
  SYNC_HEADERS,
  type SyncErrorBody,
  type SyncPullResult,
  type SyncPushBody,
  type SyncPushResult,
} from "@teacher-assistant/schema";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { fromBase64, sodiumReady, verifyDetached } from "./sodium-verify.js";
import { errorCode } from "./sql.js";
import type { RelayStore } from "./store.js";

/** Requests older/newer than this (clock skew + transit) are rejected (replay window). */
const TIMESTAMP_WINDOW_MS = 300_000;

/**
 * Remembers (device, nonce) pairs so a captured valid request cannot be replayed
 * within the timestamp window. A nonce is only useful for that window, so entries
 * expire; the map is swept lazily to stay bounded. Nonces are recorded only AFTER
 * the signature verifies, so an attacker cannot pollute it with forged pairs.
 */
class NonceCache {
  readonly #seen = new Map<string, number>();
  #opsSinceSweep = 0;

  /** Returns true if fresh (and records it); false if it is a replay. */
  offer(device: string, nonce: string, now: number): boolean {
    const key = `${device}:${nonce}`;
    const expiry = this.#seen.get(key);
    if (expiry !== undefined && expiry > now) {
      return false;
    }
    this.#seen.set(key, now + TIMESTAMP_WINDOW_MS);
    if (++this.#opsSinceSweep > 1000) {
      this.#opsSinceSweep = 0;
      for (const [k, exp] of this.#seen) {
        if (exp <= now) {
          this.#seen.delete(k);
        }
      }
    }
    return true;
  }
}

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Send the identity-clean error body; returns its opaque record_id. */
function sendError(reply: FastifyReply, status: number, code: string): string {
  const record_id = randomUUID();
  const body: SyncErrorBody = { error: code, record_id };
  reply.code(status).send(body);
  return record_id;
}

/**
 * A store failure (e.g. the database is unreachable) → 503. The log line carries
 * the opaque record_id and, for a database error, its 5-character SQLSTATE —
 * never the error message, the doc id, or anything from the request (H-PUB-4).
 * A 503 means "outcome unknown": a timed-out append may still have committed,
 * so a client retry can append the same updates again (CRDT updates are
 * idempotent to apply, so this is safe for the sync client).
 */
function storeUnavailable(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  const code = errorCode(err);
  const sqlstate = code !== undefined && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  const record_id = sendError(reply, 503, "unavailable");
  req.log.error({ record_id, sqlstate }, "sync store unavailable");
}

/**
 * Longest doc id / scope tag accepted (clients mint UUIDs, 36 chars). Keeps every
 * key well under Postgres' btree entry limit, so an oversized id is an unknown
 * doc (404) on every store instead of a database error (503) on one. (Fastify
 * already refuses a doc id over 100 chars with 414; the scope header is the
 * case this guards.)
 */
const MAX_ID_LENGTH = 256;

/** Ciphertext travels as base64 (standard or URL-safe alphabet). */
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** Identical response for "unknown doc" and "unauthorized" — the H-PUB-3 zero-existence guarantee. */
function notFound(reply: FastifyReply): void {
  sendError(reply, 404, "not_found");
}

interface VerifiedRequest {
  readonly devicePublicKeyB64: string;
  readonly scope: string;
}

/** Verify the Ed25519 request signature + freshness over the canonical descriptor + raw body. */
function verifyRequest(
  req: FastifyRequest,
  rawBody: Uint8Array,
  nonces: NonceCache,
): VerifiedRequest | null {
  const device = header(req, SYNC_HEADERS.device);
  const scope = header(req, SYNC_HEADERS.scope);
  const timestamp = header(req, SYNC_HEADERS.timestamp);
  const nonce = header(req, SYNC_HEADERS.nonce);
  const signature = header(req, SYNC_HEADERS.signature);
  if (!device || !scope || !timestamp || !nonce || !signature) {
    return null;
  }
  const ts = Number(timestamp);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) {
    return null;
  }
  const canonical = canonicalRequest(req.method, req.url, scope, timestamp, nonce, rawBody);
  try {
    if (!verifyDetached(fromBase64(signature), canonical, fromBase64(device))) {
      return null;
    }
  } catch {
    return null; // malformed base64 in a header
  }
  // Signature is valid — now reject a replay of it within the window.
  if (!nonces.offer(device, nonce, now)) {
    return null;
  }
  return { devicePublicKeyB64: device, scope };
}

/** The push body's updates, or null unless it is `{updates: string[]}` of base64. */
function parsePushUpdates(rawBody: Uint8Array): readonly string[] | null {
  let parsed: SyncPushBody;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody)) as SyncPushBody;
  } catch {
    return null;
  }
  const updates: unknown = parsed?.updates;
  if (!Array.isArray(updates) || !updates.every((u) => typeof u === "string" && BASE64.test(u))) {
    return null;
  }
  return updates as string[];
}

function rawBodyOf(req: FastifyRequest): Uint8Array {
  const body = req.body;
  return body instanceof Uint8Array ? body : new Uint8Array(0);
}

export interface BuildAppOptions {
  /** Where log lines go (default stdout). Tests capture them to assert what is logged. */
  readonly logStream?: { write(line: string): void };
}

/** Build the relay app over a store (injected so tests can seed the ACL). */
export function buildApp(store: RelayStore, options: BuildAppOptions = {}): FastifyInstance {
  // disableRequestLogging: bodies (opaque ciphertext) and signed headers are
  // never written to a log line (H-PUB-4, defence in depth).
  const logger = options.logStream === undefined ? true : { stream: options.logStream };
  const app = Fastify({ logger, disableRequestLogging: true });
  const nonces = new NonceCache();

  // Per-IP rate limiting (H-PUB-5) — app-level defence in depth in front of the
  // authorizing /sync routes, additional to the NPM/WAF layer. Behind the
  // Lexington NPM, the deploy must set Fastify `trustProxy` so req.ip is the
  // real client. The 429 body stays identity-clean (opaque record_id only).
  // State is in-process (single-instance Phase 0; a shared store is a follow-on).
  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({ error: "rate_limited", record_id: randomUUID() }),
  });

  // libsodium (signature verification) must be initialised before any request is
  // handled. onReady runs on app.ready()/listen() and on the first inject().
  app.addHook("onReady", async () => {
    await sodiumReady();
  });

  // Capture the raw body so the signature covers exactly the bytes sent.
  app.addContentTypeParser(
    ["application/json", "application/octet-stream"],
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  /**
   * The shared security preamble for /sync routes: verify the signature (else
   * 401), then the per-scope ACL + doc-scope binding (else the byte-identical
   * H-PUB-3 404). Returns the verified request, or null after sending the error.
   * Keeping it in one place keeps the zero-existence response identical on both
   * routes.
   */
  async function authorizeDoc(
    req: FastifyRequest,
    reply: FastifyReply,
    rawBody: Uint8Array,
    docId: string,
  ): Promise<VerifiedRequest | null> {
    const verified = verifyRequest(req, rawBody, nonces);
    if (verified === null) {
      sendError(reply, 401, "unauthorized");
      return null;
    }
    // A doc id with a NUL (Postgres text cannot hold one) or an oversized id or
    // scope can never exist, so it gets the same 404 as any other unknown doc.
    if (
      docId.includes("\u0000") ||
      docId.length > MAX_ID_LENGTH ||
      verified.scope.length > MAX_ID_LENGTH
    ) {
      notFound(reply);
      return null;
    }
    // A device not authorized for the declared scope gets 404 for everything, so
    // it cannot tell whether a stream under that scope exists. An authorized
    // device may touch its own scope; a doc bound to a DIFFERENT scope stays
    // hidden (404). An as-yet-unwritten doc under its scope is a legitimate empty
    // stream (the route decides what to do with it).
    if (!(await store.isAuthorized(verified.devicePublicKeyB64, verified.scope))) {
      notFound(reply);
      return null;
    }
    const bound = await store.docScope(docId);
    if (bound !== undefined && bound !== verified.scope) {
      notFound(reply);
      return null;
    }
    return verified;
  }

  app.get("/health", async () => ({ status: "ok", service: "sync-relay" }));

  // Fetch updates after ?since for an opaque doc id.
  app.get("/sync/:docId", async (req, reply) => {
    const { docId } = req.params as { docId: string };
    try {
      const verified = await authorizeDoc(req, reply, rawBodyOf(req), docId);
      if (verified === null) {
        return reply;
      }
      const sinceRaw = Number((req.query as { since?: string }).since ?? "0");
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
      const result = await store.fetch(docId, since);
      const payload: SyncPullResult = { cursor: result.cursor, updates: result.updates };
      return reply.send(payload);
    } catch (err) {
      return storeUnavailable(req, reply, err);
    }
  });

  // Append encrypted updates for an opaque doc id.
  app.post("/sync/:docId", async (req, reply) => {
    const rawBody = rawBodyOf(req);
    const { docId } = req.params as { docId: string };
    try {
      const verified = await authorizeDoc(req, reply, rawBody, docId);
      if (verified === null) {
        return reply;
      }
      const updates = parsePushUpdates(rawBody);
      if (updates === null) {
        return sendError(reply, 400, "bad_request");
      }
      // undefined: another scope bound this doc after authorizeDoc looked — the
      // same zero-existence 404 as if it had been bound already.
      const cursor = await store.append(docId, verified.scope, updates);
      if (cursor === undefined) {
        return notFound(reply);
      }
      const payload: SyncPushResult = { cursor };
      return reply.send(payload);
    } catch (err) {
      return storeUnavailable(req, reply, err);
    }
  });

  return app;
}
