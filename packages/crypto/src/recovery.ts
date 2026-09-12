// Paper recovery code (D-ARCH-1, LOCKED). A printed high-entropy code also wraps
// the master key. It is the ONLY backstop against the D1 irrecoverable-loss risk,
// and it preserves "the server can't read": the code lives OFF PALLAS, and only
// the wrapped-MK blob (ciphertext) + its salt are stored server-side — never a
// share of the key itself.
//
// The code is machine-generated with ≥160 bits of entropy, rendered in Crockford
// base32 (no ambiguous I/L/O/U) for transcription. Argon2id stretches it
// (sodium.ts documents why INTERACTIVE parameters suffice for a high-entropy code).

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
} from "./sodium.js";

// Crockford base32 alphabet (excludes I, L, O, U to avoid transcription errors).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_ENTROPY_BYTES = 20; // 160 bits

/** The server-storable wrap of MK by the recovery code (both halves are non-secret on their own). */
export interface RecoveryWrap {
  /** Argon2id salt, URL-safe base64. */
  readonly saltB64: string;
  /** The AEAD-wrapped master key, URL-safe base64. */
  readonly blobB64: string;
}

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Generate a fresh printable recovery code, grouped in fours for transcription. */
export function generateRecoveryCode(): string {
  const raw = encodeCrockford(randomBytes(RECOVERY_ENTROPY_BYTES));
  return (raw.match(/.{1,4}/g) ?? [raw]).join("-");
}

/**
 * Canonicalise a typed code: uppercase, drop separators/whitespace, and fold the
 * Crockford aliases (O→0, I/L→1) so a human transcription matches the original.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Wrap the master key with a recovery code. Store the result server-side; keep the code on paper. */
export function wrapMasterKeyWithRecoveryCode(mk: MasterKey, code: string): RecoveryWrap {
  const salt = randomBytes(pwhashSaltBytes());
  const key = deriveKeyFromSecret(utf8(normalizeRecoveryCode(code)), salt);
  const blob = aeadEncrypt(key, mk, utf8("recovery-wrap"));
  return { saltB64: toBase64(salt), blobB64: toBase64(blob) };
}

/** Recover the master key from the recovery code + its stored wrap. Throws if the code is wrong. */
export function unwrapMasterKeyWithRecoveryCode(code: string, wrap: RecoveryWrap): MasterKey {
  const salt = fromBase64(wrap.saltB64);
  const key = deriveKeyFromSecret(utf8(normalizeRecoveryCode(code)), salt);
  return aeadDecrypt(key, fromBase64(wrap.blobB64), utf8("recovery-wrap")) as MasterKey;
}
