// TEACH-59 (EU-3): the owner control routes against the Postgres store
// (PGlite). The ferpa-guard suite drives every HARD condition on the in-memory
// store; this runs the same paths through PostgresRelayStore, including the
// replayed grant on a restarted relay. Signing uses libsodium directly — never
// @teacher-assistant/crypto, which the relay must not import.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { canonicalRequest, SYNC_HEADERS } from "@teacher-assistant/schema";
import _sodium from "libsodium-wrappers-sumo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { migrate } from "./migrations.js";
import { PostgresRelayStore } from "./postgres-store.js";
import { sodiumReady } from "./sodium-verify.js";

const dirs: string[] = [];
// Scope tags are random UUIDs (newScopeTag).
const M = "00000000-0000-4000-8000-00000000000a";
const P = "00000000-0000-4000-8000-00000000000b";
const Q = "00000000-0000-4000-8000-00000000000c";

beforeAll(async () => {
  await sodiumReady();
});
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

function b64(bytes: Uint8Array): string {
  return _sodium.to_base64(bytes, _sodium.base64_variants.URLSAFE_NO_PADDING);
}

interface Keypair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** A signed POST of `body` to `url` under `scope` (default `control`). */
function signed(kp: Keypair, url: string, body: unknown, scope = "control") {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const ts = String(Date.now());
  const nonce = b64(_sodium.randombytes_buf(16));
  const sig = _sodium.crypto_sign_detached(
    canonicalRequest("POST", url, scope, ts, nonce, raw),
    kp.privateKey,
  );
  return {
    method: "POST" as const,
    url,
    headers: {
      [SYNC_HEADERS.device]: b64(kp.publicKey),
      [SYNC_HEADERS.scope]: scope,
      [SYNC_HEADERS.timestamp]: ts,
      [SYNC_HEADERS.nonce]: nonce,
      [SYNC_HEADERS.signature]: b64(sig),
      "content-type": "application/json",
    },
    payload: Buffer.from(raw),
  };
}

async function pgStore() {
  const dir = mkdtempSync(join(tmpdir(), "relay-control-"));
  dirs.push(dir);
  const db = await PGlite.create(dir);
  await migrate(db);
  return { db, store: new PostgresRelayStore(db) };
}

describe("TEACH-59 — owner control routes on the Postgres store", () => {
  it("list, grant, retire-scope, recovery-wrap, revoke; non-owner 404; replay after revoke refused", async () => {
    const { db, store } = await pgStore();
    const app = buildApp(store);
    const owner = _sodium.crypto_sign_keypair();
    const para = _sodium.crypto_sign_keypair();
    const ownerKey = b64(owner.publicKey);
    const paraKey = b64(para.publicKey);
    await store.issueOwnerCode("seed", new Date("9999-01-01T00:00:00Z"));
    expect(await store.redeemOwnerCode("seed", ownerKey)).toBe("first");

    // Self-grant master + a period, then enroll the para through pairing.
    const self = await app.inject(
      signed(owner, "/sync/devices/grant", {
        device: ownerKey,
        scopes: [
          { tag: M, kind: "master" },
          { tag: P, kind: "period" },
        ],
      }),
    );
    expect(self.statusCode).toBe(200);
    expect(await store.openPairing("sid", ownerKey)).toBe(true);
    expect(await store.putPairingRequest("sid", paraKey, "req")).toBe(true);
    expect(
      await store.completePairing(
        "sid",
        ownerKey,
        paraKey,
        "member",
        [{ tag: P, kind: "period" }],
        "g",
      ),
    ).toBe("ok");

    // A member is not an owner: the identical 404.
    const notOwner = await app.inject(signed(para, "/sync/devices/list", {}));
    expect(notOwner.statusCode).toBe(404);
    expect((notOwner.json() as { error: string }).error).toBe("not_found");

    const list = await app.inject(signed(owner, "/sync/devices/list", {}));
    expect(list.json()).toEqual({
      devices: [
        {
          device: ownerKey,
          role: "owner",
          status: "active",
          scopes: [
            { tag: M, kind: "master", retired: false },
            { tag: P, kind: "period", retired: false },
          ],
        },
        {
          device: paraKey,
          role: "member",
          status: "active",
          scopes: [{ tag: P, kind: "period", retired: false }],
        },
      ].sort((a, b) => (a.device < b.device ? -1 : 1)),
    });

    // A second period for the para; captured for the replay below.
    const grantQ = signed(owner, "/sync/devices/grant", {
      device: paraKey,
      scopes: [{ tag: Q, kind: "period" }],
    });
    expect((await app.inject(grantQ)).statusCode).toBe(200);
    expect(await store.isAuthorized(paraKey, Q)).toBe(true);

    expect(
      (await app.inject(signed(owner, "/sync/devices/retire-scope", { tag: M }))).statusCode,
    ).toBe(409);
    expect(
      (await app.inject(signed(owner, "/sync/devices/retire-scope", { tag: P }))).statusCode,
    ).toBe(200);
    expect(
      (await app.inject(signed(owner, "/sync/devices/recovery-wrap", { blob: "c2FsdA.YmxvYg" })))
        .statusCode,
    ).toBe(200);
    expect(await store.getRecoveryWrap()).toBe("c2FsdA.YmxvYg");

    expect(
      (await app.inject(signed(owner, "/sync/devices/revoke", { device: ownerKey }))).statusCode,
    ).toBe(409);
    expect(
      (await app.inject(signed(owner, "/sync/devices/revoke", { device: paraKey }))).statusCode,
    ).toBe(200);
    expect(await store.isAuthorized(paraKey, Q)).toBe(false);

    // The grant replayed on a restarted relay (empty nonce cache) is refused.
    const restarted = buildApp(store);
    expect((await restarted.inject(grantQ)).statusCode).toBe(409);
    expect(await store.isAuthorized(paraKey, Q)).toBe(false);
    expect(await store.deviceRole(paraKey)).toBeUndefined();

    await app.close();
    await restarted.close();
    await db.close();
  });
});
