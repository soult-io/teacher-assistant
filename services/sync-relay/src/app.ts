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
// TEACH-55 (EU-0) logging contract: see logging.ts — every error path answers
// `{error, record_id}` and logs at most `{record_id, route, status, sqlstate}`.

import rateLimit from "@fastify/rate-limit";
import {
  canonicalRequest,
  SYNC_HEADERS,
  type SyncPullResult,
  type SyncPushBody,
  type SyncPushResult,
} from "@teacher-assistant/schema";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { isTrustedProxyEntry } from "./config.js";
import {
  parseGrantBody,
  parseListBody,
  parseRecoveryWrapBody,
  parseRetireBody,
  parseRevokeBody,
} from "./control-bodies.js";
import {
  clientErrorHandler,
  failRequest,
  guardLogMessage,
  keepLogFields,
  handleError,
  LOG_LEVEL,
  OWNER_CODES_INVALIDATED,
  SERIALIZERS,
  sendError,
} from "./logging.js";
import { ownerCodeHash } from "./owner-code.js";
import { type RedeemAttempt, RedeemGuard } from "./redeem-guard.js";
import { fromBase64, sodiumReady, verifyDetached } from "./sodium-verify.js";
import { parseCursor, type RedeemResult, type RelayStore } from "./store.js";

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

/**
 * A store failure (e.g. the database is unreachable) → 503. A 503 means
 * "outcome unknown": a timed-out append may still have committed, so a client
 * retry can append the same updates again (CRDT updates are idempotent to apply,
 * so this is safe for the sync client).
 */
function storeUnavailable(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  failRequest(req, reply, 503, "unavailable", err, "sync store unavailable");
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

/** Control routes have two or more path segments, so they never match /sync/:docId (spec DN-5). */
const REDEEM_ROUTE = "/sync/enroll/redeem";

/** The owner control routes (spec §5.3, EU-3). Identifiers travel only in the signed body. */
const OWNER_ROUTES = {
  list: "/sync/devices/list",
  grant: "/sync/devices/grant",
  revoke: "/sync/devices/revoke",
  retireScope: "/sync/devices/retire-scope",
  recoveryWrap: "/sync/devices/recovery-wrap",
} as const;

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

/**
 * The redeem body's code, or null unless the body is exactly `{code: string}`
 * (spec §5.3: strict bodies, an unknown field is 400).
 */
function parseRedeemBody(rawBody: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed);
  const code: unknown = (parsed as { code?: unknown }).code;
  return keys.length === 1 && keys[0] === "code" && typeof code === "string" ? code : null;
}

/** POST /sync/enroll/redeem success body (spec §5.3). */
interface RedeemResponse {
  readonly mode: "first" | "recovery";
  readonly recovery_wrap: string | null;
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
  /** Clock (ms) for the redeem lockout; tests inject one. */
  readonly now?: () => number;
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
      formatters: { log: keepLogFields },
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
  const redeemGuard = new RedeemGuard(options.now);

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

  /**
   * One redeem attempt, before any reply: a malformed body, a refusal (bad
   * signature, a non-control scope, or a code the store refuses), or the mode.
   * Expired codes are swept first (spec §5.1: at the start of every control route).
   */
  async function attemptRedeem(
    req: FastifyRequest,
    rawBody: Uint8Array,
  ): Promise<RedeemResult | "bad_request"> {
    const verified = verifyRequest(req, rawBody, nonces);
    if (verified === null || verified.scope !== RESERVED_CONTROL_SCOPE) {
      return "refused";
    }
    const code = parseRedeemBody(rawBody);
    if (code === null) {
      return "bad_request";
    }
    await store.sweepExpired();
    const hash = ownerCodeHash(code);
    return hash === undefined
      ? "refused"
      : store.redeemOwnerCode(hash, verified.devicePublicKeyB64);
  }

  /** Count a refused redeem; past the global limit, invalidate every unused code (spec §5.5). */
  async function countRedeemFailure(req: FastifyRequest, attempt: RedeemAttempt): Promise<void> {
    if (attempt.fail()) {
      await store.invalidateOwnerCodes(); // a throw leaves the count over the limit: the next failure retries
      redeemGuard.burned();
      req.log.warn({ route: REDEEM_ROUTE }, OWNER_CODES_INVALIDATED);
    }
  }

  async function redeemResponse(mode: "first" | "recovery"): Promise<RedeemResponse> {
    const wrap = mode === "recovery" ? await store.getRecoveryWrap() : undefined;
    return { mode, recovery_wrap: wrap ?? null };
  }

