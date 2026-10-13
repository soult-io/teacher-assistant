// The device vault (device-enrollment-spec rev 2.4 DN-1, §3.1). Each enrolled device
// keeps its private keys in ONE AEAD wrap under a key-encryption key (KEK), chosen once
// at enrollment by tier:
//
//   - Tier P (WebAuthn PRF): KEK = BLAKE2b-256(message = "ta-vault-kek-v1", key = PRF
//     output). The PRF output is the key because libsodium keys must be 16–64 bytes.
//   - Tier W (passphrase):   KEK = HMAC-SHA-256(Kdev, Argon2id(passphrase, salt)), where
//     Kdev is a NON-EXTRACTABLE WebCrypto HMAC key that never leaves the browser profile,
//     and Argon2id runs at libsodium MODERATE or stronger. Every guess therefore costs
//     Argon2id plus an HMAC that only this profile can compute.
//
// No intermediate is ever stored: the record holds the salt and the vault ciphertext,
// never the Argon2id output, the HMAC output, the PRF output or the KEK. The vault binds
// the tier and both public keys as AEAD additional data, so a vault cannot be replayed
// under another tier or another device identity.
//
// The vault plaintext is signSk (64) ‖ boxSk (32) ‖ recordKey (32). `recordKey` is a
// random key that exists only inside the vault; after unlock it AEAD-protects the
// stored enrollment grant (FERPA EU-5 carry-forward: the grant is AEAD-protected at
// rest), so storing a grant later never needs the KEK again.

import {
  aeadDecrypt,
  aeadEncrypt,
  argon2idModerate,
  argon2idModerateParams,
  boxKeypair,
  isAllZero,
  keyedHash,
  pwhashSaltBytes,
  randomBytes,
  signKeypair,
  toBase64,
  utf8,
  zeroize,
} from "./sodium.js";

/** Thrown when a vault or a stored grant does not open: wrong KEK, wrong tier or wrong device. */
export class VaultOpenError extends Error {
  constructor() {
    super("the device vault did not open");
    this.name = "VaultOpenError";
  }
}

/** The tier is fixed at enrollment; changing it means re-enrolling (a new identity). */
export type VaultTier = "prf" | "passphrase";

/** What the vault is bound to (AEAD additional data). All non-secret. */
export interface VaultBinding {
  readonly tier: VaultTier;
  readonly signPk: Uint8Array;
  readonly boxPk: Uint8Array;
}

/** The secrets held inside the vault. Memory-only, and only after unlock. */
export interface VaultSecrets {
  /** Ed25519 secret key (libsodium layout: seed ‖ public key). */
  readonly signSk: Uint8Array;
  /** X25519 secret key — opens grants sealed to boxPk. */
  readonly boxSk: Uint8Array;
  /** AEAD key for the grant at rest. */
  readonly recordKey: Uint8Array;
}

const SIGN_SK_BYTES = 64;
const BOX_SK_BYTES = 32;
const RECORD_KEY_BYTES = 32;
const VAULT_PLAINTEXT_BYTES = SIGN_SK_BYTES + BOX_SK_BYTES + RECORD_KEY_BYTES;
const KEK_BYTES = 32;
const PRF_OUTPUT_BYTES = 32;
const TIER_P_KEK_LABEL = "ta-vault-kek-v1";
const VAULT_AAD = "ta-device-vault-v1";
const GRANT_AAD = "ta-device-grant-v1";

/**
 * The passphrase rule (DN-1): at least 8 characters containing both letters and digits,
 * or at least 10 digits. A 6-digit PIN is never accepted.
 */
export function isAcceptablePassphrase(passphrase: string): boolean {
  if (/^\d{10,}$/.test(passphrase)) {
    return true;
  }
  return [...passphrase].length >= 8 && /\p{L}/u.test(passphrase) && /\d/.test(passphrase);
}

/**
 * The Argon2id cost for a passphrase. Never below libsodium MODERATE (opslimit 3,
 * memlimit 256 MiB): if unlock is too slow on a phone, the fix is auto-lock timing,
 * never a lower cost (spec §10). Functions, because the constants need sodium ready.
 */
export const PASSPHRASE_ARGON2 = argon2idModerateParams;

/** A fresh 16-byte Argon2id salt (stored with the vault; non-secret). */
export function newVaultSalt(): Uint8Array {
  return randomBytes(pwhashSaltBytes());
}

/** Argon2id(passphrase, salt) at ≥ MODERATE. Refuses a passphrase that breaks the rule. */
export function stretchPassphrase(passphrase: string, salt: Uint8Array): Uint8Array {
  if (!isAcceptablePassphrase(passphrase)) {
    throw new Error(
      "passphrase does not meet the rule (8+ with letters and digits, or 10+ digits)",
    );
  }
  const bytes = utf8(passphrase);
  try {
    return argon2idModerate(bytes, salt);
  } finally {
    zeroize(bytes);
  }
}

