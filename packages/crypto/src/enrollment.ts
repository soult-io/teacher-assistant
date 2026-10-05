// Device + para enrollment (architecture §1.4, H-PUB-1). New devices are added
// by wrapping a key to the new device's public key, gated by an OUT-OF-BAND QR
// confirmation from an already-trusted device.
//
// The OOB gate is two conditions, both required:
//   1. Approval runs on a TEACHER keyring — i.e. a device that already holds the
//      (unlocked) master key. A bare authenticated session cannot approve, so
//      "enrollment is not initiable by auth alone" (and account recovery, which
//      needs the paper code, is not a softer path into this).
//   2. The approver must pass the verification code the human read on the enrolling
//      device and typed in. approveX recomputes the expected code from the request
//      it received and refuses unless they match — binding approval to BOTH keys the
//      enrolling device generated (the X25519 box key that receives the grant and
//      the Ed25519 signing key that is its relay identity), not to anything the
//      server relays (device-enrollment-spec rev 2.1 §6, §4.2).
//
// The teacher enrollment wraps the MASTER key (full teacher device). The para
// enrollment wraps ONLY the assigned period's DEK — never MK — so the para device
// can never derive any other key (FERPA Item-2b least-privilege).

import type { OpaqueId, ScopeTag } from "@teacher-assistant/schema";
import { groupFours } from "./crockford.js";
import type { DeviceKeypair, MasterKey, PeriodDek, PeriodKey } from "./keys.js";
import type { TeacherKeyring } from "./keyring.js";
import {
  boxPublicKeyBytes,
  fromBase64,
  genericHash,
  randomBytes,
  sealOpen,
  signPublicKeyBytes,
  toBase64,
  toHex,
  utf8,
} from "./sodium.js";

/** Thrown when the out-of-band verification code does not match the enrolling device. */
export class EnrollmentConfirmationError extends Error {
  constructor() {
    super("enrollment verification code does not match the enrolling device");
    this.name = "EnrollmentConfirmationError";
  }
}

/**
 * What an enrolling device sends to the approver: its box (wrapping) public key, its
 * signing public key (the relay ACL identity) and a freshness nonce.
 */
export interface EnrollmentRequest {
  /** X25519 public key — the grant is sealed to it. */
  readonly devicePublicKeyB64: string;
  /** Ed25519 public key — the device's relay identity (`x-ta-device`). */
  readonly signingPublicKeyB64: string;
  readonly nonceB64: string;
}

/** The two public keys an enrolling device puts into its request. */
export interface EnrollingDeviceKeys {
  readonly boxPublicKey: Uint8Array;
  readonly signingPublicKey: Uint8Array;
}

/**
 * Teacher-device grant: the wrapped MK plus the (non-secret) master scope tag and the
 * master doc id, so the new device can open the master stream (spec §3.2).
 */
export interface DeviceEnrollmentGrant {
  readonly wrappedMasterKeyB64: string;
  readonly masterScopeTag: ScopeTag;
  readonly masterDocId: OpaqueId;
}

/**
 * Para-device grant: the wrapped Period DEK plus its (non-secret) scope tag and the
 * para doc id. Never MK (spec §3.2).
 */
export interface ParaEnrollmentGrant {
  readonly wrappedDekB64: string;
  readonly scopeTag: ScopeTag;
  readonly paraDocId: OpaqueId;
}

const FINGERPRINT_BYTES = 8; // 64-bit OOB fingerprint
const NONCE_BYTES = 16;

function assertLength(bytes: Uint8Array, expected: number, what: string): void {
  if (bytes.length !== expected) {
    throw new Error(`${what} must be ${expected} bytes`);
  }
}

/**
 * The human-comparable verification code: a 64-bit BLAKE2b fingerprint of
 * `boxPk ‖ signPk ‖ nonce`, rendered as grouped hex. All three inputs have fixed
 * lengths (checked), so the concatenation is unambiguous.
 *
 * (1) 64 bits makes it infeasible to grind a substitute key pair whose code collides
 * with the genuine displayed code — so an attacker who swaps EITHER key in a relayed
 * request cannot match the code (a 6-digit code would be ~20 bits, grindable in
 * minutes). (2) Binding the nonce makes the code per-enrollment, so it cannot be
 * precomputed across sessions.
 */
export function deviceVerificationCode(
  boxPublicKey: Uint8Array,
  signingPublicKey: Uint8Array,
  nonce: Uint8Array,
): string {
  assertLength(boxPublicKey, boxPublicKeyBytes(), "box public key");
  assertLength(signingPublicKey, signPublicKeyBytes(), "signing public key");
  assertLength(nonce, NONCE_BYTES, "enrollment nonce");
  const material = new Uint8Array(boxPublicKey.length + signingPublicKey.length + nonce.length);
  material.set(boxPublicKey, 0);
  material.set(signingPublicKey, boxPublicKey.length);
  material.set(nonce, boxPublicKey.length + signingPublicKey.length);
  return groupFours(toHex(genericHash(material, FINGERPRINT_BYTES)));
}

/** On the enrolling device: build the request + the code to display. */
export function createEnrollmentRequest(keys: EnrollingDeviceKeys): {
  readonly request: EnrollmentRequest;
  readonly verificationCode: string;
} {
  const nonce = randomBytes(NONCE_BYTES);
  return {
    request: {
      devicePublicKeyB64: toBase64(keys.boxPublicKey),
      signingPublicKeyB64: toBase64(keys.signingPublicKey),
      nonceB64: toBase64(nonce),
    },
    verificationCode: deviceVerificationCode(keys.boxPublicKey, keys.signingPublicKey, nonce),
  };
}

