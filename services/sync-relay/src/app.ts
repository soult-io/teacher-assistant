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
//
// TEACH-55 (EU-0) logging contract: every error path — route errors, framework
// errors (413/414/415/bad URL), the rate limit, unknown routes and client errors
// before routing (431) — answers `{error, record_id}` and logs at most
// `{record_id, route, status, sqlstate}`. `route` is the TEMPLATE (`/sync/:docId`),
// never the filled URL; no header, IP, query, body or error message is logged.

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
import type { Socket } from "node:net";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { isTrustedProxyEntry } from "./config.js";
import { fromBase64, sodiumReady, verifyDetached } from "./sodium-verify.js";
import { errorCode } from "./sql.js";
import { parseCursor, type RelayStore } from "./store.js";

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

/** The route TEMPLATE a request matched (`/sync/:docId`), or "unmatched". Never the filled URL. */
function routeOf(req: FastifyRequest): string {
  return req.is404 ? "unmatched" : (req.routeOptions?.url ?? "unmatched");
}

/** A 5-character SQLSTATE from a database error; anything else (Node/Fastify codes) is dropped. */
function sqlstateOf(err: unknown): string | undefined {
  const code = errorCode(err);
  return code !== undefined && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * Send `{error, record_id}` and write the ONE permitted error log line:
 * record_id, route template, status and (for a database error) the SQLSTATE.
 * 5xx log at error, 4xx at info.
 */
function failRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  err: unknown,
  msg: string,
): void {
  const record_id = sendError(reply, status, code);
  const fields = { record_id, route: routeOf(req), status, sqlstate: sqlstateOf(err) };
  if (status >= 500) {
    req.log.error(fields, msg);
  } else {
    req.log.info(fields, msg);
  }
}

/**
 * A store failure (e.g. the database is unreachable) → 503. A 503 means
 * "outcome unknown": a timed-out append may still have committed, so a client
 * retry can append the same updates again (CRDT updates are idempotent to apply,
 * so this is safe for the sync client).
 */
function storeUnavailable(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  failRequest(req, reply, 503, "unavailable", err, "sync store unavailable");
}

/** Wire `error` codes for the statuses Fastify and its plugins raise. */
const ERROR_CODES: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  413: "payload_too_large",
  414: "uri_too_long",
  415: "unsupported_media_type",
  429: "rate_limited",
  431: "header_too_large",
  503: "unavailable",
};

/** The HTTP status a thrown error asks for; anything not a 4xx/5xx is a 500. */
function statusOf(err: unknown): number {
  const s = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" && Number.isInteger(s) && s >= 400 && s <= 599 ? s : 500;
}

/**
 * The single error handler (setErrorHandler + frameworkErrors). Never logs or
 * returns err.message / stack — they can carry the filled path or a doc id.
 */
function handleError(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  const status = statusOf(err);
  const code = ERROR_CODES[status] ?? (status >= 500 ? "internal" : "bad_request");
  failRequest(req, reply, status, code, err, status >= 500 ? "request failed" : "request rejected");
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: "Bad Request",
  408: "Request Timeout",
  431: "Request Header Fields Too Large",
};

/**
 * Errors raised by Node's HTTP parser before Fastify routes the request (431
 * oversized headers, 408, malformed request line). There is no route, so it is
 * "unmatched"; the raw packet in `err` is never logged.
 */
