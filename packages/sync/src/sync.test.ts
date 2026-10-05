// M1 sync client + the Phase-0 EXIT TEST (phase0-spec §0/§4): an offline-captured
// point on device A reconciles to device B with no overwrite/duplicate and ZERO
// PII on the server (the relay only ever sees opaque ciphertext). Drives the real
// M2 relay (buildApp) over a Fastify-inject transport.

import {
  generatePeriodKey,
  generateSigningKeypair,
  ParaKeyring,
  type PeriodKey,
  sodiumReady,
  toBase64,
} from "@teacher-assistant/crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { newOpaqueId, newScopeTag } from "@teacher-assistant/schema";
import { buildApp } from "@teacher-assistant/sync-relay/app";
import { migrate, SCHEMA } from "@teacher-assistant/sync-relay/migrations";
import { PostgresRelayStore } from "@teacher-assistant/sync-relay/postgres-store";
import { InMemoryRelayStore, type RelayStore } from "@teacher-assistant/sync-relay/store";
import { seedAcl } from "@teacher-assistant/sync-relay/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { EncryptedStream } from "./doc.js";
import { SyncEngine } from "./engine.js";
import { InMemoryPersistence } from "./persistence.js";
import {
  RelayClient,
  type RelayHttpRequest,
  type RelayHttpResponse,
  type Transport,
} from "./relay-client.js";

/** The relay app type, without importing fastify as a direct dependency. */
type RelayApp = ReturnType<typeof buildApp>;

const MARKER = "SYNTH_MARKER_7_of_10"; // a distinctive synthetic plaintext value

beforeAll(async () => {
  await sodiumReady();
});

/** A transport that drives the real relay via Fastify inject, recording sent bodies. */
function injectTransport(app: RelayApp, sent: Uint8Array[]): Transport {
  return async (req: RelayHttpRequest): Promise<RelayHttpResponse> => {
    sent.push(req.body);
    const res = await app.inject({
      method: req.method,
      url: req.path,
      headers: req.headers,
      payload: Buffer.from(req.body),
    });
    return { status: res.statusCode, body: new Uint8Array(res.rawPayload) };
  };
}

interface Device {
  readonly engine: SyncEngine;
  readonly stream: EncryptedStream;
}

async function makeDevice(
  app: RelayApp,
  store: RelayStore,
  docId: ReturnType<typeof newOpaqueId>,
  period: PeriodKey,
  sent: Uint8Array[],
): Promise<Device> {
  const signing = generateSigningKeypair();
  await seedAcl(store, toBase64(signing.publicKey), period.scopeTag);
  const stream = new EncryptedStream(docId, period.scopeTag, new ParaKeyring([period]));
  const relay = new RelayClient({ transport: injectTransport(app, sent), signingKeypair: signing });
  return { engine: new SyncEngine(stream, relay, new InMemoryPersistence()), stream };
}

