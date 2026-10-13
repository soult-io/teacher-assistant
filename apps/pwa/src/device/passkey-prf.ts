// The WebAuthn port for the device vault (device-enrollment-spec rev 2.4 DN-1).
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

/** One user-verified assertion: the PRF output, or null when the authenticator gave none. */
export interface PasskeyAssertion {
  readonly prf: Uint8Array | null;
}

/** Port: create the device passkey, and run a UV-required assertion against it. */
export interface PasskeyPrfPort {
  create(): Promise<{ readonly credentialId: Uint8Array }>;
  assert(credentialId: Uint8Array): Promise<PasskeyAssertion>;
}

// The PRF evaluation input. Constant: the PRF secret is per credential, so a fixed
// input yields a per-device output.
const PRF_INPUT = new TextEncoder().encode("ta-vault-prf-v1");
const UV_FLAG = 0x04;
const FLAGS_OFFSET = 32; // authenticatorData = rpIdHash (32) ‖ flags (1) ‖ …
const RP_NAME = "Teacher Assistant";

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

  async create(): Promise<{ readonly credentialId: Uint8Array }> {
    const credential = (await this.#credentials.create({
      publicKey: {
        rp: { id: this.#rpId, name: RP_NAME },
        // No PII: the user handle is random and the names are the app's own.
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: RP_NAME,
          displayName: RP_NAME,
        },
        challenge: randomChallenge(),
        pubKeyCredParams: [
          { type: "public-key", alg: -8 }, // EdDSA
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
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
    if ((flags & UV_FLAG) === 0) {
      throw new UserVerificationError();
    }
    const first = (credential.getClientExtensionResults() as PrfClientOutputs).prf?.results?.first;
    return { prf: first === undefined ? null : copyBytes(first) };
  }
}