  /**
   * The owner-route preamble (spec §5.3): a valid signature under the reserved
   * `control` scope from an ACTIVE owner, else the identical H-PUB-3 404 — a
   * non-owner, a revoked device, a bad signature and an unknown route all look
   * the same. Expired codes and pairing sessions are then swept (spec §5.1: at
   * the start of every control route). Returns the raw body, or null after the
   * 404 was sent.
   */
  async function authorizeOwner(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Uint8Array | null> {
    const rawBody = rawBodyOf(req);
    const verified = verifyRequest(req, rawBody, nonces);
    if (
      verified === null ||
      verified.scope !== RESERVED_CONTROL_SCOPE ||
      (await store.deviceRole(verified.devicePublicKeyB64)) !== "owner"
    ) {
      notFound(reply);
      return null;
    }
    await store.sweepExpired();
    return rawBody;
  }

  /** A refused control operation: `{error, record_id}` plus the one permitted log line. */
  function conflict(req: FastifyRequest, reply: FastifyReply, code: string): FastifyReply {
    failRequest(req, reply, 409, code, undefined, "request rejected");
    return reply;
  }

  /**
   * Register one owner route: the preamble, then the strict body parser (null →
   * 400), then the handler. Any store failure is the 503 "outcome unknown".
   */
  function ownerRoute<T>(
    routes: FastifyInstance,
    path: string,
    parse: (rawBody: Uint8Array) => T | null,
    handle: (body: T, req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>,
  ): void {
    routes.post(path, async (req, reply) => {
      try {
        const rawBody = await authorizeOwner(req, reply);
        if (rawBody === null) {
          return reply;
        }
        const body = parse(rawBody);
        if (body === null) {
          sendError(reply, 400, "bad_request");
          return reply;
        }
        return await handle(body, req, reply);
      } catch (err) {
        return storeUnavailable(req, reply, err);
      }
    });
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

    // Redeem an operator owner code (device-enrollment spec §5.3, F1/F5). The
    // signer becomes an owner. Every failure — bad signature, a non-control
    // scope, a wrong, used, expired or malformed code, a key the relay already
    // knows (revoked, member or owner) — is the identical 401 and counts toward
    // the lockout. A locked-out IP (or the global key) gets 429 before the code
    // is looked at. Neither the code nor its hash is ever logged (§5.6).
    routes.post(REDEEM_ROUTE, async (req, reply) => {
      const attempt = redeemGuard.begin(req.ip);
      if (attempt === undefined) {
        failRequest(req, reply, 429, "rate_limited", undefined, "request rejected");
        return reply;
      }
      try {
        const outcome = await attemptRedeem(req, rawBodyOf(req));
        if (outcome === "bad_request") {
          sendError(reply, 400, "bad_request");
          return reply;
        }
        if (outcome === "refused") {
          await countRedeemFailure(req, attempt);
          sendError(reply, 401, "unauthorized");
          return reply;
        }
        attempt.succeed();
        return reply.send(await redeemResponse(outcome));
      } catch (err) {
        return storeUnavailable(req, reply, err);
      } finally {
        attempt.release();
      }
    });

    // Owner control routes (spec §5.3, F4/F5). Every refusal before the body is
    // read is the identical 404 (authorizeOwner); revoked is permanent, so a
    // grant replayed after a revoke — even on a restarted relay with an empty
    // nonce cache — is refused by the store (spec §5.4).
    ownerRoute(
      routes,
      OWNER_ROUTES.list,
      (raw) => (parseListBody(raw) ? {} : null),
      async (_b, _req, reply) => reply.send({ devices: await store.listDevices() }),
    );

    ownerRoute(
      routes,
      OWNER_ROUTES.grant,
      parseGrantBody,
      async ({ device, scopes }, req, reply) =>
        (await store.grantScopes(device, scopes)) === "ok"
          ? reply.send({})
          : conflict(req, reply, "conflict"),
    );

    ownerRoute(routes, OWNER_ROUTES.revoke, parseRevokeBody, async (device, req, reply) =>
      (await store.revoke(device)) === "ok" ? reply.send({}) : conflict(req, reply, "last_owner"),
    );

    // The master scope is never retired (FERPA re-review N3).
    ownerRoute(routes, OWNER_ROUTES.retireScope, parseRetireBody, async (tag, req, reply) => {
      const result = await store.retireScope(tag);
      if (result === "master_scope") {
        return conflict(req, reply, "master_scope");
      }
      if (result === "not_found") {
        notFound(reply);
        return reply;
      }
      return reply.send({});
    });

    ownerRoute(
      routes,
      OWNER_ROUTES.recoveryWrap,
      parseRecoveryWrapBody,
      async (body, _req, reply) => {
        if (body === "too_large") {
          sendError(reply, 413, "payload_too_large");
          return reply;
        }
        await store.putRecoveryWrap(body.blob);
        return reply.send({});
      },
    );

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
