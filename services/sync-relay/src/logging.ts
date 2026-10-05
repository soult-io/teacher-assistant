// TEACH-55 (EU-0) error + logging contract for sync-relay. Every error path —
// route errors, framework errors (413/414/415/bad URL), the rate limit, unknown
// routes and client errors before routing (431) — answers `{error, record_id}`
// and logs at most `{record_id, route, status, sqlstate}`. `route` is the
// TEMPLATE (`/sync/:docId`), never the filled URL; no header, IP, query, body or
// error message is logged (H-PUB-4).
//
// Kept apart from app.ts so new routes reuse it rather than re-deriving it: the
// message allowlist below must name every message the relay logs.

import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { SyncErrorBody } from "@teacher-assistant/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorCode } from "./sql.js";

/** Send the identity-clean error body; returns its opaque record_id. */
export function sendError(reply: FastifyReply, status: number, code: string): string {
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
export function failRequest(
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

/** Wire `error` codes for the statuses Fastify and its plugins raise. */
const ERROR_CODES: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  408: "timeout",
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
export function handleError(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
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
export function clientErrorHandler(
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
    error: ERROR_CODES[status] ?? "bad_request",
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
export const SERIALIZERS = {
  req: (req: FastifyRequest) => ({ route: routeOf(req) }),
  res: (res: { statusCode: number }) => ({ status: res.statusCode }),
  // An error is reduced to its class name: message and stack are replaced, and
  // attached fields (pg's detail/where/…) are dropped. Fastify's types require
  // the message/stack keys, so they carry a fixed marker.
  err: (err: Error) => ({ type: err.name, message: "(redacted)", stack: "(redacted)" }),
};

/** Production log level, pinned (FERPA re-review N4): never debug/trace in a deploy. */
export const LOG_LEVEL = "info";

/**
 * The only log messages that pass verbatim. Fastify interpolates the FILLED URL
 * into some of its own messages (e.g. "Reply was already sent … in /sync/<doc>"),
 * which no serializer can reach, so every other message is replaced. The
 * listening line is the deploy's startup check ("(store: postgres)").
 */
const LOG_MESSAGE_ALLOWLIST: readonly RegExp[] = [
  /^(sync store unavailable|request failed|request rejected|client error)$/,
  /^sync-relay listening on \S+ \(store: (memory|postgres)\)$/, // = listeningMessage()
];
const REDACTED_MESSAGE = "(log message redacted)";

/** pino `hooks.logMethod`: pass the message only if it is allowlisted; drop interpolation args. */
export function guardLogMessage(
  this: unknown,
  args: unknown[],
  method: (...args: unknown[]) => void,
): void {
  const msgAt = typeof args[0] === "string" ? 0 : 1;
  const msg = args[msgAt];
  if (msg === undefined) {
    // No message: pino would fall back to err.message (`{err}`, a bare Error —
    // Fastify's FST_ERR_REP_ALREADY_SENT carries the filled URL) or to an
    // object's own `msg` field. Always supply the redacted one.
    method.apply(this, [args[0], REDACTED_MESSAGE]);
    return;
  }
  const ok = typeof msg === "string" && LOG_MESSAGE_ALLOWLIST.some((re) => re.test(msg));
  method.apply(this, [...args.slice(0, msgAt), ok ? msg : REDACTED_MESSAGE]);
}

/** The startup line (the deploy checks for "(store: postgres)"); allowlisted above. */
export function listeningMessage(addr: string, kind: "memory" | "postgres"): string {
  return `sync-relay listening on ${addr} (store: ${kind})`;
}

/** The only fields a log line may carry beyond pino's own (level, time, pid, hostname, reqId, msg). */
const LOG_FIELDS: ReadonlySet<string> = new Set(["record_id", "route", "status", "sqlstate"]);

/**
 * pino `formatters.log`: keep only LOG_FIELDS from the logged object. Whatever
 * shape a Fastify or plugin log call uses (`{url}`, `{req}`, `{err}`, …), no
 * other field reaches the line — serializers alone only cover known keys.
 */
export function keepLogFields(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => LOG_FIELDS.has(k)));
}
