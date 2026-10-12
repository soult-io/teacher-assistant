// Ed25519 request-signature VERIFICATION only. The relay authenticates devices by
// checking signatures against registered public keys; it holds no DEK/MK and
// NEVER decrypts a record blob. It therefore uses libsodium directly and does NOT
// import @teacher-assistant/crypto (the no-decrypt invariant, asserted by the
// FERPA-guard suite).

import _sodium from "libsodium-wrappers-sumo";

let ready = false;

export async function sodiumReady(): Promise<void> {
  if (ready) {
    return;
  }
  await _sodium.ready;
  ready = true;
}

function s(): typeof _sodium {
  if (!ready) {
    throw new Error("sodiumReady() must resolve before verification");
  }
  return _sodium;
}

/** Verify a detached Ed25519 signature. Returns false on any malformed input. */
export function verifyDetached(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return s().crypto_sign_verify_detached(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Decode a URL-safe base64 string; throws on malformed input. */
export function fromBase64(text: string): Uint8Array {
  return s().from_base64(text, _sodium.base64_variants.URLSAFE_NO_PADDING);
}
