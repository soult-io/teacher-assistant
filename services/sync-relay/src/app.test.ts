// Relay unit tests. Deliberately crypto-free: this package must NEVER import
// @teacher-assistant/crypto (it never decrypts), and the FERPA-guard suite scans
// every .ts here — including tests — for that import. Signed-request behaviour
// (round-trip, H-PUB-3 zero-existence, identity-clean error bodies) is proven in
// tools/ferpa-guard and packages/sync, which may use the crypto layer to forge
// valid signatures. Here we cover what needs no key: health + the auth gate
// rejecting unsigned requests.

import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { sodiumReady } from "./sodium-verify.js";
import { InMemoryRelayStore } from "./store.js";

beforeAll(async () => {
  await sodiumReady();
});

describe("sync-relay app", () => {
  it("serves health", async () => {
    const app = buildApp(new InMemoryRelayStore());
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "sync-relay" });
  });

  it("rejects an unsigned pull with 401 and an identity-clean body", async () => {
    const app = buildApp(new InMemoryRelayStore());
    const res = await app.inject({ method: "GET", url: "/sync/some-opaque-doc?since=0" });
    expect(res.statusCode).toBe(401);
    // Body is exactly {error, record_id} — no student payload (H-PUB-4).
    expect(Object.keys(res.json()).sort()).toEqual(["error", "record_id"]);
  });

  it("rejects an unsigned push with 401", async () => {
    const app = buildApp(new InMemoryRelayStore());
    const res = await app.inject({
      method: "POST",
      url: "/sync/some-opaque-doc",
      headers: { "content-type": "application/json" },
      payload: Buffer.from(JSON.stringify({ updates: [] })),
    });
    expect(res.statusCode).toBe(401);
  });
});