function clientErrorHandler(
  this: FastifyInstance,
  err: Error & { code?: string },
  socket: Socket,
): void {
  if (err.code === "ECONNRESET" || socket.destroyed) {
    return;
  }
  const status =
    err.code === "HPE_HEADER_OVERFLOW" ? 431 : err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : 400;
  const record_id = randomUUID();
  const body: SyncErrorBody = {
    error: ERROR_CODES[status] ?? (status === 408 ? "timeout" : "bad_request"),
    record_id,
  };
  this.log.info({ record_id, route: "unmatched", status }, "client error");
  if (socket.writable) {
    const json = JSON.stringify(body);
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`,
    );
  }
  socket.destroy();
}

/** Log serializers: a request is only its route template, a response only its status. */
const SERIALIZERS = {
  req: (req: FastifyRequest) => ({ route: routeOf(req) }),
  res: (res: { statusCode: number }) => ({ status: res.statusCode }),
  // An error is reduced to its class name: message and stack are replaced, and
  // attached fields (pg's detail/where/…) are dropped. Fastify's types require
  // the message/stack keys, so they carry a fixed marker.
  err: (err: Error) => ({ type: err.name, message: "(redacted)", stack: "(redacted)" }),
};

/** Production log level, pinned (FERPA re-review N4): never debug/trace in a deploy. */
const LOG_LEVEL = "info";

/**
 * The only log messages that pass verbatim. Fastify interpolates the FILLED URL
 * into some of its own messages (e.g. "Reply was already sent … in /sync/<doc>"),
 * which no serializer can reach, so every other message is replaced. The
 * listening line is the deploy's startup check ("(store: postgres)").
 */
const LOG_MESSAGE_ALLOWLIST: readonly RegExp[] = [
  /^(sync store unavailable|request failed|request rejected|client error)$/,
  /^sync-relay listening on \S+ \(store: (memory|postgres)\)$/,
];
const REDACTED_MESSAGE = "(log message redacted)";

/** pino `hooks.logMethod`: pass the message only if it is allowlisted; drop interpolation args. */
function guardLogMessage(
  this: unknown,
  args: unknown[],
  method: (...args: unknown[]) => void,
): void {
  const msgAt = typeof args[0] === "string" ? 0 : 1;
  const msg = args[msgAt];
  if (msg === undefined) {
    method.apply(this, args);
    return;
  }
  const ok = typeof msg === "string" && LOG_MESSAGE_ALLOWLIST.some((re) => re.test(msg));
  method.apply(this, [...args.slice(0, msgAt), ok ? msg : REDACTED_MESSAGE]);
}

/**
 * Longest doc id / scope tag accepted (clients mint UUIDs, 36 chars). Keeps every
 * key well under Postgres' btree entry limit, so an oversized id is an unknown
 * doc (404) on every store instead of a database error (503) on one. (Fastify
 * already refuses a doc id over 100 chars with 414; the scope header is the
 * case this guards.)
 */
const MAX_ID_LENGTH = 256;

/** Scope tag reserved for the enrollment control plane; never valid on /sync/:docId. */
const RESERVED_CONTROL_SCOPE = "control";

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
  /**
   * Peers (IPs/CIDRs — the proxy-web network) whose X-Forwarded-For sets req.ip
   * (config.ts loadTrustProxy). Omitted: no proxy is trusted. Never trust-all.
   */
  readonly trustProxy?: readonly string[];
}

function trustProxyOption(list: readonly string[] | undefined): string[] | false {
  if (list === undefined) {
    return false;
  }
  if (list.length === 0 || !list.every(isTrustedProxyEntry)) {
    throw new Error("trustProxy must be a non-empty list of IPs/CIDRs (never trust-all)");
  }
  return [...list];
}

/** Build the relay app over a store (injected so tests can seed the ACL). */
export function buildApp(store: RelayStore, options: BuildAppOptions = {}): FastifyInstance {
  // disableRequestLogging: bodies (opaque ciphertext) and signed headers are
  // never written to a log line (H-PUB-4, defence in depth).
  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      serializers: SERIALIZERS,
      hooks: { logMethod: guardLogMessage },
      ...(options.logStream === undefined ? {} : { stream: options.logStream }),
    },
    disableRequestLogging: true,
    trustProxy: trustProxyOption(options.trustProxy),
    // 414 (doc id over maxParamLength) and a malformed URL bypass setErrorHandler
    // unless routed here; Fastify's own bodies for them echo the filled path.
    frameworkErrors: handleError,
    clientErrorHandler,
  });
  app.setErrorHandler(handleError);
  // The default 404 body names the method + filled path.
  app.setNotFoundHandler((req, reply) => {
    failRequest(req, reply, 404, "not_found", undefined, "request rejected");
  });
  const nonces = new NonceCache();

  // Per-IP rate limiting (H-PUB-5) — app-level defence in depth in front of the
  // authorizing /sync routes, additional to the NPM/WAF layer. Keyed on req.ip,
  // which is the real client only via a TRUST_PROXY peer (else the socket peer).
  // The thrown error reaches handleError → {error: "rate_limited", record_id}.
  // State is in-process (single-instance Phase 0; a shared store is a follow-on).
  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx) =>
      Object.assign(new Error("rate limited"), { statusCode: ctx.statusCode }),
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
    // The `control` scope is reserved for enrollment (device-enrollment spec
    // §5.5, EU-0): it never carries a data stream.
    if (
      verified.scope === RESERVED_CONTROL_SCOPE ||
      docId.includes("\u0000") ||
      verified.scope.includes("\u0000") ||
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

  // Routes live in a plugin registered AFTER the rate limiter: @fastify/rate-limit
  // attaches through an onRoute hook that exists only once it has loaded, so a
  // route added directly on `app` here would never be limited (TEACH-55 found
  // exactly that on main 6d987a2: 305 requests from one IP, all 200).
  app.register(async (routes) => {
    routes.get("/health", async () => ({ status: "ok", service: "sync-relay" }));

    // Fetch updates after ?since for an opaque doc id.
    routes.get("/sync/:docId", async (req, reply) => {
      const { docId } = req.params as { docId: string };
      try {
        const verified = await authorizeDoc(req, reply, rawBodyOf(req), docId);
        if (verified === null) {
          return reply;
        }
        const raw = (req.query as { since?: unknown }).since;
        const since = parseCursor(typeof raw === "string" ? raw : undefined);
        const result = await store.fetch(docId, since);
        const payload: SyncPullResult = { cursor: result.cursor, updates: result.updates };
        return reply.send(payload);
      } catch (err) {
        return storeUnavailable(req, reply, err);
      }
    });

    // Append encrypted updates for an opaque doc id.
    routes.post("/sync/:docId", async (req, reply) => {
      const rawBody = rawBodyOf(req);
      const { docId } = req.params as { docId: string };
      try {
        const verified = await authorizeDoc(req, reply, rawBody, docId);
        if (verified === null) {
          return reply;
        }
        const updates = parsePushUpdates(rawBody);
        if (updates === null) {
          // Return the reply, not sendError's record_id: an async handler that
          // returns a value after sending makes Fastify log "Reply was already
          // sent … in /sync/<filled doc id>".
          sendError(reply, 400, "bad_request");
          return reply;
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
  });

  return app;
}
