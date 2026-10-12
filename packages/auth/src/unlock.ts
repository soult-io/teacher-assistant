// The auth ↔ keyring binding (architecture §1.4). The auth/enrollment boundary IS
// the confidentiality boundary: a successful passkey authentication is what lets
// the device use its keypair to unwrap the locally-stored enrollment grant (the
// wrapped MK / Period DEK) into an in-memory keyring. Auth GATES decryption; it
// never holds plaintext keys server-side.
//
// The gate takes the actual `VerifiedAuthenticationResponse` from
// finishAuthentication (not a bare boolean the caller could fabricate), and
// refuses unless its `verified` flag is true.
//
// Enrollment is deliberately NOT reachable from here: there is no function that
// turns an auth result into an enrollment grant. A new device is added only by a
// trusted device approving its OOB-QR request (crypto's approveDeviceEnrollment /
// approveParaEnrollment), so account takeover via auth cannot enroll a device,
// and account recovery (the paper code) is not a softer enrollment path.

import {
  completeDeviceEnrollment,
  completeParaEnrollment,
  type DeviceEnrollmentGrant,
  type DeviceKeypair,
  type ParaEnrollmentGrant,
  ParaKeyring,
  TeacherKeyring,
} from "@teacher-assistant/crypto";
import type { VerifiedAuthenticationResponse } from "@simplewebauthn/server";

/** Thrown when a keyring unlock is attempted without a verified passkey authentication. */
export class AuthRequiredError extends Error {
  constructor() {
    super("a verified passkey authentication is required before unlocking keys");
    this.name = "AuthRequiredError";
  }
}

export interface TeacherUnlockInput {
  /** The result of finishAuthentication — must carry `verified: true`. */
  readonly authentication: VerifiedAuthenticationResponse;
  /** This device's keypair (available once the passkey/OS unlock succeeds). */
  readonly deviceKeypair: DeviceKeypair;
  /** The locally-persisted enrollment grant wrapping the master key. */
  readonly grant: DeviceEnrollmentGrant;
}

export interface ParaUnlockInput {
  readonly authentication: VerifiedAuthenticationResponse;
  readonly deviceKeypair: DeviceKeypair;
  readonly grant: ParaEnrollmentGrant;
}

/** Unlock the teacher keyring after a verified passkey auth. Throws AuthRequiredError otherwise. */
export function unlockTeacherKeyring(input: TeacherUnlockInput): TeacherKeyring {
  if (!input.authentication.verified) {
    throw new AuthRequiredError();
  }
  const { mk, masterScopeTag } = completeDeviceEnrollment(input.deviceKeypair, input.grant);
  return new TeacherKeyring(masterScopeTag, mk);
}

/** Unlock the para keyring (its single Period DEK) after a verified passkey auth. */
export function unlockParaKeyring(input: ParaUnlockInput): ParaKeyring {
  if (!input.authentication.verified) {
    throw new AuthRequiredError();
  }
  return new ParaKeyring([completeParaEnrollment(input.deviceKeypair, input.grant)]);
}
