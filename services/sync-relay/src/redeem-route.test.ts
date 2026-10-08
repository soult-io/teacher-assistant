// TEACH-58 (EU-2): POST /sync/enroll/redeem against the Postgres store (PGlite).
// The ferpa-guard suite drives the route on the in-memory store; this runs the
// same path through PostgresRelayStore. Signing uses libsodium directly — never
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
import { formatOwnerCode, newOwnerCode, ownerCodeHash } from "./owner-code.js";
import { PostgresRelayStore } from "./postgres-store.js";
import { sodiumReady } from "./sodium-verify.js";

const ROUTE = "/sync/enroll/redeem";
const dirs: string[] = [];

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

/** A device key and a signed redeem request for `code`. */
function signedRedeem(code: string, kp = _sodium.crypto_sign_keypair()) {
  const body = new TextEncoder().encode(JSON.stringify({ code }));
  const ts = String(Date.now());
  const nonce = b64(_sodium.randombytes_buf(16));
  const sig = _sodium.crypto_sign_detached(
    canonicalRequest("POST", ROUTE, "control", ts, nonce, body),
    kp.privateKey,
  );
  return {
    device: b64(kp.publicKey),
    req: {
      method: "POST" as const,
      url: ROUTE,
      headers: {
        [SYNC_HEADERS.device]: b64(kp.publicKey),
        [SYNC_HEADERS.scope]: "control",
        [SYNC_HEADERS.timestamp]: ts,
        [SYNC_HEADERS.nonce]: nonce,
        [SYNC_HEADERS.signature]: b64(sig),
        "content-type": "application/json",
      },
      payload: Buffer.from(body),
    },
  };
}

describe("TEACH-58 — redeem on the Postgres store", () => {
  it("first, recovery, identical 401 for used / known member; logs clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-redeem-"));
    dirs.push(dir);
    const db = await PGlite.create(dir);
    await migrate(db);
    const store = new PostgresRelayStore(db);
    const lines: string[] = [];
    const app = buildApp(store, { logStream: { write: (l) => void lines.push(l) } });
    const issue = async () => {
      const code = newOwnerCode();
      await store.issueOwnerCode(ownerCodeHash(code) as string, new Date(Date.now() + 3_600_000));
      return formatOwnerCode(code);
    };

    const codeA = await issue();
    const a = signedRedeem(codeA);
    const first = await app.inject(a.req);
    expect(first.json()).toEqual({ mode: "first", recovery_wrap: null });
    expect(await store.deviceRole(a.device)).toBe("owner");

    // Used code → 401.
    const used = await app.inject(signedRedeem(codeA).req);
    expect(used.statusCode).toBe(401);

    // A member device holding a live code is not promoted (PL ruling) → the same 401.
    expect(await store.grantScopes(a.device, [{ tag: "P", kind: "period" }])).toBe("ok");
    const memberKp = _sodium.crypto_sign_keypair();
    const member = b64(memberKp.publicKey);
    expect(await store.openPairing("sid", a.device)).toBe(true);
    expect(await store.putPairingRequest("sid", member, "req")).toBe(true);
    expect(
      await store.completePairing(
        "sid",
        a.device,
        member,
        "member",
        [{ tag: "P", kind: "period" }],
        "g",
      ),
    ).toBe("ok");
    const codeB = await issue();
    const refused = await app.inject(signedRedeem(codeB, memberKp).req);
    expect(refused.statusCode).toBe(401);
    expect(Object.keys(refused.json() as object).sort()).toEqual(["error", "record_id"]);
    expect(await store.deviceRole(member)).toBe("member");

    // The live code survived and a fresh key redeems it in recovery mode.
    await store.putRecoveryWrap("WRAP");
    const fresh = await app.inject(signedRedeem(codeB).req);
    expect(fresh.json()).toEqual({ mode: "recovery", recovery_wrap: "WRAP" });

    const all = lines.join("\n");
    for (const code of [codeA, codeB]) {
      expect(all).not.toContain(code);
      expect(all).not.toContain(ownerCodeHash(code) as string);
    }
    await app.close();
    await db.close();
  });
});
