// Passkey / WebAuthn ceremonies (H-PUB-1). SimpleWebAuthn is pinned
// (@simplewebauthn/server 14.0.1) as the primary and ONLY authentication factor.
// There is NO password anywhere in this package: no password field, no password
// verify, no password-reset path. Every ceremony REQUIRES user verification
// (UV) and discoverable credentials (resident keys), so the factor is
// phishing-resistant and hardware-bound.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import type { RpConfig } from "./config.js";

/** The teacher/para identity a passkey is registered against (opaque id + label; no PII required). */
export interface AuthUser {
  /** Opaque user handle bytes (never derived from student data). */
  readonly id: Uint8Array;
  /** A non-PII account label (e.g. the opaque user id rendered) for the authenticator UI. */
  readonly name: string;
  readonly displayName?: string;
}

/** Begin passkey registration — discoverable credential + UV required, no attestation collected. */
export function beginRegistration(
  cfg: RpConfig,
  user: AuthUser,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: user.name,
    // Copy into a fresh ArrayBuffer-backed view (SimpleWebAuthn types userID as
    // Uint8Array<ArrayBuffer>, not the generic ArrayBufferLike).
    userID: Uint8Array.from(user.id),
    userDisplayName: user.displayName ?? user.name,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
  });
}

/** Verify a registration response. Always requires UV and binds the expected origin + RP id. */
export function finishRegistration(
  cfg: RpConfig,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    requireUserVerification: true,
  });
}

/** Begin passkey authentication — UV required; discoverable credentials (no allowlist needed). */
export function beginAuthentication(cfg: RpConfig): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: cfg.rpID,
    userVerification: "required",
  });
}

/** Verify an authentication response against a stored credential. Always requires UV. */
export function finishAuthentication(
  cfg: RpConfig,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: WebAuthnCredential,
): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: cfg.origin,
    expectedRPID: cfg.rpID,
    credential,
    requireUserVerification: true,
  });
}
