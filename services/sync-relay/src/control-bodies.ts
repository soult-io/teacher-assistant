// Strict request bodies for the control routes — owner-code redeem, the owner
// routes and the pairing mailbox (device-enrollment spec §5.3, TEACH-59 / EU-3,
// TEACH-60 / EU-4). Every body is a
// JSON object with EXACTLY the named keys: an unknown field — a device label, a
// name, anything — is a 400, so no plaintext can reach the relay through a
// control route. Identifiers travel only here, in the signed body, never in the
// URL.

import type { DeviceRole, ScopeGrant, ScopeKind } from "./store.js";

/** Longest device key accepted; the same bound as the data routes. */
const MAX_KEY_LENGTH = 256;
/** Most scopes one grant may carry (spec §5.3). */
export const MAX_GRANT_SCOPES = 16;
/** Largest recovery-wrap or pairing blob, in characters (spec §5.3: ≤ 4 KiB). */
export const MAX_BLOB_LENGTH = 4096;

/** A device signing key as sent in x-ta-device: base64, standard or URL-safe. */
const DEVICE_KEY = /^[A-Za-z0-9+/_-]+={0,2}$/;
/**
 * A scope tag is the client's `newScopeTag()` — a random UUID and nothing else,
 * so a label, a period name or initials can never be registered as a tag (spec
 * §5.3 "no labels"). This also rules out the reserved `control` scope. Lowercase
 * only, as randomUUID() mints: the store matches tags exactly, so an uppercase
 * spelling would be a different scope.
 */
const SCOPE_TAG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An opaque sealed blob: base64 alphabet plus `.` as a field separator. */
const BLOB = /^[A-Za-z0-9+/_.=-]+$/;
const KINDS: ReadonlySet<string> = new Set<ScopeKind>(["master", "period"]);
/** A pairing sid: `pairingSid()`'s lower-case hex of a BLAKE2b-128 — 32 characters, nothing else. */
const SID = /^[0-9a-f]{32}$/;
/** The pairing role a grant names, and the relay role it enrolls (spec §4.2, §4.3). */
const PAIRING_ROLES: ReadonlyMap<unknown, DeviceRole> = new Map([
  ["teacher", "owner"],
  ["para", "member"],
]);

/** `value` as a record, or null unless it is a plain object with exactly `keys`. */
function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k))
    ? (value as Record<string, unknown>)
    : null;
}

/** The parsed object, or null unless the body is a JSON object with exactly `keys`. */
function exactObject(rawBody: Uint8Array, keys: readonly string[]): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
  return exactKeys(parsed, keys);
}

function isDeviceKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_KEY_LENGTH && DEVICE_KEY.test(value);
}

function isScopeTag(value: unknown): value is string {
  return typeof value === "string" && SCOPE_TAG.test(value);
}

function isSid(value: unknown): value is string {
  return typeof value === "string" && SID.test(value);
}

/** An opaque blob, `too_large` over 4 KiB (413), or null if it is not one (400). */
function parseBlob(value: unknown): string | "too_large" | null {
  if (typeof value !== "string" || !BLOB.test(value)) {
    return null;
  }
  return value.length > MAX_BLOB_LENGTH ? "too_large" : value;
}

function parseScope(value: unknown): ScopeGrant | null {
  const scope = exactKeys(value, ["tag", "kind"]);
  if (scope === null || !isScopeTag(scope.tag)) {
    return null;
  }
  const kind = scope.kind;
  return typeof kind === "string" && KINDS.has(kind)
    ? { tag: scope.tag, kind: kind as ScopeKind }
    : null;
}

/** 1..16 scopes, each exactly `{tag, kind}` with a lower-case UUID tag; else null. */
function parseScopes(value: unknown): readonly ScopeGrant[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GRANT_SCOPES) {
    return null;
  }
  const scopes = value.map(parseScope);
  return scopes.every((s): s is ScopeGrant => s !== null) ? scopes : null;
}

/**
 * POST /sync/enroll/redeem: `{code}`. The code is checked by the owner-code
 * hash, not here.
 */
