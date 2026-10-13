// @vitest-environment node
//
// EU-6 — the browser WebAuthn PRF port: user verification "required" on BOTH create()
// and get(), the PRF extension requested, a missing UV flag refused, and the PRF output
// returned only when the authenticator gives one (device-enrollment-spec DN-1 Tier P).

import { describe, expect, it } from "vitest";
import { BrowserPasskeyPrf, UserVerificationError } from "./passkey-prf.js";

/** authenticatorData: rpIdHash (32) ‖ flags (1) ‖ signCount (4). */
function authData(flags: number): ArrayBuffer {
  const bytes = new Uint8Array(37);
  bytes[32] = flags;
  return bytes.buffer;
}

const UP = 0x01;
const UV = 0x04;

function fakeContainer(opts: { prf?: Uint8Array | null; flags?: number }) {
  const calls: { create: CredentialCreationOptions[]; get: CredentialRequestOptions[] } = {
    create: [],
    get: [],
  };
  const container = {
    create(options: CredentialCreationOptions) {
      calls.create.push(options);
      return Promise.resolve({
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        getClientExtensionResults: () => ({ prf: { enabled: opts.prf !== null } }),
      });
    },
    get(options: CredentialRequestOptions) {
      calls.get.push(options);
      const prf = opts.prf ?? null;
      return Promise.resolve({
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        response: { authenticatorData: authData(opts.flags ?? UP | UV) },
        getClientExtensionResults: () =>
          prf === null ? {} : { prf: { results: { first: new Uint8Array(prf).buffer } } },
      });
    },
  };
  return { calls, container: container as unknown as CredentialsContainer };
}

describe("BrowserPasskeyPrf", () => {
  it("create() requires UV and asks for the PRF extension", async () => {
    const { calls, container } = fakeContainer({ prf: new Uint8Array(32).fill(1) });
    const port = new BrowserPasskeyPrf({ credentials: container, rpId: "ta.example" });
    const { credentialId } = await port.create();
    expect([...credentialId]).toEqual([1, 2, 3, 4]);
    const pk = calls.create[0]?.publicKey;
    expect(pk?.authenticatorSelection?.userVerification).toBe("required");
    expect(pk?.extensions).toHaveProperty("prf");
    expect(pk?.rp.id).toBe("ta.example");
  });

  it("get() requires UV, evaluates PRF, and returns its output", async () => {
    const prf = new Uint8Array(32).fill(7);
    const { calls, container } = fakeContainer({ prf });
    const port = new BrowserPasskeyPrf({ credentials: container, rpId: "ta.example" });
    const result = await port.assert(new Uint8Array([1, 2, 3, 4]));
    expect([...(result.prf ?? [])]).toEqual([...prf]);
    const pk = calls.get[0]?.publicKey;
    expect(pk?.userVerification).toBe("required");
    expect(pk?.allowCredentials?.length).toBe(1);
    expect(pk?.extensions).toHaveProperty("prf");
  });

  it("returns null when the authenticator gives no PRF output", async () => {
    const { container } = fakeContainer({ prf: null });
    const port = new BrowserPasskeyPrf({ credentials: container, rpId: "ta.example" });
    expect((await port.assert(new Uint8Array([1]))).prf).toBeNull();
  });

  it("refuses an assertion without the UV flag", async () => {
    const { container } = fakeContainer({ prf: new Uint8Array(32).fill(1), flags: UP });
    const port = new BrowserPasskeyPrf({ credentials: container, rpId: "ta.example" });
    await expect(port.assert(new Uint8Array([1]))).rejects.toThrow(UserVerificationError);
  });

  it("refuses a cancelled ceremony (null credential)", async () => {
    const container = {
      create: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
    } as unknown as CredentialsContainer;
    const port = new BrowserPasskeyPrf({ credentials: container, rpId: "ta.example" });
    await expect(port.create()).rejects.toThrow(UserVerificationError);
    await expect(port.assert(new Uint8Array([1]))).rejects.toThrow(UserVerificationError);
  });
});
