// Key types + generation (architecture §1.4). Two tiers:
//   - Teacher master key (MK): symmetric root on Niah's devices only. Encrypts
//     goal definitions, MYP scores, differentiation, exports, statements.
//   - Period DEK: one symmetric key per class period. Encrypts only the
//     para-visible projection of that period.
// Plus a per-device X25519 keypair used to wrap keys to a device at enrollment.
//
// Keys are branded byte arrays. They are never serialised to JSON, a log, or the
// wire as plaintext — only WRAPPED (ciphertext) forms cross a boundary. The
// Keyring holds them in private fields (keyring.ts) so they cannot leak through
// structured-clone / JSON.stringify.

import type { ScopeTag } from "@teacher-assistant/schema";
import { boxKeypair, randomSymmetricKey, type SodiumKeyPair } from "./sodium.js";

/** The teacher master key (32-byte XChaCha20 key). Held only on teacher devices. */
export type MasterKey = Uint8Array & { readonly __kind: "MasterKey" };

/** A per-period data-encryption key (32-byte XChaCha20 key). */
export type PeriodDek = Uint8Array & { readonly __kind: "PeriodDek" };

/** A Period DEK together with the opaque scope tag that names it in envelopes. */
export interface PeriodKey {
  readonly scopeTag: ScopeTag;
  readonly dek: PeriodDek;
}

/**
 * A device key-wrapping keypair (X25519). In the browser the private key should
 * live as a non-extractable WebCrypto key or in the OS keystore; the public key
 * is the only half that is ever transmitted (in the enrollment QR).
 */
export type DeviceKeypair = SodiumKeyPair;

/** Generate a fresh teacher master key. */
export function generateMasterKey(): MasterKey {
  return randomSymmetricKey() as MasterKey;
}

/** Generate a fresh Period DEK with its opaque scope tag. */
export function generatePeriodKey(scopeTag: ScopeTag): PeriodKey {
  return { scopeTag, dek: randomSymmetricKey() as PeriodDek };
}

/** Generate a device key-wrapping keypair. */
export function generateDeviceKeypair(): DeviceKeypair {
  return boxKeypair();
}
