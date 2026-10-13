// Device signing identity (architecture §1.4/§1.5). Each device holds an Ed25519
// signing keypair, separate from its X25519 key-wrapping keypair. The signing
// public key is the device's identity to the sync-relay: the relay's ACL is
// keyed on it, and each relay request is signed with the private key to prove
// possession (the relay verifies with libsodium directly — it never imports this
// package, because it never decrypts).
//
// The signing PRIVATE key, like every private key, never crosses the wire and is
// never serialised. In the browser it lives ONLY inside the device vault (vault.ts) and
// is unwrapped into memory after unlock — never as a WebCrypto key at rest, which would
// stay usable while locked (device-enrollment-spec rev 2.1 N1).

import { KeyringDestroyedError } from "./keyring.js";
import { isAllZero, signDetached, type SodiumSignKeyPair, signKeypair } from "./sodium.js";

/** An Ed25519 device signing keypair. */
export type DeviceSigningKeypair = SodiumSignKeyPair;

/** Generate a fresh device signing keypair. */
export function generateSigningKeypair(): DeviceSigningKeypair {
  return signKeypair();
}

/**
 * Sign `message` with a device signing private key (detached Ed25519). An all-zero key
 * was zeroized by a lock; it throws KeyringDestroyedError rather than sign with zeros
 * (device-enrollment-spec §11 EU-6: while locked, no signing operation is possible).
 */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  if (isAllZero(privateKey)) {
    throw new KeyringDestroyedError();
  }
  return signDetached(message, privateKey);
}

// NOTE: there is deliberately no verifySignature export here. The only component
// that verifies request signatures is the sync-relay, which must NOT import this
// package (it never decrypts) and uses libsodium's verify directly instead.
