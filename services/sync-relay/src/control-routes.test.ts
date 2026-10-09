// TEACH-59 (EU-3) / TEACH-60 (EU-4): the owner control routes and the pairing
// mailbox against the Postgres store (PGlite). The ferpa-guard suite drives every HARD condition on the in-memory
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
import { buildApp, startApp } from "./app.js";
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

async function pgStore(now?: () => Date) {
  const dir = mkdtempSync(join(tmpdir(), "relay-control-"));
  dirs.push(dir);
  const db = await PGlite.create(dir);
  await migrate(db);
  return { db, store: new PostgresRelayStore(db, now === undefined ? {} : { now }) };
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

// The mailbox blobs are opaque to the relay; these stand in for the AEAD blobs
// (the real-crypto handshake is in tools/ferpa-guard, ferpa-teach60).
const SID = "5e1d0000000000000000000000000001";
const REQUEST_BLOB = "cmVxdWVzdA.c2VhbGVk";
const GRANT_BLOB = "Z3JhbnQ.c2VhbGVk";
const OPEN = "/sync/enroll/pairing/open";
const REQUEST_PUT = "/sync/enroll/pairing/request-put";
const REQUEST_GET = "/sync/enroll/pairing/request-get";
const GRANT_PUT = "/sync/enroll/pairing/grant-put";
const GRANT_GET = "/sync/enroll/pairing/grant-get";

/** An owner A holding master M and period P, on a fresh Postgres store. */
async function ownerDeployment(now?: () => Date) {
  const { db, store } = await pgStore(now);
  const app = buildApp(store);
  const a = _sodium.crypto_sign_keypair();
  const aKey = b64(a.publicKey);
  await store.issueOwnerCode("seed", new Date("9999-01-01T00:00:00Z"));
  expect(await store.redeemOwnerCode("seed", aKey)).toBe("first");
  expect(
    await store.grantScopes(aKey, [
      { tag: M, kind: "master" },
      { tag: P, kind: "period" },
    ]),
  ).toBe("ok");
  return { db, store, app, a, aKey };
}

describe("TEACH-60 — the pairing mailbox on the Postgres store", () => {
  it("E1 teacher handshake: open → request-put → request-get → grant-put → grant-get", async () => {
    const { db, store, app, a } = await ownerDeployment();
    const b = _sodium.crypto_sign_keypair();
    const bKey = b64(b.publicKey);

    expect((await app.inject(signed(a, OPEN, { sid: SID }))).json()).toEqual({});
    const put = await app.inject(signed(b, REQUEST_PUT, { sid: SID, blob: REQUEST_BLOB }));
    expect(put.statusCode).toBe(200);
    // First write wins: a second request, from anyone, is the 404.
    const late = _sodium.crypto_sign_keypair();
    expect(
      (await app.inject(signed(late, REQUEST_PUT, { sid: SID, blob: REQUEST_BLOB }))).statusCode,
    ).toBe(404);

    const got = await app.inject(signed(a, REQUEST_GET, { sid: SID }));
    expect(got.json()).toEqual({ blob: REQUEST_BLOB });

    const grant = {
      sid: SID,
      device: bKey,
      role: "teacher",
      scopes: [
        { tag: M, kind: "master" },
        { tag: P, kind: "period" },
      ],
      blob: GRANT_BLOB,
    };
    // The grantee must be the recorded request signer.
    const wrong = await app.inject(signed(a, GRANT_PUT, { ...grant, device: b64(late.publicKey) }));
    expect(wrong.statusCode).toBe(409);
    expect((await app.inject(signed(a, GRANT_PUT, grant))).statusCode).toBe(200);
    expect(await store.deviceRole(bKey)).toBe("owner");
    expect(await store.isAuthorized(bKey, M)).toBe(true);

    // Only B collects the grant, and only once.
    expect((await app.inject(signed(late, GRANT_GET, { sid: SID }))).statusCode).toBe(404);
    expect((await app.inject(signed(a, GRANT_GET, { sid: SID }))).statusCode).toBe(404);
    expect((await app.inject(signed(b, GRANT_GET, { sid: SID }))).json()).toEqual({
      blob: GRANT_BLOB,
    });
    expect((await app.inject(signed(b, GRANT_GET, { sid: SID }))).statusCode).toBe(404);
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sync_relay.pairing",
    );
    expect(rows[0]?.n).toBe(0);
    await app.close();
    await db.close();
  });

  it("para: member with period kind only; para + master is 409 and changes nothing", async () => {
    const { db, store, app, a } = await ownerDeployment();
    const para = _sodium.crypto_sign_keypair();
    const paraKey = b64(para.publicKey);
    await app.inject(signed(a, OPEN, { sid: SID }));
    await app.inject(signed(para, REQUEST_PUT, { sid: SID, blob: REQUEST_BLOB }));
    const base = { sid: SID, device: paraKey, role: "para", blob: GRANT_BLOB };
    for (const scopes of [
      [{ tag: M, kind: "master" }],
      [
        { tag: P, kind: "period" },
        { tag: M, kind: "master" },
      ],
    ]) {
      const res = await app.inject(signed(a, GRANT_PUT, { ...base, scopes }));
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: string }).error).toBe("conflict");
    }
    expect(await store.deviceRole(paraKey)).toBeUndefined();
    const ok = await app.inject(
      signed(a, GRANT_PUT, { ...base, scopes: [{ tag: P, kind: "period" }] }),
    );
    expect(ok.statusCode).toBe(200);
    expect(await store.deviceRole(paraKey)).toBe("member");
    expect(await store.isAuthorized(paraKey, P)).toBe(true);
    expect(await store.isAuthorized(paraKey, M)).toBe(false);
    await app.close();
    await db.close();
  });

  it("TTL: a session past 10 minutes is the 404; the startup sweep deletes it", async () => {
    let t = Date.parse("2026-10-09T12:00:00Z");
    const { db, app, a } = await ownerDeployment(() => new Date(t));
    const b = _sodium.crypto_sign_keypair();
    expect((await app.inject(signed(a, OPEN, { sid: SID }))).statusCode).toBe(200);
    t += 10 * 60_000 + 1;
    expect(
      (await app.inject(signed(b, REQUEST_PUT, { sid: SID, blob: REQUEST_BLOB }))).statusCode,
    ).toBe(404);
    await app.close();

    // A fresh session, then a relay restart after it expired.
    const sid2 = "5e1d0000000000000000000000000002";
    const live = buildApp(new PostgresRelayStore(db, { now: () => new Date(t) }));
    expect((await live.inject(signed(a, OPEN, { sid: sid2 }))).statusCode).toBe(200);
    await live.close();
    t += 11 * 60_000;
    const count = async () =>
      (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM sync_relay.pairing")).rows[0]
        ?.n;
    expect(await count()).toBeGreaterThan(0);
    const restarted = await startApp(new PostgresRelayStore(db, { now: () => new Date(t) }));
    expect(await count()).toBe(0);
    await restarted.close();
    await db.close();
  });
});
