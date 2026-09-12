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

function sendError(reply: FastifyReply, status: number, code: string): void {
  const body: SyncErrorBody = { error: code, record_id: randomUUID() };
  reply.code(status).send(body);
}

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

function rawBodyOf(req: FastifyRequest): Uint8Array {
  const body = req.body;
  return body instanceof Uint8Array ? body : new Uint8Array(0);
}

/** Build the relay app over a store (injected so tests can seed the ACL). */
export function buildApp(store: RelayStore): FastifyInstance {
  // disableRequestLogging: bodies (opaque ciphertext) and signed headers are
  // never written to a log line (H-PUB-4, defence in depth).
  const app = Fastify({ logger: true, disableRequestLogging: true });
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
  function authorizeDoc(
    req: FastifyRequest,
    reply: FastifyReply,
    rawBody: Uint8Array,
    docId: string,
  ): VerifiedRequest | null {
    const verified = verifyRequest(req, rawBody, nonces);
    if (verified === null) {
      sendError(reply, 401, "unauthorized");
      return null;
    }
    // A device not authorized for the declared scope gets 404 for everything, so
    // it cannot tell whether a stream under that scope exists. An authorized
    // device may touch its own scope; a doc bound to a DIFFERENT scope stays
    // hidden (404). An as-yet-unwritten doc under its scope is a legitimate empty
    // stream (the route decides what to do with it).
    if (!store.isAuthorized(verified.devicePublicKeyB64, verified.scope)) {
      notFound(reply);
      return null;
    }
    const bound = store.docScope(docId);
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
    const verified = authorizeDoc(req, reply, rawBodyOf(req), docId);
    if (verified === null) {
      return reply;
    }
    const sinceRaw = Number((req.query as { since?: string }).since ?? "0");
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
    const result = store.fetch(docId, since);
    const payload: SyncPullResult = { cursor: result.cursor, updates: result.updates };
    return reply.send(payload);
  });

  // Append encrypted updates for an opaque doc id.
  app.post("/sync/:docId", async (req, reply) => {
    const rawBody = rawBodyOf(req);
    const { docId } = req.params as { docId: string };
    const verified = authorizeDoc(req, reply, rawBody, docId);
    if (verified === null) {
      return reply;
    }
    let parsed: SyncPushBody;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBody)) as SyncPushBody;
    } catch {
      return sendError(reply, 400, "bad_request");
    }
    if (!Array.isArray(parsed.updates) || !parsed.updates.every((u) => typeof u === "string")) {
      return sendError(reply, 400, "bad_request");
    }
    const cursor = store.append(docId, verified.scope, parsed.updates);
    const payload: SyncPushResult = { cursor };
    return reply.send(payload);
  });

  return app;
}
