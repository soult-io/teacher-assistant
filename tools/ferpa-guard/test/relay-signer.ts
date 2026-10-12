// Test helper: a device that signs relay requests the way the sync client does
// (Ed25519 over the canonical request), so FERPA tests can drive the real relay.

import { generateSigningKeypair, sign, toBase64, utf8 } from "@teacher-assistant/crypto";
import { canonicalRequest, SYNC_HEADERS } from "@teacher-assistant/schema";

export interface Signer {
  readonly publicKeyB64: string;
  sign(
    method: "GET" | "POST",
    path: string,
    scope: string,
    body: Uint8Array,
  ): Record<string, string>;
}

/** Call after sodiumReady(). */
export function makeSigner(): Signer {
  const kp = generateSigningKeypair();
  return {
    publicKeyB64: toBase64(kp.publicKey),
    sign(method, path, scope, body) {
      const ts = String(Date.now());
      const nonce = toBase64(utf8(`${Math.random()}`));
      const canonical = canonicalRequest(method, path, scope, ts, nonce, body);
      return {
        [SYNC_HEADERS.device]: toBase64(kp.publicKey),
        [SYNC_HEADERS.scope]: scope,
        [SYNC_HEADERS.timestamp]: ts,
        [SYNC_HEADERS.nonce]: nonce,
        [SYNC_HEADERS.signature]: toBase64(sign(canonical, kp.privateKey)),
        "content-type": "application/json",
      };
    },
  };
}