describe("Phase-0 EXIT TEST — offline A reconciles to B, zero PII on server", () => {
  it("an offline-captured point on A reconciles to B with no overwrite/dup", async () => {
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const period = generatePeriodKey(newScopeTag());
    const docId = newOpaqueId();
    const sent: Uint8Array[] = [];

    const a = await makeDevice(app, store, docId, period, sent);
    const b = await makeDevice(app, store, docId, period, sent);

    // A captures a point OFFLINE (no sync yet) — queued + persisted as ciphertext.
    await a.engine.capture((doc) => {
      doc.getMap("points").set("p1", { numerator: 7, denominator: 10, note: MARKER });
    });
    expect(a.engine.pendingCount).toBe(1);

    // A reconnects and syncs; then B syncs and converges.
    await a.engine.sync();
    expect(a.engine.pendingCount).toBe(0);
    await b.engine.sync();

    const onB = b.stream.doc.getMap("points").get("p1");
    expect(onB).toEqual({ numerator: 7, denominator: 10, note: MARKER });

    // Zero PII on the server: no plaintext marker in any byte the relay received.
    const marker = new TextEncoder().encode(MARKER);
    for (const body of sent) {
      expect(containsBytes(body, marker)).toBe(false);
    }
  });

  it("two devices editing offline converge with no overwrite/duplicate; re-sync is idempotent", async () => {
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const period = generatePeriodKey(newScopeTag());
    const docId = newOpaqueId();
    const sent: Uint8Array[] = [];
    const a = await makeDevice(app, store, docId, period, sent);
    const b = await makeDevice(app, store, docId, period, sent);

    await a.engine.capture((doc) => doc.getMap("points").set("a1", 1));
    await b.engine.capture((doc) => doc.getMap("points").set("b1", 2));

    // Both sync (A first, then B pulls A + pushes B, then A pulls B).
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    for (const d of [a, b]) {
      const points = d.stream.doc.getMap("points");
      expect(points.get("a1")).toBe(1);
      expect(points.get("b1")).toBe(2);
      expect([...points.keys()].sort()).toEqual(["a1", "b1"]);
    }

    // Re-syncing changes nothing (idempotent, no dup).
    await a.engine.sync();
    expect([...a.stream.doc.getMap("points").keys()].sort()).toEqual(["a1", "b1"]);
  });
});

describe("unauthorized gets zero bytes + zero existence signal (H-PUB-3)", () => {
  it("the relay answers an unauthorized pull with a byte-identical, identity-clean 404 that the client degrades to an empty pull", async () => {
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const period = generatePeriodKey(newScopeTag());
    const docId = newOpaqueId();
    const sent: Uint8Array[] = [];

    // Authorized device A creates the stream.
    const a = await makeDevice(app, store, docId, period, sent);
    await a.engine.capture((doc) => doc.getMap("points").set("p1", { note: MARKER }));
    await a.engine.sync();

    // An UN-authorized device (signing key never granted the scope) pulls the same doc.
    // Record the raw relay response so BOTH invariants are asserted: the server-side
    // zero-existence 404 AND the client's offline-first degradation of it.
    let lastResponse: RelayHttpResponse | null = null;
    const inject = injectTransport(app, sent);
    const recording: Transport = async (req) => {
      const res = await inject(req);
      lastResponse = res;
      return res;
    };
    const outsider = new RelayClient({
      transport: recording,
      signingKeypair: generateSigningKeypair(),
    });

    // Client side (offline-first): a 404 is the relay's deliberately-ambiguous "no state
    // for you" — the client must NOT throw, it degrades to an empty pull (zero bytes).
    const result = await outsider.pull(docId, period.scopeTag, null);
    expect(result).toEqual({ cursor: "", updates: [] });

    // Server side (the H-PUB-3 invariant): the relay actually answered 404 — the
    // byte-identical response an unknown doc gets, so stream membership cannot be probed…
    const raw = lastResponse as RelayHttpResponse | null;
    expect(raw?.status).toBe(404);
    // …with an identity-clean body: exactly {error, record_id}, no student payload.
    const body = JSON.parse(new TextDecoder().decode(raw?.body ?? new Uint8Array())) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(["error", "record_id"]);
    expect(JSON.stringify(body)).not.toContain(MARKER);
  });

  it("an unauthorized pull for an EXISTING vs an UNKNOWN doc is the byte-identical 404 (membership cannot be probed)", async () => {
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const period = generatePeriodKey(newScopeTag());
    const existingDocId = newOpaqueId();
    const sent: Uint8Array[] = [];

    // Authorized device A writes an EXISTING doc.
    const a = await makeDevice(app, store, existingDocId, period, sent);
    await a.engine.capture((doc) => doc.getMap("points").set("p1", { note: MARKER }));
    await a.engine.sync();

    let raw: RelayHttpResponse | null = null;
    const inject = injectTransport(app, sent);
    const outsider = new RelayClient({
      transport: async (req) => {
        const res = await inject(req);
        raw = res;
        return res;
      },
      signingKeypair: generateSigningKeypair(), // never granted the scope
    });

    const shapeOf = async (docId: string): Promise<{ status: number; keys: string[] }> => {
      const result = await outsider.pull(docId, period.scopeTag, null);
      expect(result).toEqual({ cursor: "", updates: [] }); // client degrades both to empty
      const r = raw as RelayHttpResponse | null;
      const body = JSON.parse(new TextDecoder().decode(r?.body ?? new Uint8Array())) as Record<
        string,
        unknown
      >;
      return { status: r?.status ?? 0, keys: Object.keys(body).sort() };
    };

    // The doc that EXISTS and one that never existed are structurally indistinguishable —
    // both 404 with the same body shape — so the outsider cannot tell which docs exist.
    const existing = await shapeOf(existingDocId);
    const unknown = await shapeOf(newOpaqueId());
    expect(existing).toEqual({ status: 404, keys: ["error", "record_id"] });
    expect(unknown).toEqual(existing);
  });
});

