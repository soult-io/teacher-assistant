// The ONLY module that touches libsodium. Everything else in the crypto package
// builds on these typed primitives, which keeps the sodium-ready lifecycle and
// the wire formats in one auditable place.
//
// Primitives (architecture §1.4):
//   - XChaCha20-Poly1305 IETF  — record AEAD (24-byte nonce, AAD-bound).
//   - X25519 crypto_box_seal   — wrap a key to a device public key (anonymous
//                                sender; the recipient unwraps with its private
//                                key). Used for enrollment (MK / Period DEK).
//   - Argon2id (crypto_pwhash) — stretch the paper recovery code.

// The "sumo" build is required: the standard libsodium-wrappers build omits
// crypto_pwhash (Argon2id), which the paper-recovery wrap depends on.
import _sodium from "libsodium-wrappers-sumo";

let ready = false;

/** Await libsodium init once. Safe to call repeatedly; cheap after the first. */
export async function sodiumReady(): Promise<void> {
  if (ready) {
    return;
  }
  await _sodium.ready;
  // Fail loud if the installed libsodium build lacks a primitive we depend on
  // (e.g. a non-sumo build missing Argon2id) rather than misbehaving at runtime.
  for (const fn of [
    "crypto_aead_xchacha20poly1305_ietf_encrypt",
    "crypto_aead_xchacha20poly1305_ietf_decrypt",
    "crypto_box_seal",
    "crypto_box_seal_open",
    "crypto_pwhash",
  ] as const) {
    if (typeof _sodium[fn] !== "function") {
      throw new Error(`libsodium build is missing ${fn} — install the full build`);
    }
  }
  ready = true;
}

function s(): typeof _sodium {
  if (!ready) {
    throw new Error("crypto used before sodiumReady() resolved — await sodiumReady() first");
  }
  return _sodium;
}

/** A fresh 32-byte symmetric key (for MK / Period DEK). */
export function randomSymmetricKey(): Uint8Array {
  return s().crypto_aead_xchacha20poly1305_ietf_keygen();
}

/** `n` cryptographically-random bytes. */
export function randomBytes(n: number): Uint8Array {
  return s().randombytes_buf(n);
}

/**
 * Encrypt `plaintext` under `key`, binding `aad` (identity-clean envelope bytes).
 * Wire format: nonce(24) ‖ ciphertext. The AAD is authenticated but not stored.
 */
export function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const sodium = s();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/** Decrypt a `nonce ‖ ciphertext` blob. Throws if the key, AAD, or tag do not match. */
export function aeadDecrypt(key: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array {
  const sodium = s();
  const npub = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (blob.length < npub) {
    throw new Error("ciphertext too short");
  }
  const nonce = blob.subarray(0, npub);
  const ct = blob.subarray(npub);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, key);
}

/** X25519 keypair bytes. In the browser the private key should be stored as a non-extractable WebCrypto/OS-keystore key; it never crosses the wire. */
export interface SodiumKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** Generate an X25519 keypair for key-wrapping (crypto_box). */
export function boxKeypair(): SodiumKeyPair {
  const kp = s().crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** Seal (wrap) `key` to a recipient's X25519 public key. Anonymous sender. */
export function sealTo(key: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  return s().crypto_box_seal(key, recipientPublicKey);
}

/** Open a sealed blob with the recipient's keypair. Throws if it was not sealed to this key. */
export function sealOpen(sealed: Uint8Array, kp: SodiumKeyPair): Uint8Array {
  return s().crypto_box_seal_open(sealed, kp.publicKey, kp.privateKey);
}

/** An Ed25519 signing keypair (device auth to the relay — NOT a key-wrapping key). */
export interface SodiumSignKeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** Generate an Ed25519 signing keypair. */
export function signKeypair(): SodiumSignKeyPair {
  const kp = s().crypto_sign_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** Detached Ed25519 signature over `message`. */
export function signDetached(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return s().crypto_sign_detached(message, privateKey);
}

// Signature VERIFICATION lives only in the sync-relay (services/sync-relay/
// sodium-verify.ts), which uses libsodium directly — the crypto package is the
// client key layer and never needs to verify a request signature.

/** Argon2id salt length (16 bytes). */
export function pwhashSaltBytes(): number {
  return s().crypto_pwhash_SALTBYTES;
}

/**
 * Stretch a high-entropy secret (the paper recovery code) into a 32-byte wrapping
 * key with Argon2id. INTERACTIVE parameters are used deliberately: the recovery
 * code carries ≥128 bits of entropy by construction (it is machine-generated, not
 * a human passphrase), so the heavier MODERATE/SENSITIVE parameters — meant to
 * slow brute force of weak passphrases — buy nothing here. The system has no
 * password path (H-PUB-1), so no low-entropy secret is ever stretched.
 */
export function deriveKeyFromSecret(secret: Uint8Array, salt: Uint8Array): Uint8Array {
  const sodium = s();
  return sodium.crypto_pwhash(
    32,
    secret,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** BLAKE2b hash of `data` truncated to `outLen` bytes (used for device fingerprints). Unkeyed. */
export function genericHash(data: Uint8Array, outLen: number): Uint8Array {
  return s().crypto_generichash(outLen, data, null);
}

/** Constant-time equality for two byte arrays. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  // sodium.memcmp requires equal length (checked above).
  return s().memcmp(a, b);
}

/** Zero a key buffer in place (best-effort hygiene; GC still holds copies). */
export function zeroize(buf: Uint8Array): void {
  s().memzero(buf);
}

/** Base64 (URL-safe, no padding) encode — for transport of opaque blobs. */
export function toBase64(data: Uint8Array): string {
  return s().to_base64(data, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** Decode a URL-safe base64 string produced by toBase64. */
export function fromBase64(text: string): Uint8Array {
  return s().from_base64(text, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

/** Lower-case hex encode (for human-comparable fingerprints). */
export function toHex(data: Uint8Array): string {
  return s().to_hex(data);
}

/** UTF-8 encode. */
export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
