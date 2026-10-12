// The passkey gate (M0-AUTH / H-PUB-1). A verified passkey authentication is
// what unlocks the device-held wrapped keys — auth GATES decryption
// (@teacher-assistant/auth unlockTeacherKeyring). This module is the ONLY place
// the app knows the ceremony's verified-response shape, so the WebAuthn/relay
// verifier can be swapped without touching the rest of the app.
//
// U1 SEAM (documented for teacher-assistant-12): the app is offline-first and
// synthetic-only, and the content-api relay that runs the server-side
// verifyAuthenticationResponse is not wired yet. The SyntheticPasskeyGateway
// stands in for it — it represents the unlock gesture and yields a verified
// response for the synthetic session. It changes NO engine code: the real
// binding (unlockTeacherKeyring's `verified` guard + the crypto key-unwrap) runs
// for real. A live gateway (begin/finishAuthentication over content-api, or a
// local RP verify for offline unlock) replaces only this port.

import type { VerifiedAuthenticationResponse } from "@simplewebauthn/server";

/** Port: present the passkey UV gesture and resolve with a verified auth response. */
export interface PasskeyGateway {
  authenticate(): Promise<VerifiedAuthenticationResponse>;
}

/**
 * The offline/synthetic gateway. It does not fabricate a server session — it
 * yields the minimal verified marker the unlock binding checks, for a synthetic
 * caseload with no real credentials. Replace with a content-api-backed gateway
 * when services land; the unlock path downstream is unchanged.
 */
export class SyntheticPasskeyGateway implements PasskeyGateway {
  authenticate(): Promise<VerifiedAuthenticationResponse> {
    // Only `verified` is read by unlockTeacherKeyring; the rest of the
    // server-verification payload is absent in the offline synthetic session.
    return Promise.resolve({ verified: true } as VerifiedAuthenticationResponse);
  }
}
