// Relying-party configuration (D-ARCH-3 posture B). The app is reachable over
// public HTTPS at the confirmed hosts; the RP id and origin are fixed to them.
// rpConfigForHost FAILS CLOSED: an unknown host yields no options, so a foreign
// origin cannot obtain a registration/authentication challenge.

export interface RpConfig {
  readonly rpName: string;
  /** The WebAuthn RP id — the registrable host, no scheme/port. */
  readonly rpID: string;
  /** The exact expected origin (scheme + host) for ceremony verification. */
  readonly origin: string;
}

/** Production host (phase0-build-notes Q1). */
export const PROD_RP: RpConfig = {
  rpName: "Teacher Assistant",
  rpID: "ta.stabpablo.com",
  origin: "https://ta.stabpablo.com",
};

/** QA host (phase0-build-notes Q1). */
export const QA_RP: RpConfig = {
  rpName: "Teacher Assistant (QA)",
  rpID: "ta-qa.stabpablo.com",
  origin: "https://ta-qa.stabpablo.com",
};

/**
 * Resolve the RP config for a request host. Returns the QA or PROD config for the
 * two known hosts and throws for anything else — an unknown origin never gets a
 * challenge (fail-closed, H-PUB hardening).
 */
export function rpConfigForHost(host: string): RpConfig {
  const h = host.toLowerCase().split(":")[0];
  if (h === QA_RP.rpID) {
    return QA_RP;
  }
  if (h === PROD_RP.rpID) {
    return PROD_RP;
  }
  throw new Error(`no RP config for host ${host}`);
}
