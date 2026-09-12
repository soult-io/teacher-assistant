// Record AEAD (architecture §1.3/§1.4). A student-linked record is serialised
// and encrypted client-side into ONE opaque blob; the server stores only the
// blob + the identity-clean envelope.
//
// The envelope's identity-clean fields (record_id, record_type, scope_tag) are
// bound as AEAD additional data, so a captured blob cannot be replayed under a
// different id/type/scope without the tag check failing. The AAD is authenticated,
// never stored inside the blob.

import type { RecordEnvelope } from "@teacher-assistant/schema";
import { aeadDecrypt, aeadEncrypt, utf8 } from "./sodium.js";

/** The identity-clean bytes bound to a record's ciphertext as AEAD additional data. */
export function recordAad(env: RecordEnvelope): Uint8Array {
  return utf8(`${env.record_id}|${env.record_type}|${env.scope_tag}`);
}

/** Encrypt a record payload under `key`, binding the envelope as AAD. */
export function encryptWithKey(
  key: Uint8Array,
  env: RecordEnvelope,
  plaintext: Uint8Array,
): Uint8Array {
  return aeadEncrypt(key, plaintext, recordAad(env));
}

/** Decrypt a record blob under `key`. Throws if key/AAD/tag mismatch. */
export function decryptWithKey(key: Uint8Array, env: RecordEnvelope, blob: Uint8Array): Uint8Array {
  return aeadDecrypt(key, blob, recordAad(env));
}
