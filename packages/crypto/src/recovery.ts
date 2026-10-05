// Paper recovery code (D-ARCH-1, LOCKED). A printed high-entropy code wraps the
// recovery bundle: the master key plus the two non-secret ids a new device needs to
// find the master stream (device-enrollment-spec §4.1 step 7, §4.5). It is the ONLY
// backstop against the D1 irrecoverable-loss risk, and it preserves "the server
// can't read": the code lives OFF PALLAS, and only the wrapped-bundle blob
// (ciphertext) + its salt are stored server-side — never a share of the key itself.
//
// The code is machine-generated with ≥160 bits of entropy, rendered in Crockford
// base32 (no ambiguous I/L/O/U) for transcription. Argon2id stretches it
// (sodium.ts documents why INTERACTIVE parameters suffice for a high-entropy code).

import type { OpaqueId, ScopeTag } from "@teacher-assistant/schema";
import { encodeCrockford, groupFours, normalizeCrockford } from "./crockford.js";
import type { MasterKey } from "./keys.js";
import {
  aeadDecrypt,
  aeadEncrypt,
  deriveKeyFromSecret,
  fromBase64,
  pwhashSaltBytes,
  randomBytes,
  toBase64,
  utf8,
  zeroize,
} from "./sodium.js";

const RECOVERY_ENTROPY_BYTES = 20; // 160 bits
const MASTER_KEY_BYTES = 32;
// The AEAD additional data for the bundle wrap. A new label (the M0 MK-only wrap used
// "recovery-wrap"), so a blob of one format can never be opened as the other.
const BUNDLE_AAD = "ta-recovery-bundle-v1";

/** What the paper code restores on a new device: MK and the ids of the master stream. */
export interface RecoveryBundle {
  readonly mk: MasterKey;
  readonly masterScopeTag: ScopeTag;
  readonly masterDocId: OpaqueId;
}

/** The server-storable wrap of the bundle by the recovery code (both halves are non-secret on their own). */
export interface RecoveryWrap {
  /** Argon2id salt, URL-safe base64. */
  readonly saltB64: string;
  /** The AEAD-wrapped bundle, URL-safe base64. */
  readonly blobB64: string;
}

/** Generate a fresh printable recovery code, grouped in fours for transcription. */
export function generateRecoveryCode(): string {
  return groupFours(encodeCrockford(randomBytes(RECOVERY_ENTROPY_BYTES)));
}

/**
 * Canonicalise a typed code: uppercase, drop separators/whitespace, and fold the
 * Crockford aliases (O→0, I/L→1) so a human transcription matches the original.
 */
export function normalizeRecoveryCode(code: string): string {
  return normalizeCrockford(code);
}

function codeKey(code: string, salt: Uint8Array): Uint8Array {
  return deriveKeyFromSecret(utf8(normalizeRecoveryCode(code)), salt);
}

/**
 * Wrap the recovery bundle with a recovery code (Argon2id-stretched). Store the result
 * server-side; keep the code on paper. Plaintext layout: MK (32 bytes) ‖ UTF-8 JSON of
 * the two ids, so MK never passes through a JS string.
 */
export function wrapRecoveryBundle(bundle: RecoveryBundle, code: string): RecoveryWrap {
  const ids = utf8(
    JSON.stringify({ masterScopeTag: bundle.masterScopeTag, masterDocId: bundle.masterDocId }),
  );
  const plaintext = new Uint8Array(MASTER_KEY_BYTES + ids.length);
  plaintext.set(bundle.mk, 0);
  plaintext.set(ids, MASTER_KEY_BYTES);
  const salt = randomBytes(pwhashSaltBytes());
  const key = codeKey(code, salt);
  try {
    const blob = aeadEncrypt(key, plaintext, utf8(BUNDLE_AAD));
    return { saltB64: toBase64(salt), blobB64: toBase64(blob) };
  } finally {
    zeroize(key);
    zeroize(plaintext);
  }
}

function parseIds(bytes: Uint8Array): { masterScopeTag: ScopeTag; masterDocId: OpaqueId } {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("malformed recovery bundle");
  }
  const { masterScopeTag, masterDocId } = parsed as Record<string, unknown>;
  if (typeof masterScopeTag !== "string" || typeof masterDocId !== "string") {
    throw new Error("malformed recovery bundle");
  }
  return { masterScopeTag: masterScopeTag as ScopeTag, masterDocId: masterDocId as OpaqueId };
}

/** Recover the bundle from the recovery code + its stored wrap. Throws if the code is wrong. */
export function unwrapRecoveryBundle(code: string, wrap: RecoveryWrap): RecoveryBundle {
  const key = codeKey(code, fromBase64(wrap.saltB64));
  let plaintext: Uint8Array;
  try {
    plaintext = aeadDecrypt(key, fromBase64(wrap.blobB64), utf8(BUNDLE_AAD));
  } finally {
    zeroize(key);
  }
  try {
    if (plaintext.length <= MASTER_KEY_BYTES) {
      throw new Error("malformed recovery bundle");
    }
    const ids = parseIds(plaintext.subarray(MASTER_KEY_BYTES));
    return { mk: plaintext.slice(0, MASTER_KEY_BYTES) as MasterKey, ...ids };
  } finally {
    zeroize(plaintext);
  }
}
