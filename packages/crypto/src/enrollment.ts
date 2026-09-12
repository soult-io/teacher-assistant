// Device + para enrollment (architecture §1.4, H-PUB-1). New devices are added
// by wrapping a key to the new device's public key, gated by an OUT-OF-BAND QR
// confirmation from an already-trusted device.
//
// The OOB gate is two conditions, both required:
//   1. Approval runs on a TEACHER keyring — i.e. a device that already holds the
//      (unlocked) master key. A bare authenticated session cannot approve, so
//      "enrollment is not initiable by auth alone" (and account recovery, which
//      needs the paper code, is not a softer path into this).
//   2. The approver must pass the verification code it read out-of-band from the
//      enrolling device (shown beside the QR). approveX recomputes the expected
//      code from the scanned public key and refuses unless they match — binding
//      approval to the physically-scanned key, not to anything the server relays.
//
// The teacher enrollment wraps the MASTER key (full teacher device). The para
// enrollment wraps ONLY the assigned period's DEK — never MK — so the para device
// can never derive any other key (FERPA Item-2b least-privilege).

import type { ScopeTag } from "@teacher-assistant/schema";
import type { DeviceKeypair, MasterKey, PeriodDek, PeriodKey } from "./keys.js";
import type { TeacherKeyring } from "./keyring.js";
import { fromBase64, genericHash, randomBytes, sealOpen, toBase64, toHex, utf8 } from "./sodium.js";

/** Thrown when the out-of-band verification code does not match the scanned key. */
export class EnrollmentConfirmationError extends Error {
  constructor() {
    super("enrollment verification code does not match the enrolling device");
    this.name = "EnrollmentConfirmationError";
  }
}

/** The payload an enrolling device encodes into its QR (public key + freshness nonce). */
export interface EnrollmentRequest {
  readonly devicePublicKeyB64: string;
  readonly nonceB64: string;
}

/** Teacher-device enrollment result: the wrapped MK + the (non-secret) master scope tag. */
export interface DeviceEnrollmentGrant {
  readonly wrappedMasterKeyB64: string;
  readonly masterScopeTag: ScopeTag;
}

/** Para-device enrollment result: the wrapped Period DEK + its (non-secret) scope tag. */
export interface ParaEnrollmentGrant {
  readonly wrappedDekB64: string;
  readonly scopeTag: ScopeTag;
}

const FINGERPRINT_BYTES = 8; // 64-bit OOB fingerprint

/**
 * The human-comparable verification code. Both devices compute it; the human
 * confirms they match over the out-of-band channel (the QR scan). It is a 64-bit
 * BLAKE2b fingerprint of the device public key BOUND TO the request nonce,
 * rendered as grouped hex.
 *
 * Two properties matter. (1) 64 bits makes it infeasible to grind a substitute
 * keypair whose code collides with the genuine displayed code — so an attacker
 * who can swap the public key in a relayed request cannot match the code (a
 * 6-digit code would be ~20 bits, grindable in minutes). (2) Binding the nonce
 * makes the code per-enrollment, not a static function of the public key, so it
 * cannot be precomputed across sessions. (Direct camera-scan of the enrolling
 * screen remains the intended channel; this hardens the relayed-QR case.)
 */
export function deviceVerificationCode(devicePublicKey: Uint8Array, nonce: Uint8Array): string {
  const material = new Uint8Array(devicePublicKey.length + nonce.length);
  material.set(devicePublicKey, 0);
  material.set(nonce, devicePublicKey.length);
  const hex = toHex(genericHash(material, FINGERPRINT_BYTES));
  return (hex.match(/.{1,4}/g) ?? [hex]).join("-");
}

/** On the enrolling device: build the request (for the QR) + the code to display. */
export function createEnrollmentRequest(keypair: DeviceKeypair): {
  readonly request: EnrollmentRequest;
  readonly verificationCode: string;
} {
  const nonce = randomBytes(16);
  return {
    request: {
      devicePublicKeyB64: toBase64(keypair.publicKey),
      nonceB64: toBase64(nonce),
    },
    verificationCode: deviceVerificationCode(keypair.publicKey, nonce),
  };
}

/** Encode an enrollment request as a compact QR-friendly string. */
export function encodeEnrollmentRequest(request: EnrollmentRequest): string {
  return toBase64(utf8(JSON.stringify(request)));
}

/** Decode a scanned enrollment-request string. */
export function decodeEnrollmentRequest(encoded: string): EnrollmentRequest {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64(encoded)));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as EnrollmentRequest).devicePublicKeyB64 !== "string" ||
    typeof (parsed as EnrollmentRequest).nonceB64 !== "string"
  ) {
    throw new Error("malformed enrollment request");
  }
  return parsed as EnrollmentRequest;
}

function assertConfirmed(request: EnrollmentRequest, confirmedCode: string): Uint8Array {
  const pub = fromBase64(request.devicePublicKeyB64);
  const nonce = fromBase64(request.nonceB64);
  if (deviceVerificationCode(pub, nonce) !== confirmedCode) {
    throw new EnrollmentConfirmationError();
  }
  return pub;
}

/**
 * On a trusted teacher device: approve enrolling a new TEACHER device by wrapping
 * the master key to its public key. Requires the OOB verification code (gate 2)
 * and a teacher keyring holding MK (gate 1).
 */
export function approveDeviceEnrollment(
  teacherKeyring: TeacherKeyring,
  request: EnrollmentRequest,
  confirmedCode: string,
): DeviceEnrollmentGrant {
  const pub = assertConfirmed(request, confirmedCode);
  return {
    wrappedMasterKeyB64: toBase64(teacherKeyring.sealMasterKeyToDevice(pub)),
    masterScopeTag: teacherKeyring.masterScopeTag,
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
 * the assigned period's DEK (never MK). Requires the OOB code; throws if the
 * teacher keyring does not hold that period's key.
 */
export function approveParaEnrollment(
  teacherKeyring: TeacherKeyring,
  periodScopeTag: ScopeTag,
  request: EnrollmentRequest,
  confirmedCode: string,
): ParaEnrollmentGrant {
  const pub = assertConfirmed(request, confirmedCode);
  return {
    wrappedDekB64: toBase64(teacherKeyring.sealScopeKeyToDevice(periodScopeTag, pub)),
    scopeTag: periodScopeTag,
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