describe("authorized never-synced doc pulls 200-empty (the invariant the 404-handling relies on)", () => {
  it("an AUTHORIZED device's unwritten doc returns 200 with no updates — NOT a 404", async () => {
    // The client treats a 404 as an empty pull, which is only safe because the relay
    // never 404s an authorized device's own never-synced doc (it serves 200-empty). Pin
    // that: if a future relay change ever 404s an authorized doc, the client would
    // silently treat real remote state as empty — this test catches that regression.
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const period = generatePeriodKey(newScopeTag());

    const signing = generateSigningKeypair();
    await seedAcl(store, toBase64(signing.publicKey), period.scopeTag);

    let raw: RelayHttpResponse | null = null;
    const inject = injectTransport(app, []);
    const client = new RelayClient({
      transport: async (req) => {
        const res = await inject(req);
        raw = res;
        return res;
      },
      signingKeypair: signing,
    });

    const result = await client.pull(newOpaqueId(), period.scopeTag, null);
    expect(result.updates).toEqual([]); // no server-side state yet
    expect((raw as RelayHttpResponse | null)?.status).toBe(200); // 200-empty, not 404
  });
});

describe("no silent loss under concurrency", () => {
  it("a capture during an in-flight sync (push await) is not dropped", async () => {
    const store = new InMemoryRelayStore();
    const app = buildApp(store);
    const period = generatePeriodKey(newScopeTag());
    const docId = newOpaqueId();

    const signing = generateSigningKeypair();
    await seedAcl(store, toBase64(signing.publicKey), period.scopeTag);
    const base = injectTransport(app, []);
    // A transport that signals when a push begins and blocks until released —
    // this opens exactly the window the reviewer flagged (capture during push).
    let pushStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      pushStarted = r;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const transport: Transport = async (req) => {
      if (req.method === "POST") {
        pushStarted();
        await gate;
      }
      return base(req);
    };
    const stream = new EncryptedStream(docId, period.scopeTag, new ParaKeyring([period]));
    const engine = new SyncEngine(
      stream,
      new RelayClient({ transport, signingKeypair: signing }),
      new InMemoryPersistence(),
    );

    await engine.capture((doc) => doc.getMap("points").set("p1", 1));
    const syncing = engine.sync(); // pull completes, push blocks on the gate
    await started;
    await engine.capture((doc) => doc.getMap("points").set("p2", 2)); // lands during the push await
    release();
    await syncing;

    // p2 must survive (it was not in the pushed batch) and remain queued.
    expect(engine.pendingCount).toBe(1);

    // A second sync flushes p2; a fresh device B then sees BOTH points.
    await engine.sync();
    const b = await makeDevice(app, store, docId, period, []);
    await b.engine.sync();
    expect(b.stream.doc.getMap("points").get("p1")).toBe(1);
    expect(b.stream.doc.getMap("points").get("p2")).toBe(2);
  });
});