/** Encode an enrollment request as a compact QR-friendly string. */
export function encodeEnrollmentRequest(request: EnrollmentRequest): string {
  return toBase64(utf8(JSON.stringify(request)));
}

/** The request's three fields decoded, each checked for its exact length. Throws otherwise. */
function decodeRequestKeys(request: EnrollmentRequest): {
  readonly boxPublicKey: Uint8Array;
  readonly signingPublicKey: Uint8Array;
  readonly nonce: Uint8Array;
} {
  const boxPublicKey = fromBase64(request.devicePublicKeyB64);
  const signingPublicKey = fromBase64(request.signingPublicKeyB64);
  const nonce = fromBase64(request.nonceB64);
  assertLength(boxPublicKey, boxPublicKeyBytes(), "box public key");
  assertLength(signingPublicKey, signPublicKeyBytes(), "signing public key");
  assertLength(nonce, NONCE_BYTES, "enrollment nonce");
  return { boxPublicKey, signingPublicKey, nonce };
}

/**
 * Validate an untrusted parsed value as an EnrollmentRequest: the three base64 fields
 * (any others are dropped), each decoding to the right length. Throws otherwise.
 */
export function parseEnrollmentRequest(parsed: unknown): EnrollmentRequest {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("malformed enrollment request");
  }
  const { devicePublicKeyB64, signingPublicKeyB64, nonceB64 } = parsed as Record<string, unknown>;
  if (
    typeof devicePublicKeyB64 !== "string" ||
    typeof signingPublicKeyB64 !== "string" ||
    typeof nonceB64 !== "string"
  ) {
    throw new Error("malformed enrollment request");
  }
  const request = { devicePublicKeyB64, signingPublicKeyB64, nonceB64 };
  decodeRequestKeys(request);
  return request;
}

/** Decode a scanned enrollment-request string. Throws on any malformed or wrong-length field. */
export function decodeEnrollmentRequest(encoded: string): EnrollmentRequest {
  return parseEnrollmentRequest(JSON.parse(new TextDecoder().decode(fromBase64(encoded))));
}

/** Canonicalise a typed code: lower-case hex, no separators or whitespace. */
function normalizeVerificationCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, "");
}

/**
 * Recompute the code from the request and compare with what the human typed. Returns
 * the box public key the grant must be sealed to. Throws EnrollmentConfirmationError
 * on a mismatch (including a substituted box or signing key) or an empty code.
 */
function assertConfirmed(request: EnrollmentRequest, confirmedCode: string): Uint8Array {
  const { boxPublicKey, signingPublicKey, nonce } = decodeRequestKeys(request);
  const expected = deviceVerificationCode(boxPublicKey, signingPublicKey, nonce);
  if (normalizeVerificationCode(expected) !== normalizeVerificationCode(confirmedCode)) {
    throw new EnrollmentConfirmationError();
  }
  return boxPublicKey;
}

/**
 * On a trusted teacher device: approve enrolling a new TEACHER device by wrapping
 * the master key to its box public key. Requires the OOB verification code (gate 2)
 * and a teacher keyring holding MK (gate 1).
 */
export function approveDeviceEnrollment(
  teacherKeyring: TeacherKeyring,
  request: EnrollmentRequest,
  confirmedCode: string,
  masterDocId: OpaqueId,
): DeviceEnrollmentGrant {
  const boxPublicKey = assertConfirmed(request, confirmedCode);
  return {
    wrappedMasterKeyB64: toBase64(teacherKeyring.sealMasterKeyToDevice(boxPublicKey)),
    masterScopeTag: teacherKeyring.masterScopeTag,
    masterDocId,
  };
}

/** On the new teacher device: unwrap the master key from the grant. */
export function completeDeviceEnrollment(
  keypair: DeviceKeypair,
  grant: DeviceEnrollmentGrant,
): { readonly mk: MasterKey; readonly masterScopeTag: ScopeTag } {
  const mk = sealOpen(fromBase64(grant.wrappedMasterKeyB64), keypair) as MasterKey;
  return { mk, masterScopeTag: grant.masterScopeTag };
}

/**
 * On a trusted teacher device: approve enrolling a PARA device by wrapping ONLY
 * the assigned period's DEK. Requires the OOB code. Throws NoKeyForScopeError if
 * the teacher keyring does not hold that period's key — or if the tag is the master
 * scope tag, so a para grant can never carry MK.
 */
export function approveParaEnrollment(
  teacherKeyring: TeacherKeyring,
  periodScopeTag: ScopeTag,
  request: EnrollmentRequest,
  confirmedCode: string,
  paraDocId: OpaqueId,
): ParaEnrollmentGrant {
  const boxPublicKey = assertConfirmed(request, confirmedCode);
  return {
    wrappedDekB64: toBase64(teacherKeyring.sealPeriodKeyToDevice(periodScopeTag, boxPublicKey)),
    scopeTag: periodScopeTag,
    paraDocId,
  };
}

/** On the new para device: unwrap the Period DEK into a PeriodKey (build a ParaKeyring from it). */
export function completeParaEnrollment(
  keypair: DeviceKeypair,
  grant: ParaEnrollmentGrant,
): PeriodKey {
  const dek = sealOpen(fromBase64(grant.wrappedDekB64), keypair) as PeriodDek;
  return { scopeTag: grant.scopeTag, dek };
}
