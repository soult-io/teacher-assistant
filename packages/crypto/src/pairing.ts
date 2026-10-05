// E1 pairing helpers (device-enrollment-spec rev 2.1 §4.2, §6). The trusted device A
// shows a 256-bit one-time pairing secret S (QR, or a typed Crockford fallback). Both
// devices derive from S:
//   - sid = hex(BLAKE2b-128) — the opaque mailbox id the relay sees (signed bodies only);
//   - K   = BLAKE2b-256      — the AEAD key for the two mailbox blobs.
// The relay stores the blobs but never sees S or K, so it cannot open or forge them:
// a substituted or tampered blob fails AEAD and the device aborts ("Pairing interrupted").
//
// Derivation note: libsodium's keyed BLAKE2b needs a 16–64-byte key, so S (32 bytes)
// is the KEY and the domain label is the MESSAGE — BLAKE2b(label, key = S), a PRF of
// S. The labels separate the two outputs; neither reveals S or the other.
//
// Blob AAD = "ta-pair-v1|<purpose>|<sid>": the sid binds a blob to its pairing, and
// the purpose ("request" | "grant") binds its direction, so the relay cannot hand the
// request blob back as a grant (both are sealed under the same K).

import { decodeCrockford, encodeCrockford, groupFours } from "./crockford.js";
import { type EnrollmentRequest, parseEnrollmentRequest } from "./enrollment.js";
import { aeadDecrypt, aeadEncrypt, keyedHash, randomBytes, toHex, utf8 } from "./sodium.js";

const PAIRING_SECRET_BYTES = 32; // 256 bits
const SID_BYTES = 16; // 128 bits
const PAIRING_KEY_BYTES = 32;

/** Which mailbox slot a blob belongs to: B → A (request) or A → B (grant). */
export type PairingPurpose = "request" | "grant";

/**
 * Thrown when a pairing input does not verify: a blob that fails AEAD (substituted,
 * tampered, wrong sid or direction), a request that is malformed, or a typed secret
 * that does not decode. The UI shows "Pairing interrupted". The message carries no
 * secret, sid or key.
 */
export class PairingError extends Error {
  constructor(reason: string) {
    super(`pairing failed: ${reason}`);
    this.name = "PairingError";
  }
}

/** A fresh one-time pairing secret S (32 random bytes). */
export function newPairingSecret(): Uint8Array {
  return randomBytes(PAIRING_SECRET_BYTES);
}

function assertSecret(secret: Uint8Array): void {
  if (secret.length !== PAIRING_SECRET_BYTES) {
    throw new PairingError("pairing secret must be 32 bytes");
  }
}

/** The mailbox id: lower-case hex of BLAKE2b-128 keyed by S over "ta-pair-sid". */
export function pairingSid(secret: Uint8Array): string {
  assertSecret(secret);
  return toHex(keyedHash(secret, utf8("ta-pair-sid"), SID_BYTES));
}

/** The mailbox AEAD key: BLAKE2b-256 keyed by S over "ta-pair-key". */
export function pairingKey(secret: Uint8Array): Uint8Array {
  assertSecret(secret);
  return keyedHash(secret, utf8("ta-pair-key"), PAIRING_KEY_BYTES);
}

function pairingAad(sid: string, purpose: PairingPurpose): Uint8Array {
  return utf8(`ta-pair-v1|${purpose}|${sid}`);
}

/** Seal a mailbox blob under K, binding the sid and the direction as AAD. */
export function sealPairing(
  key: Uint8Array,
  sid: string,
  purpose: PairingPurpose,
  plaintext: Uint8Array,
): Uint8Array {
  return aeadEncrypt(key, plaintext, pairingAad(sid, purpose));
}

/** Open a mailbox blob. Throws PairingError unless it was sealed under K for this sid and direction. */
export function openPairing(
  key: Uint8Array,
  sid: string,
  purpose: PairingPurpose,
  blob: Uint8Array,
): Uint8Array {
  try {
    return aeadDecrypt(key, blob, pairingAad(sid, purpose));
  } catch {
    throw new PairingError("blob did not verify");
  }
}

/** B: seal its enrollment request (both public keys + nonce) for the request slot. */
export function sealEnrollmentRequest(
  key: Uint8Array,
  sid: string,
  request: EnrollmentRequest,
): Uint8Array {
  return sealPairing(key, sid, "request", utf8(JSON.stringify(request)));
}

/** A: open B's request and validate it. Throws PairingError on any failure. */
export function openEnrollmentRequest(
  key: Uint8Array,
  sid: string,
  blob: Uint8Array,
): EnrollmentRequest {
  const plaintext = openPairing(key, sid, "request", blob);
  try {
    return parseEnrollmentRequest(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new PairingError("malformed request");
  }
}

/** The typed fallback for S: 52 Crockford characters in groups of four. */
export function encodePairingSecret(secret: Uint8Array): string {
  assertSecret(secret);
  return groupFours(encodeCrockford(secret));
}

/** Decode a typed (or scanned) pairing secret. Throws PairingError unless it is exactly 32 bytes. */
export function decodePairingSecret(text: string): Uint8Array {
  const secret = decodeCrockford(text, PAIRING_SECRET_BYTES);
  if (secret === undefined) {
    throw new PairingError("pairing code is not valid");
  }
  return secret;
}
