// The auth ↔ keyring binding (architecture §1.4). The auth/enrollment boundary IS
// the confidentiality boundary: a successful passkey authentication is what lets
// the device use its keypair to unwrap the locally-stored enrollment grant (the
// wrapped MK / Period DEK) into an in-memory keyring. Auth GATES decryption; it
// never holds plaintext keys server-side.
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

/** Thrown when a keyring unlock is attempted without a verified passkey authentication. */
export class AuthRequiredError extends Error {
  constructor() {
    super("a verified passkey authentication is required before unlocking keys");
    this.name = "AuthRequiredError";
  }
}

export interface TeacherUnlockInput {
  /** MUST be the `verified` flag from finishAuthentication — the auth gate. */
  readonly authenticationVerified: boolean;
  /** This device's keypair (available once the passkey/OS unlock succeeds). */
  readonly deviceKeypair: DeviceKeypair;
  /** The locally-persisted enrollment grant wrapping the master key. */
  readonly grant: DeviceEnrollmentGrant;
}

export interface ParaUnlockInput {
  readonly authenticationVerified: boolean;
  readonly deviceKeypair: DeviceKeypair;
  readonly grant: ParaEnrollmentGrant;
}

/** Unlock the teacher keyring after a verified passkey auth. Throws AuthRequiredError otherwise. */
export function unlockTeacherKeyring(input: TeacherUnlockInput): TeacherKeyring {
  if (!input.authenticationVerified) {
    throw new AuthRequiredError();
  }
  const { mk, masterScopeTag } = completeDeviceEnrollment(input.deviceKeypair, input.grant);
  return new TeacherKeyring(masterScopeTag, mk);
}

/** Unlock the para keyring (its single Period DEK) after a verified passkey auth. */
export function unlockParaKeyring(input: ParaUnlockInput): ParaKeyring {
  if (!input.authenticationVerified) {
    throw new AuthRequiredError();
  }
  return new ParaKeyring([completeParaEnrollment(input.deviceKeypair, input.grant)]);
}