describe("TEACH-49 — durable relay: sync survives a relay restart, the database holds no plaintext", () => {
  it("A syncs, the relay restarts on the same Postgres, B still converges; no marker in any row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-durable-"));
    try {
      const period = generatePeriodKey(newScopeTag());
      const docId = newOpaqueId();

      // Relay process #1 over a Postgres database on disk.
      const db1 = await PGlite.create(dir);
      await migrate(db1);
      const store1 = new PostgresRelayStore(db1);
      const app1 = buildApp(store1);
      const a = await makeDevice(app1, store1, docId, period, []);
      await a.engine.capture((doc) => {
        doc.getMap("points").set("p1", { numerator: 7, denominator: 10, note: MARKER });
      });
      await a.engine.sync();
      expect(a.engine.pendingCount).toBe(0);
      await app1.close();
      await db1.close();

      // Relay process #2: a fresh connection to the SAME database.
      const db2 = await PGlite.create(dir);
      try {
        await migrate(db2);
        const store2 = new PostgresRelayStore(db2);
        const app2 = buildApp(store2);
        const b = await makeDevice(app2, store2, docId, period, []);
        await b.engine.sync();
        expect(b.stream.doc.getMap("points").get("p1")).toEqual({
          numerator: 7,
          denominator: 10,
          note: MARKER,
        });
        await app2.close();

        // Nothing in the database reads as the plaintext: not any column as text,
        // and not any ciphertext blob once base64-decoded.
        const marker = new TextEncoder().encode(MARKER);
        let blobs = 0;
        for (const table of ["acl", "docs", "updates"]) {
          const { rows } = await db2.query<Record<string, unknown>>(
            `SELECT * FROM ${SCHEMA}.${table}`,
          );
          for (const row of rows) {
            for (const value of Object.values(row)) {
              expect(String(value)).not.toContain(MARKER);
            }
            if (table === "updates") {
              blobs += 1;
              const bytes = new Uint8Array(Buffer.from(String(row["blob"]), "base64"));
              expect(containsBytes(bytes, marker)).toBe(false);
            }
          }
        }
        expect(blobs).toBeGreaterThan(0); // the scan saw real ciphertext
      } finally {
        await db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000); // two PGlite starts (initdb + migrate), slow on a shared CI runner
});

describe("TEACH-49 — a relay restored from an older backup does not make a client skip updates", () => {
  it("B's cursor is from before the restore; B still receives every post-restore update", async () => {
    const period = generatePeriodKey(newScopeTag());
    const docId = newOpaqueId();
    const before = new InMemoryRelayStore();
    const restored = new InMemoryRelayStore(); // the backup predates this doc
    let app = buildApp(before);

    // Each device's transport follows `app`, so a relay swap is a "restore".
    const device = async () => {
      const signing = generateSigningKeypair();
      for (const s of [before, restored]) {
        await seedAcl(s, toBase64(signing.publicKey), period.scopeTag);
      }
      const transport: Transport = (req) => injectTransport(app, [])(req);
      const stream = new EncryptedStream(docId, period.scopeTag, new ParaKeyring([period]));
      const relay = new RelayClient({ transport, signingKeypair: signing });
      return { engine: new SyncEngine(stream, relay, new InMemoryPersistence()), stream };
    };
    const a = await device();
    const b = await device();

    // Before the restore: several updates, B syncs and holds a cursor > 0.
    for (let i = 0; i < 3; i++) {
      await a.engine.capture((doc) => doc.getMap("points").set(`old${i}`, i));
    }
    await a.engine.sync();
    await b.engine.sync();

    // Restore: the relay's data goes back to before this doc existed. Sequence
    // numbers restart, so A's new updates reuse seq 1..4 — at and past B's seq 3.
    app = buildApp(restored);
    for (let i = 0; i < 4; i++) {
      await a.engine.capture((doc) => doc.getMap("points").set(`new${i}`, i));
    }
    await a.engine.sync();
    await b.engine.sync(); // B's cursor is from the old epoch: served from 0

    for (let i = 0; i < 4; i++) {
      expect(b.stream.doc.getMap("points").get(`new${i}`)).toBe(i);
    }
  });
});

/** True if `needle`'s bytes appear contiguously in `haystack`. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}
