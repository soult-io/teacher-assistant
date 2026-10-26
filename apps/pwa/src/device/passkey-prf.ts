// The WebAuthn port for the device vault (device-enrollment-spec rev 2.5 DN-1, DN-1a).
//
// Passkeys from any provider (DN-1a): create() sets no authenticatorAttachment, so a
// password manager (Bitwarden), a security key or a phone can hold it. Each device runs
// its own create(), and every get() names only that device's credential (C1). The
// passkey's display name is the device's name, chosen before create() (DN-1a label).
//
// Both ceremonies use `userVerification: "required"`, and an assertion whose
// authenticator data lacks the UV flag is refused here as well, so a presence-only
// touch never unlocks. The PRF extension is requested on create() and evaluated on
// get(); when the authenticator returns PRF output the device is Tier P, otherwise
// Tier W (the decision is made once, at enrollment — see vault.ts).
//
// This is a LOCAL unlock gate: nothing here is sent to a server, and no credential
// store exists server-side (DN-1 option B is not part of this design).

/** Thrown when the ceremony is cancelled or comes back without user verification. */
export class UserVerificationError extends Error {
  constructor() {
    super("user verification is required");
    this.name = "UserVerificationError";
  }
}

/**
 * One user-verified assertion: the PRF output (null when the authenticator gave none) and
 * the BE/BS flags (backup eligible / backed up) from its authenticator data. The flags are
 * kept only in the local DeviceRecord, never sent anywhere (DN-1a C4).
 */
export interface PasskeyAssertion {
  readonly prf: Uint8Array | null;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
}

/** Port: create the device passkey under a display name, and run a UV-required assertion against it. */
export interface PasskeyPrfPort {
  create(displayName: string): Promise<{ readonly credentialId: Uint8Array }>;
  assert(credentialId: Uint8Array): Promise<PasskeyAssertion>;
}

/** The names a teacher device can take (flows S1a). A fixed list: no free text, no student data. */
export const TEACHER_DEVICE_LABELS = [
  "Phone",
  "Tablet",
  "Home computer",
  "School computer",
] as const;
export type TeacherDeviceLabel = (typeof TEACHER_DEVICE_LABELS)[number];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The passkey's display name (DN-1a passkey label), e.g. "Teacher Assistant — Phone, added
 * Oct 9", so she can find this device's passkey in her password manager later.
 */
export function passkeyDisplayName(label: TeacherDeviceLabel, added: Date): string {
  return `${RP_NAME} — ${label}, added ${MONTHS[added.getMonth()]} ${added.getDate()}`;
}

// The PRF evaluation input. Constant: the PRF secret is per credential, so a fixed
// input yields a per-device output.
const PRF_INPUT = new TextEncoder().encode("ta-vault-prf-v1");
const UV_FLAG = 0x04;
const BE_FLAG = 0x08;
const BS_FLAG = 0x10;
const FLAGS_OFFSET = 32; // authenticatorData = rpIdHash (32) ‖ flags (1) ‖ …
const RP_NAME = "Teacher Assistant";
// Bounds a ceremony that never settles, so one hung prompt cannot block later unlocks.
const CEREMONY_TIMEOUT_MS = 120_000;

interface PrfClientOutputs {
  readonly prf?: { readonly results?: { readonly first?: ArrayBuffer | ArrayBufferView } };
}

function randomChallenge(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

function copyBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  const view =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const out = new Uint8Array(view);
  view.fill(0); // drop the browser-held copy of the PRF output
  return out;
}

/** The browser implementation over `navigator.credentials`. */
export class BrowserPasskeyPrf implements PasskeyPrfPort {
  readonly #credentials: CredentialsContainer;
  readonly #rpId: string;

  constructor(
    options: { readonly credentials?: CredentialsContainer; readonly rpId?: string } = {},
  ) {
    this.#credentials = options.credentials ?? globalThis.navigator.credentials;
    this.#rpId = options.rpId ?? globalThis.location.hostname;
  }

  async create(displayName: string): Promise<{ readonly credentialId: Uint8Array }> {
    const credential = (await this.#credentials.create({
      publicKey: {
        rp: { id: this.#rpId, name: RP_NAME },
        // No PII: the user handle is random; the name is the app's plus the device's
        // name from a fixed list (passkeyDisplayName).
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: displayName,
          displayName,
        },
        challenge: randomChallenge(),
        timeout: CEREMONY_TIMEOUT_MS,
        pubKeyCredParams: [
          { type: "public-key", alg: -8 }, // EdDSA
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        // No authenticatorAttachment: any provider may hold the passkey (DN-1a).
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (credential === null) {
      throw new UserVerificationError();
    }
    return { credentialId: new Uint8Array(credential.rawId) };
  }

  async assert(credentialId: Uint8Array): Promise<PasskeyAssertion> {
    const credential = (await this.#credentials.get({
      publicKey: {
        challenge: randomChallenge(),
        rpId: this.#rpId,
        timeout: CEREMONY_TIMEOUT_MS,
        // Only this device's credential (C1): a passkey is never shared across devices.
        allowCredentials: [{ type: "public-key", id: new Uint8Array(credentialId) }],
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_INPUT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (credential === null) {
      throw new UserVerificationError();
    }
    const response = credential.response as AuthenticatorAssertionResponse;
    const flags = new Uint8Array(response.authenticatorData)[FLAGS_OFFSET] ?? 0;
    const first = (credential.getClientExtensionResults() as PrfClientOutputs).prf?.results?.first;
    const prf = first === undefined ? null : copyBytes(first); // clears the browser's copy
    if ((flags & UV_FLAG) === 0) {
      prf?.fill(0);
      throw new UserVerificationError();
    }
    return { prf, backupEligible: (flags & BE_FLAG) !== 0, backedUp: (flags & BS_FLAG) !== 0 };
  }
}