export function parseRedeemBody(rawBody: Uint8Array): string | null {
  const body = exactObject(rawBody, ["code"]);
  return body !== null && typeof body.code === "string" ? body.code : null;
}

/** POST /sync/devices/list: exactly `{}`. */
export function parseListBody(rawBody: Uint8Array): Readonly<Record<string, never>> | null {
  return exactObject(rawBody, []) === null ? null : {};
}

/** POST /sync/devices/grant: `{device, scopes: [{tag, kind}] (1..16)}`. */
export function parseGrantBody(
  rawBody: Uint8Array,
): { readonly device: string; readonly scopes: readonly ScopeGrant[] } | null {
  const body = exactObject(rawBody, ["device", "scopes"]);
  const scopes = parseScopes(body?.scopes);
  return body !== null && isDeviceKey(body.device) && scopes !== null
    ? { device: body.device, scopes }
    : null;
}

/** POST /sync/devices/revoke: `{device}`. */
export function parseRevokeBody(rawBody: Uint8Array): string | null {
  const body = exactObject(rawBody, ["device"]);
  return body !== null && isDeviceKey(body.device) ? body.device : null;
}

/** POST /sync/devices/retire-scope: `{tag}`. */
export function parseRetireBody(rawBody: Uint8Array): string | null {
  const body = exactObject(rawBody, ["tag"]);
  return body !== null && isScopeTag(body.tag) ? body.tag : null;
}

/**
 * POST /sync/devices/recovery-wrap: `{blob}`. `too_large` for a well-formed blob
 * over 4 KiB (413), null for any other malformed body (400).
 */
export function parseRecoveryWrapBody(
  rawBody: Uint8Array,
): { readonly blob: string } | "too_large" | null {
  const blob = parseBlob(exactObject(rawBody, ["blob"])?.blob);
  return blob === null || blob === "too_large" ? blob : { blob };
}

/**
 * POST /sync/enroll/pairing/open, request-get and grant-get: `{sid}`. The sid
 * travels only here, never in the URL (spec §4.2, FERPA item 6).
 */
export function parsePairingSidBody(rawBody: Uint8Array): string | null {
  const body = exactObject(rawBody, ["sid"]);
  return body !== null && isSid(body.sid) ? body.sid : null;
}

/** POST /sync/enroll/pairing/request-put: `{sid, blob}`; `too_large` for a blob over 4 KiB. */
export function parsePairingRequestBody(
  rawBody: Uint8Array,
): { readonly sid: string; readonly blob: string } | "too_large" | null {
  const body = exactObject(rawBody, ["sid", "blob"]);
  if (body === null || !isSid(body.sid)) {
    return null;
  }
  const blob = parseBlob(body.blob);
  return blob === null || blob === "too_large" ? blob : { sid: body.sid, blob };
}

/** A parsed grant-put: the pairing role already mapped to the relay role it enrolls. */
export interface PairingGrantBody {
  readonly sid: string;
  readonly device: string;
  readonly role: DeviceRole;
  readonly scopes: readonly ScopeGrant[];
  readonly blob: string;
}

/**
 * POST /sync/enroll/pairing/grant-put: `{sid, device, role: teacher|para,
 * scopes: [{tag, kind}] (1..16), blob}`. `teacher` enrolls an `owner`, `para` a
 * `member`; scope tags follow the same lower-case UUID rule as the owner grant.
 * `too_large` for a well-formed body whose blob is over 4 KiB.
 */
export function parsePairingGrantBody(rawBody: Uint8Array): PairingGrantBody | "too_large" | null {
  const body = exactObject(rawBody, ["sid", "device", "role", "scopes", "blob"]);
  const role = PAIRING_ROLES.get(body?.role);
  const scopes = parseScopes(body?.scopes);
  if (
    body === null ||
    !isSid(body.sid) ||
    !isDeviceKey(body.device) ||
    role === undefined ||
    scopes === null
  ) {
    return null;
  }
  const blob = parseBlob(body.blob);
  return blob === null || blob === "too_large"
    ? blob
    : { sid: body.sid, device: body.device, role, scopes, blob };
}
