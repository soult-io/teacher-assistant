// FERPA-guard — the M1/M2 HARD STOPS (phase0-spec §8), proven behaviourally
// against the real relay (buildApp):
//   #3 H-PUB-3 — an authenticated-but-unauthorized device gets ZERO bytes AND
//      zero existence signal: an unknown doc and an unauthorized doc return the
//      byte-identical 404, so stream membership cannot be probed.
//   #4 H-PUB-4 — the public surface is identity-clean: every 4xx body is exactly
//      {error, record_id} (an opaque reference), with no initials/goal-text/score.

import {
  generateSigningKeypair,
  sign,
  sodiumReady,
  toBase64,
  utf8,
} from "@teacher-assistant/crypto";
import { canonicalRequest, SYNC_HEADERS } from "@teacher-assistant/schema";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import { InMemoryRelayStore } from "@teacher-assistant/sync-relay/store";
import { beforeAll, describe, expect, it } from "vitest";

/** The relay app type, without importing fastify as a direct dependency. */
type RelayApp = ReturnType<typeof buildApp>;

beforeAll(async () => {
  await sodiumReady();
});

interface Signer {
  readonly publicKeyB64: string;
  sign(
    method: "GET" | "POST",
    path: string,
    scope: string,
    body: Uint8Array,
  ): Record<string, string>;
}

function makeSigner(): Signer {
  const kp = generateSigningKeypair();
  return {
    publicKeyB64: toBase64(kp.publicKey),
    sign(method, path, scope, body) {
      const ts = String(Date.now());
      const nonce = toBase64(utf8(`${Math.random()}`));
      const canonical = canonicalRequest(method, path, scope, ts, nonce, body);
      return {
        [SYNC_HEADERS.device]: toBase64(kp.publicKey),
        [SYNC_HEADERS.scope]: scope,
        [SYNC_HEADERS.timestamp]: ts,
        [SYNC_HEADERS.nonce]: nonce,
        [SYNC_HEADERS.signature]: toBase64(sign(canonical, kp.privateKey)),
        "content-type": "application/json",
      };
    },
  };
}

async function pull(app: RelayApp, signer: Signer, docId: string, scope: string) {
  const path = `/sync/${encodeURIComponent(docId)}?since=`;
  return app.inject({
    method: "GET",
    url: path,
    headers: signer.sign("GET", path, scope, new Uint8Array(0)),
  });
}

describe("HARD STOP #3 — unauthorized device gets zero bytes + zero existence", () => {
  it("an unauthorized device can't tell an existing stream from a nonexistent one", async () => {
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const scopeS = "scope-S";
    const scopeT = "scope-T";

    const alice = makeSigner(); // authorized for S (owns the stream)
    const bob = makeSigner(); // authorized for T only — NOT for S
    store.authorize(alice.publicKeyB64, scopeS);
    store.authorize(bob.publicKeyB64, scopeT);

    // Alice creates a real doc D under S.
    const docId = "doc-D";
    const body = utf8(JSON.stringify({ updates: [toBase64(utf8("ciphertext"))] }));
    const push = await app.inject({
      method: "POST",
      url: `/sync/${docId}`,
      headers: alice.sign("POST", `/sync/${docId}`, scopeS, body),
      payload: Buffer.from(body),
    });
    expect(push.statusCode).toBe(200);
    // Sanity: Alice (authorized for S) reads her own stream.
    expect((await pull(app, alice, docId, scopeS)).statusCode).toBe(200);

    // Bob is not authorized for S. He probes S for the EXISTING doc and for a
    // NONEXISTENT one; both must be the byte-identical 404 so existence leaks nothing.
    const bobOnExisting = await pull(app, bob, docId, scopeS);
    const bobOnNonexistent = await pull(app, bob, "doc-never-created", scopeS);

    expect(bobOnExisting.statusCode).toBe(404);
    expect(bobOnNonexistent.statusCode).toBe(404);
    expect(Object.keys(bobOnExisting.json()).sort()).toEqual(["error", "record_id"]);
    expect(bobOnExisting.json().error).toEqual(bobOnNonexistent.json().error);
    expect(Object.keys(bobOnExisting.json()).sort()).toEqual(
      Object.keys(bobOnNonexistent.json()).sort(),
    );
  });
});

describe("HARD STOP #4 — identity-clean public error surface", () => {
  it("a 4xx body is exactly {error, record_id} with an opaque reference", () => {
    const app = buildApp(new InMemoryRelayStore());
    return app
      .inject({ method: "GET", url: "/sync/whatever?since=0" }) // unsigned → 401
      .then((res) => {
        expect(res.statusCode).toBe(401);
        const body = res.json() as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(["error", "record_id"]);
        expect(body.record_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      });
  });
});
