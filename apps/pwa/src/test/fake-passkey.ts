// Node-realm test helpers shared by the vault and first-setup suites: a fake WebAuthn
// authenticator (the browser port itself is tested in device/passkey-prf.test.ts) and an
// Android platform environment.

import type { PasskeyAssertion, PasskeyPrfPort } from "../device/passkey-prf.js";
import type { PlatformEnv } from "../device/platform.js";

/**
 * A fake authenticator: a fixed PRF output (or none — Bitwarden, so Tier W) on every
 * user-verified assertion. Records the display names created and the credential ids asked for.
 */
export class FakePasskey implements PasskeyPrfPort {
  assertions = 0;
  readonly names: string[] = [];
  readonly allowed: Uint8Array[] = [];
  credentialId: Uint8Array | null = null;

  constructor(
    public prf: Uint8Array | null,
    public flags = { backupEligible: true, backedUp: true },
  ) {}

  create(displayName: string): Promise<{ credentialId: Uint8Array }> {
    this.names.push(displayName);
    this.credentialId = crypto.getRandomValues(new Uint8Array(16));
    return Promise.resolve({ credentialId: this.credentialId });
  }

  assert(credentialId: Uint8Array): Promise<PasskeyAssertion> {
    this.assertions += 1;
    this.allowed.push(credentialId);
    return Promise.resolve({
      prf: this.prf === null ? null : new Uint8Array(this.prf),
      ...this.flags,
    });
  }
}

/** A Pixel 8a in Chrome; persistent storage granted. */
export function android(overrides: Partial<PlatformEnv> = {}): PlatformEnv {
  return {
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8a) Chrome/130",
    platform: "Linux armv8l",
    maxTouchPoints: 5,
    standaloneMedia: false,
    navigatorStandalone: undefined,
    persist: () => Promise.resolve(true),
    ...overrides,
  };
}
