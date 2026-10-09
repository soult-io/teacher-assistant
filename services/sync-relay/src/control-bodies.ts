// Strict request bodies for the control routes — owner-code redeem and the
// owner routes (device-enrollment spec §5.3, TEACH-59 / EU-3). Every body is a
// JSON object with EXACTLY the named keys: an unknown field — a device label, a
// name, anything — is a 400, so no plaintext can reach the relay through a
// control route. Identifiers travel only here, in the signed body, never in the
// URL.

import type { ScopeGrant, ScopeKind } from "./store.js";

/** Longest device key accepted; the same bound as the data routes. */
const MAX_KEY_LENGTH = 256;
/** Most scopes one grant may carry (spec §5.3). */
export const MAX_GRANT_SCOPES = 16;
/** Largest recovery-wrap blob, in characters (spec §5.3: ≤ 4 KiB). */
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
  if (body === null || !isDeviceKey(body.device) || !Array.isArray(body.scopes)) {
    return null;
  }
  const raw: unknown[] = body.scopes;
  if (raw.length === 0 || raw.length > MAX_GRANT_SCOPES) {
    return null;
  }
  const scopes = raw.map(parseScope);
  return scopes.every((s): s is ScopeGrant => s !== null) ? { device: body.device, scopes } : null;
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
  const body = exactObject(rawBody, ["blob"]);
  const blob = body?.blob;
  if (typeof blob !== "string" || !BLOB.test(blob)) {
    return null;
  }
  return blob.length > MAX_BLOB_LENGTH ? "too_large" : { blob };
}