/** Tier P: KEK = keyed BLAKE2b-256 (key = the 32-byte PRF output, message = the label). */
export function deriveTierPKek(prfOutput: Uint8Array): Uint8Array {
  if (prfOutput.length !== PRF_OUTPUT_BYTES || isAllZero(prfOutput)) {
    throw new VaultOpenError();
  }
  return keyedHash(prfOutput, utf8(TIER_P_KEK_LABEL), KEK_BYTES);
}

/** Tier W: a fresh NON-EXTRACTABLE HMAC-SHA-256 key (Kdev), usable only to sign. */
export function generateKdev(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}

/** Tier W: KEK = HMAC-SHA-256(Kdev, Argon2id(passphrase, salt)). The stretched value is zeroized. */
export async function deriveTierWKek(
  kdev: CryptoKey,
  passphrase: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const stretched = stretchPassphrase(passphrase, salt);
  // WebCrypto takes a BufferSource; copy into a fresh ArrayBuffer, zeroized below too.
  const input = new Uint8Array(stretched);
  try {
    return new Uint8Array(await crypto.subtle.sign("HMAC", kdev, input.buffer));
  } finally {
    zeroize(stretched);
    zeroize(input);
  }
}

function vaultAad(binding: VaultBinding): Uint8Array {
  return utf8(
    `${VAULT_AAD}|${binding.tier}|${toBase64(binding.signPk)}|${toBase64(binding.boxPk)}`,
  );
}

/** Generate a new device identity: both keypairs plus the record key. Keys are made once, never on unlock. */
export function generateVaultSecrets(): {
  readonly signPk: Uint8Array;
  readonly boxPk: Uint8Array;
  readonly secrets: VaultSecrets;
} {
  const signing = signKeypair();
  const box = boxKeypair();
  return {
    signPk: signing.publicKey,
    boxPk: box.publicKey,
    secrets: {
      signSk: signing.privateKey,
      boxSk: box.privateKey,
      recordKey: randomBytes(RECORD_KEY_BYTES),
    },
  };
}

/** Wrap the secrets once, directly under the KEK. Returns nonce ‖ ciphertext. */
export function sealVault(
  kek: Uint8Array,
  secrets: VaultSecrets,
  binding: VaultBinding,
): Uint8Array {
  const plaintext = new Uint8Array(VAULT_PLAINTEXT_BYTES);
  plaintext.set(secrets.signSk, 0);
  plaintext.set(secrets.boxSk, SIGN_SK_BYTES);
  plaintext.set(secrets.recordKey, SIGN_SK_BYTES + BOX_SK_BYTES);
  try {
    return aeadEncrypt(kek, plaintext, vaultAad(binding));
  } finally {
    zeroize(plaintext);
  }
}

/** Open the vault. Throws VaultOpenError for a wrong KEK, tier or device binding. */
export function openVault(kek: Uint8Array, vault: Uint8Array, binding: VaultBinding): VaultSecrets {
  let plaintext: Uint8Array;
  try {
    plaintext = aeadDecrypt(kek, vault, vaultAad(binding));
  } catch {
    throw new VaultOpenError();
  }
  try {
    if (plaintext.length !== VAULT_PLAINTEXT_BYTES) {
      throw new VaultOpenError();
    }
    return {
      signSk: plaintext.slice(0, SIGN_SK_BYTES),
      boxSk: plaintext.slice(SIGN_SK_BYTES, SIGN_SK_BYTES + BOX_SK_BYTES),
      recordKey: plaintext.slice(SIGN_SK_BYTES + BOX_SK_BYTES),
    };
  } finally {
    zeroize(plaintext);
  }
}

/** Zeroize every vault secret in place (lock). */
export function zeroizeVaultSecrets(secrets: VaultSecrets): void {
  zeroize(secrets.signSk);
  zeroize(secrets.boxSk);
  zeroize(secrets.recordKey);
}

function grantAad(signPk: Uint8Array): Uint8Array {
  return utf8(`${GRANT_AAD}|${toBase64(signPk)}`);
}

/** AEAD-protect the serialized enrollment grant at rest under the vault's record key. */
export function sealGrantAtRest(
  recordKey: Uint8Array,
  signPk: Uint8Array,
  grant: Uint8Array,
): Uint8Array {
  return aeadEncrypt(recordKey, grant, grantAad(signPk));
}

/** Open a grant sealed by sealGrantAtRest. Throws VaultOpenError on any mismatch. */
export function openGrantAtRest(
  recordKey: Uint8Array,
  signPk: Uint8Array,
  sealed: Uint8Array,
): Uint8Array {
  try {
    return aeadDecrypt(recordKey, sealed, grantAad(signPk));
  } catch {
    throw new VaultOpenError();
  }
}
