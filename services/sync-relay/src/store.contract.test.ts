// The RelayStore contract, run against every implementation:
//   - memory    InMemoryRelayStore
//   - pglite    PostgresRelayStore on PGlite (real Postgres, in-process) — always runs
//   - postgres  PostgresRelayStore on a real server via pg.Pool — runs when
//               TEST_DATABASE_URL is set; REQUIRED in CI (the job provides one)
// Plus the Postgres-only guarantees: data survives a restart, the schema holds
// only the opaque columns, the database stores nothing but what it was given,
// updates are append-only at the database level, migrations are idempotent,
// and migration v2 refuses a non-empty acl (no backfill).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, migrate, ROTATE_EPOCHS_SQL, SCHEMA } from "./migrations.js";
import { PostgresRelayStore } from "./postgres-store.js";
import { poolClient, type SqlClient } from "./sql.js";
import {
  type DeviceRole,
  InMemoryRelayStore,
  PAIRING_TTL_MS,
  parseCursor,
  type RelayStore,
  type ScopeGrant,
  type StoreOptions,
} from "./store.js";
import { seedAcl } from "./testing.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** A database the Postgres store can be (re)opened on, to simulate a restart. */
interface Backend {
  readonly name: string;
  /** Open a fresh connection to the SAME database (a relay process start). */
  open(): Promise<SqlClient & { close(): Promise<void> }>;
  /** Start from an empty database (between tests). */
  reset(): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) {
    await fn();
  }
});

function pgliteBackend(): Backend {
  const dir = mkdtempSync(join(tmpdir(), "relay-pglite-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  let current: PGlite | undefined;
  const closeCurrent = async () => {
    if (current !== undefined && !current.closed) {
      await current.close();
    }
    current = undefined;
  };
  return {
    name: "pglite",
    async open() {
      // PGlite holds an exclusive lock on its data dir; a "restart" closes first.
      await closeCurrent();
      const db = await PGlite.create(join(dir, `db-${n}`));
      current = db;
      return db;
    },
    async reset() {
      await closeCurrent();
      n += 1; // a new, empty data dir
    },
  };
}

function serverBackend(url: string): Backend {
  return {
    name: "postgres",
    async open() {
      const pool = new pg.Pool({ connectionString: url, max: 4 });
      return Object.assign(poolClient(pool), { close: () => pool.end() });
    },
    async reset() {
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pool.end();
    },
  };
}

const pgBackends: Backend[] = [pgliteBackend()];
if (TEST_DATABASE_URL) {
  pgBackends.push(serverBackend(TEST_DATABASE_URL));
}

it("CI runs the contract against a real Postgres server", () => {
  if (process.env.CI) {
    expect(TEST_DATABASE_URL, "CI must set TEST_DATABASE_URL").toBeTruthy();
  }
});

async function openPostgresStore(backend: Backend, options?: StoreOptions) {
  const sql = await backend.open();
  cleanups.push(() => sql.close().catch(() => {}));
  await migrate(sql);
  return { store: new PostgresRelayStore(sql, options), sql };
}

interface Impl {
  readonly name: string;
  /** A fresh store, plus what a backup restore does to it (re-mint every epoch). */
  make(options?: StoreOptions): Promise<{ s: RelayStore; restoreEpochs(): Promise<void> }>;
}

const impls: Impl[] = [
  {
    name: "memory",
    async make(options) {
      const s = new InMemoryRelayStore(options);
      return { s, restoreEpochs: async () => s.rotateEpochs() };
    },
  },
  ...pgBackends.map((b) => ({
    name: b.name,
    async make(options?: StoreOptions) {
      await b.reset();
      const { store, sql } = await openPostgresStore(b, options);
      return { s: store, restoreEpochs: () => rotateEpochsSql(sql) };
    },
  })),
];

/** A test clock that only moves when told to. */
function testClock(start = Date.parse("2026-10-05T12:00:00Z")) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const HOUR = 60 * 60 * 1000;

/** The restore-runbook statement (migrations.ts). */
async function rotateEpochsSql(sql: SqlClient): Promise<void> {
  await sql.query(ROTATE_EPOCHS_SQL);
}

const START = parseCursor(undefined);
const at = (cursor: string | undefined) => parseCursor(cursor);
/** The sequence part of a cursor (`<epoch>.<seq>`, or "0" for an unknown doc). */
const seqOf = (cursor: string | undefined) => Number(cursor?.slice(cursor.lastIndexOf(".") + 1));

// URL-safe and standard base64, with and without padding — round-trip verbatim.
const BLOBS = ["AAEC", "_-8", "q83v7w==", "SGVsbG8/Kw=", ""];

describe("parseCursor", () => {
  it("parses <epoch>.<seq>; anything else is from the start", () => {
    expect(parseCursor("e-1.7")).toEqual({ epoch: "e-1", seq: 7 });
    expect(parseCursor("9f1c-AB.3")).toEqual({ epoch: "9f1c-AB", seq: 3 });
    for (const raw of [
      undefined,
      "",
      "0",
      "7",
      ".3",
      "e.",
      "e.-1",
      "e.1.5x",
      "e.x",
      "e.1e3",
      "e. 1",
      "e.0x1",
      "a.b.3",
      "e\u0000x.1",
      "e x.1",
    ]) {
      expect(parseCursor(raw), String(raw)).toEqual(START);
    }
    expect(parseCursor(`${"e".repeat(200)}.1`)).toEqual(START);
  });
});

describe.each(impls)("RelayStore contract — $name", (impl) => {
  it("ACL: unknown is false; seedAcl grants exactly (device, scope); idempotent", async () => {
    const { s } = await impl.make();
    expect(await s.isAuthorized("dev-A", "scope-1")).toBe(false);
    await seedAcl(s, "dev-A", "scope-1");
    await seedAcl(s, "dev-A", "scope-1");
    expect(await s.isAuthorized("dev-A", "scope-1")).toBe(true);
    expect(await s.isAuthorized("dev-A", "scope-2")).toBe(false);
    expect(await s.isAuthorized("dev-B", "scope-1")).toBe(false);
  });

  it("an unknown doc has no scope; fetch returns cursor 0 for any `since`", async () => {
    const { s } = await impl.make();
    expect(await s.docScope("doc-x")).toBeUndefined();
    expect(await s.fetch("doc-x", START)).toEqual({ cursor: "0", updates: [] });
    expect(await s.fetch("doc-x", at("old-epoch.7"))).toEqual({ cursor: "0", updates: [] });
  });

  it("the first append binds the doc to its scope — even an empty batch", async () => {
    const { s } = await impl.make();
    const c0 = await s.append("doc-1", "scope-1", []);
    expect(seqOf(c0)).toBe(0);
    expect(await s.docScope("doc-1")).toBe("scope-1");
    expect(await s.fetch("doc-1", START)).toEqual({ cursor: c0, updates: [] });
  });

  it("append returns the head cursor; fetch returns updates after `since`, in order", async () => {
    const { s } = await impl.make();
    const c2 = await s.append("doc-1", "scope-1", ["b1", "b2"]);
    const c3 = await s.append("doc-1", "scope-1", ["b3"]);
    expect([seqOf(c2), seqOf(c3)]).toEqual([2, 3]);
    expect(at(c2).epoch).toBe(at(c3).epoch); // one doc, one epoch
    expect(await s.fetch("doc-1", START)).toEqual({ cursor: c3, updates: ["b1", "b2", "b3"] });
    expect(await s.fetch("doc-1", at(c2))).toEqual({ cursor: c3, updates: ["b3"] });
    expect(await s.fetch("doc-1", at(c3))).toEqual({ cursor: c3, updates: [] });
  });

  it("a cursor from another epoch, a legacy cursor, or one past the head → every update", async () => {
    const { s } = await impl.make();
    const c3 = await s.append("doc-1", "scope-1", ["b1", "b2", "b3"]);
    const epoch = at(c3).epoch;
    const all = { cursor: c3, updates: ["b1", "b2", "b3"] };
    expect(await s.fetch("doc-1", at("other-epoch.2"))).toEqual(all);
    expect(await s.fetch("doc-1", at("2"))).toEqual(all); // pre-epoch (numeric) cursor
    expect(await s.fetch("doc-1", at(`${epoch}.50`))).toEqual(all);
  });

  it("after a restore, a stale cursor at or below the new head still gets every update", async () => {
    // The reviewer's case: sequence numbers are reused after a restore, so a
    // client holding seq 3 from the old history must not take seq 1..3 of the
    // new one as already seen.
    const { s, restoreEpochs } = await impl.make();
    const stale = await s.append("doc-1", "scope-1", ["old1", "old2", "old3"]);
    await restoreEpochs();
    const fresh = await s.fetch("doc-1", at(stale));
    expect(fresh.updates).toEqual(["old1", "old2", "old3"]);
    expect(at(fresh.cursor).epoch).not.toBe(at(stale).epoch);
    expect(await s.fetch("doc-1", at(fresh.cursor))).toEqual({
      cursor: fresh.cursor,
      updates: [],
    });
  });

  it("ciphertext blobs round-trip byte-for-byte", async () => {
    const { s } = await impl.make();
    await s.append("doc-1", "scope-1", BLOBS);
    expect((await s.fetch("doc-1", START)).updates).toEqual(BLOBS);
  });

  it("docs are independent streams with independent epochs", async () => {
    const { s } = await impl.make();
    const a = await s.append("doc-1", "scope-1", ["a"]);
    const b = await s.append("doc-2", "scope-1", ["x", "y"]);
    expect(await s.fetch("doc-1", START)).toEqual({ cursor: a, updates: ["a"] });
    expect(await s.fetch("doc-2", START)).toEqual({ cursor: b, updates: ["x", "y"] });
    expect(at(a).epoch).not.toBe(at(b).epoch);
  });

  it("append to a doc bound to ANOTHER scope writes nothing and returns undefined", async () => {
    const { s } = await impl.make();
    const c1 = await s.append("doc-1", "scope-1", ["a"]);
    expect(await s.append("doc-1", "scope-2", ["evil"])).toBeUndefined();
    expect(await s.docScope("doc-1")).toBe("scope-1");
    expect(await s.fetch("doc-1", START)).toEqual({ cursor: c1, updates: ["a"] });
  });

  it("concurrent appends to one doc get distinct, gap-free sequence numbers", async () => {
    const { s } = await impl.make();
    const n = 20;
    const cursors = await Promise.all(
      Array.from({ length: n }, (_, i) => s.append("doc-1", "scope-1", [`b${i}`])),
    );
    expect(cursors.map(seqOf).sort((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, i) => i + 1),
    );
    const { cursor, updates } = await s.fetch("doc-1", START);
    expect(seqOf(cursor)).toBe(n);
    expect([...updates].sort()).toEqual(Array.from({ length: n }, (_, i) => `b${i}`).sort());
    // Each append's cursor points at its own blob.
    for (let i = 0; i < n; i++) {
      expect(updates[seqOf(cursors[i]) - 1]).toBe(`b${i}`);
    }
  });

  it("concurrent first writers under different scopes: exactly one binds the doc", async () => {
    const { s } = await impl.make();
    const results = await Promise.all([
      s.append("doc-1", "scope-1", ["one"]),
      s.append("doc-1", "scope-2", ["two"]),
    ]);
    expect(results.filter((r) => r !== undefined).map(seqOf)).toEqual([1]);
    const bound = await s.docScope("doc-1");
    const { updates } = await s.fetch("doc-1", START);
    expect(updates).toEqual([bound === "scope-1" ? "one" : "two"]);
  });
});

/** Every value in every table of the relay schema, as text (dates as ISO strings). */
async function allStoredValues(sql: SqlClient): Promise<Set<string>> {
  const { rows: tables } = await sql.query<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1`,
    [SCHEMA],
  );
  const seen = new Set<string>();
  for (const { t } of tables) {
    const { rows } = await sql.query<Record<string, unknown>>(`SELECT * FROM ${SCHEMA}.${t}`);
    for (const v of rows.flatMap((row) => Object.values(row))) {
      seen.add(v instanceof Date ? v.toISOString() : String(v));
    }
  }
  return seen;
}

describe.each(pgBackends)("PostgresRelayStore durability + privacy — $name", (backend) => {
  it("data survives a relay restart (new connection, same database)", async () => {
    await backend.reset();
    const first = await openPostgresStore(backend);
    await seedAcl(first.store, "dev-A", "scope-1");
    const c2 = await first.store.append("doc-1", "scope-1", ["c1", "c2"]);
    await first.sql.close();

    const second = await openPostgresStore(backend); // re-runs migrate: idempotent
    expect(await second.store.isAuthorized("dev-A", "scope-1")).toBe(true);
    expect(await second.store.docScope("doc-1")).toBe("scope-1");
    expect(await second.store.fetch("doc-1", START)).toEqual({ cursor: c2, updates: ["c1", "c2"] });
    // A cursor from before the restart stays valid: same epoch, only the tail.
    const c3 = await second.store.append("doc-1", "scope-1", ["c3"]);
    expect(await second.store.fetch("doc-1", at(c2))).toEqual({ cursor: c3, updates: ["c3"] });
  });

  it("the schema holds only the opaque columns — no plaintext or metadata column", async () => {
    await backend.reset();
    const { sql } = await openPostgresStore(backend);
    const { rows } = await sql.query<{ t: string; c: string; ty: string }>(
      `SELECT table_name AS t, column_name AS c, data_type AS ty
       FROM information_schema.columns WHERE table_schema = $1
       ORDER BY table_name, column_name`,
      [SCHEMA],
    );
    // FERPA-approved EXACTLY (device-enrollment spec §5.1). Adding any column
    // here needs a new ferpa-privacy-reviewer pass first.
    expect(rows.map((r) => `${r.t}.${r.c}:${r.ty}`)).toEqual([
      "acl.device_pubkey:text",
      "acl.scope_tag:text",
      "devices.device_pubkey:text",
      "devices.role:text",
      "devices.status:text",
      "docs.doc_id:text",
      "docs.epoch:text",
      "docs.head_seq:bigint",
      "docs.scope_tag:text",
      "owner_codes.code_sha256:text",
      "owner_codes.expires_at:timestamp with time zone",
      "owner_codes.used:boolean",
      "pairing.expires_at:timestamp with time zone",
      "pairing.grant_blob:text",
      "pairing.opener_pubkey:text",
      "pairing.request_blob:text",
      "pairing.request_pubkey:text",
      "pairing.sid:text",
      "recovery_wrap.blob:text",
      "recovery_wrap.id:boolean",
      "schema_migrations.version:integer",
      "scopes.kind:text",
      "scopes.retired:boolean",
      "scopes.scope_tag:text",
      "updates.blob:text",
      "updates.doc_id:text",
      "updates.seq:bigint",
    ]);
  });

  it("the database stores nothing but the opaque values it was given", async () => {
    await backend.reset();
    const clock = testClock();
    const { store, sql } = await openPostgresStore(backend, { now: clock.now });
    const code = "c0de".repeat(16);
    const given = [
      "dev-A",
      "dev-B",
      "scope-1",
      "doc-1",
      "doc-2",
      "Y2lwaGVy",
      "dGV4dA",
      "Zm9v",
      code,
      "sid-1",
      "cmVxdWVzdA",
      "Z3JhbnQ",
      "d3JhcA",
    ];
    // Fixed vocabulary the schema itself defines (role, status, kind, flags).
    const vocabulary = ["owner", "member", "active", "revoked", "period", "true", "false"];
    await store.issueOwnerCode(code, new Date(clock.now().getTime() + HOUR));
    expect(await store.redeemOwnerCode(code, "dev-A")).toBe("first");
    expect(await store.grantScopes("dev-A", [{ tag: "scope-1", kind: "period" }])).toBe("ok");
    await store.append("doc-1", "scope-1", ["Y2lwaGVy", "dGV4dA"]);
    await store.append("doc-2", "scope-1", ["Zm9v"]);
    await store.append("doc-1", "scope-2", ["cmVqZWN0ZWQ"]); // rejected: other scope
    expect(await store.openPairing("sid-1", "dev-A")).toBe(true);
    expect(await store.putPairingRequest("sid-1", "dev-B", "cmVxdWVzdA")).toBe(true);
    await store.putRecoveryWrap("d3JhcA");
    const pairingExpiry = new Date(clock.now().getTime() + PAIRING_TTL_MS).toISOString();
    const codeExpiry = new Date(clock.now().getTime() + HOUR).toISOString();
    expect(await store.completePairing("sid-1", "dev-A", "dev-B", "member", [], "Z3JhbnQ")).toBe(
      "ok",
    );

    const seen = await allStoredValues(sql);
    // Every stored value is an input verbatim, a schema word, a sequence
    // number, an expiry the store was given or derived, or a relay-minted
    // random epoch (a UUID).
    const allowed = new Set([...given, ...vocabulary, pairingExpiry, codeExpiry]);
    const isEpoch = (v: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
    for (const v of seen) {
      expect(allowed.has(v) || /^\d+$/.test(v) || isEpoch(v), `unexpected stored value ${v}`).toBe(
        true,
      );
    }
    expect(seen.has("cmVqZWN0ZWQ")).toBe(false);
  });

  it("migration v2 refuses a non-empty acl: no backfill, nothing changes", async () => {
    await backend.reset();
    const sql = await backend.open();
    cleanups.push(() => sql.close().catch(() => {}));
    await migrate(sql, 1);
    await sql.query(`INSERT INTO ${SCHEMA}.acl (device_pubkey, scope_tag) VALUES ('dev-A', 's')`);
    await expect(migrate(sql)).rejects.toThrow(/acl must be empty before migration/);
    const { rows: version } = await sql.query<{ v: number }>(
      `SELECT max(version) AS v FROM ${SCHEMA}.schema_migrations`,
    );
    expect(version[0]?.v).toBe(1);
    const { rows: acl } = await sql.query(`SELECT * FROM ${SCHEMA}.acl`);
    expect(acl).toHaveLength(1);
    const { rows: devices } = await sql.query<{ t: string | null }>(
      `SELECT to_regclass('${SCHEMA}.devices')::text AS t`,
    );
    expect(devices[0]?.t ?? null).toBeNull();

    // The operator empties acl (the deploy step); v2 then applies, with no owner promoted.
    await sql.query(`DELETE FROM ${SCHEMA}.acl`);
    await migrate(sql);
    const store = new PostgresRelayStore(sql);
    expect(await store.listDevices()).toEqual([]);
    expect(await store.isAuthorized("dev-A", "s")).toBe(false);
  });

  it("migration v2 keeps v1 docs and updates (the QA synthetic rows stay, unreachable)", async () => {
    await backend.reset();
    const sql = await backend.open();
    cleanups.push(() => sql.close().catch(() => {}));
    await migrate(sql, 1);
    await sql.query(
      `INSERT INTO ${SCHEMA}.docs (doc_id, scope_tag, head_seq, epoch) VALUES ('doc-1', 's', 1, 'e')`,
    );
    await sql.query(`INSERT INTO ${SCHEMA}.updates (doc_id, seq, blob) VALUES ('doc-1', 1, 'YQ')`);
    await migrate(sql);
    const store = new PostgresRelayStore(sql);
    expect(await store.fetch("doc-1", START)).toEqual({ cursor: "e.1", updates: ["YQ"] });
    expect(await store.isAuthorized("dev-A", "s")).toBe(false);
  });

  it("the database itself enforces one master, and acl rows need a device and a scope", async () => {
    await backend.reset();
    const { sql } = await openPostgresStore(backend);
    await sql.query(`INSERT INTO ${SCHEMA}.scopes (scope_tag, kind) VALUES ('m1', 'master')`);
    await expect(
      sql.query(`INSERT INTO ${SCHEMA}.scopes (scope_tag, kind) VALUES ('m2', 'master')`),
    ).rejects.toThrow(/scopes_one_active_master/);
    await expect(
      sql.query(`INSERT INTO ${SCHEMA}.acl (device_pubkey, scope_tag) VALUES ('ghost', 'm1')`),
    ).rejects.toThrow(/foreign key/);
    await sql.query(
      `INSERT INTO ${SCHEMA}.devices (device_pubkey, role) VALUES ('dev-A', 'owner')`,
    );
    await expect(
      sql.query(`INSERT INTO ${SCHEMA}.acl (device_pubkey, scope_tag) VALUES ('dev-A', 'nope')`),
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql.query(`INSERT INTO ${SCHEMA}.devices (device_pubkey, role) VALUES ('dev-B', 'admin')`),
    ).rejects.toThrow(/check constraint/);
  });

  it("updates are append-only in the database itself", async () => {
    await backend.reset();
    const { store, sql } = await openPostgresStore(backend);
    await store.append("doc-1", "scope-1", ["a"]);
    await expect(sql.query(`UPDATE ${SCHEMA}.updates SET blob = 'b'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(sql.query(`DELETE FROM ${SCHEMA}.updates`)).rejects.toThrow(/append-only/);
    expect((await store.fetch("doc-1", START)).updates).toEqual(["a"]);
  });

  it("migrate fails closed on a schema newer than this build", async () => {
    await backend.reset();
    const { sql } = await openPostgresStore(backend);
    await sql.query(`INSERT INTO ${SCHEMA}.schema_migrations (version) VALUES ($1)`, [
      LATEST_SCHEMA_VERSION + 1,
    ]);
    await expect(migrate(sql)).rejects.toThrow(/newer than this build/);
  });
});

describe.each(impls)("RelayStore enrollment control plane — $name", (impl) => {
  /** A store with owner `dev-A` (redeemed `first`) and the test clock. */
  async function withOwner() {
    const clock = testClock();
    const { s } = await impl.make({ now: clock.now });
    const issue = async (code: string, ttl = HOUR) =>
      s.issueOwnerCode(code, new Date(clock.now().getTime() + ttl));
    await issue("code-A");
    expect(await s.redeemOwnerCode("code-A", "dev-A")).toBe("first");
    return { s, clock, issue };
  }

  /** Pair `device` through the full mailbox, opened by `opener`. */
  async function pair(
    s: RelayStore,
    sid: string,
    opener: string,
    device: string,
    role: DeviceRole,
    scopes: readonly ScopeGrant[],
  ) {
    expect(await s.openPairing(sid, opener)).toBe(true);
    expect(await s.putPairingRequest(sid, device, `req-${sid}`)).toBe(true);
    return s.completePairing(sid, opener, device, role, scopes, `grant-${sid}`);
  }

  it("redeem is single-use; `first` once, then `recovery`", async () => {
    const { s, issue } = await withOwner();
    expect(await s.deviceRole("dev-A")).toBe("owner");
    expect(await s.redeemOwnerCode("code-A", "dev-B")).toBe("refused"); // used
    expect(await s.redeemOwnerCode("code-A", "dev-A")).toBe("refused");
    expect(await s.redeemOwnerCode("never-issued", "dev-B")).toBe("refused");
    await issue("code-B");
    expect(await s.redeemOwnerCode("code-B", "dev-B")).toBe("recovery");
    expect(await s.deviceRole("dev-B")).toBe("owner");
  });

  it("with a master scope registered, a redeem is `recovery` and cannot add a second master", async () => {
    const { s, issue } = await withOwner();
    expect(await s.grantScopes("dev-A", [{ tag: "M", kind: "master" }])).toBe("ok");
    await issue("code-B");
    expect(await s.redeemOwnerCode("code-B", "dev-B")).toBe("recovery");
    expect(await s.grantScopes("dev-B", [{ tag: "M2", kind: "master" }])).toBe("second_master");
    expect(await s.grantScopes("dev-B", [{ tag: "M", kind: "master" }])).toBe("ok"); // the same master
  });

  it("an expired code is refused", async () => {
    const { s, clock, issue } = await withOwner();
    await issue("code-B", 1000);
    clock.advance(1000);
    expect(await s.redeemOwnerCode("code-B", "dev-B")).toBe("refused");
    expect(await s.deviceRole("dev-B")).toBeUndefined();
  });

  it("a revoked key is refused permanently, everywhere, and does not burn the code", async () => {
    const { s, issue } = await withOwner();
    expect(await s.grantScopes("dev-A", [{ tag: "P", kind: "period" }])).toBe("ok");
    expect(await pair(s, "sid-1", "dev-A", "dev-B", "member", [{ tag: "P", kind: "period" }])).toBe(
      "ok",
    );
    expect(await s.isAuthorized("dev-B", "P")).toBe(true);
    expect(await s.revoke("dev-B")).toBe("ok");
    expect(await s.revoke("dev-B")).toBe("ok"); // idempotent
    expect(await s.isAuthorized("dev-B", "P")).toBe(false);
    expect(await s.deviceRole("dev-B")).toBeUndefined();
    expect(await s.grantScopes("dev-B", [{ tag: "P", kind: "period" }])).toBe("not_active");
    expect(await s.takePairingGrant("sid-1", "dev-B")).toBeUndefined(); // session dropped on revoke
    await issue("code-B");
    expect(await s.redeemOwnerCode("code-B", "dev-B")).toBe("refused");
    expect(await s.deviceRole("dev-B")).toBeUndefined();
    // Re-pairing the revoked key fails at the request or at the grant.
    expect(await s.openPairing("sid-2", "dev-A")).toBe(true);
    expect(await s.putPairingRequest("sid-2", "dev-B", "req")).toBe(false);
    // The refused redeem left code-B unused.
    expect(await s.redeemOwnerCode("code-B", "dev-C")).toBe("recovery");
  });

  it("a revoked device is refused at completePairing even if its request landed first", async () => {
    const { s, issue } = await withOwner();
    await issue("code-B");
    expect(await s.redeemOwnerCode("code-B", "dev-B")).toBe("recovery");
    expect(await s.openPairing("sid-1", "dev-A")).toBe(true);
    expect(await s.putPairingRequest("sid-1", "dev-X", "req")).toBe(true);
    await issue("code-X");
    expect(await s.redeemOwnerCode("code-X", "dev-X")).toBe("recovery");
    expect(await s.revoke("dev-X")).toBe("ok"); // drops sid-1 too
    expect(await s.completePairing("sid-1", "dev-A", "dev-X", "owner", [], "g")).toBe("not_found");
  });

  it("a scope's kind is fixed on first grant: the master tag is never a period, and back", async () => {
    const { s } = await withOwner();
    expect(await s.grantScopes("dev-A", [{ tag: "M", kind: "master" }])).toBe("ok");
    expect(await s.grantScopes("dev-A", [{ tag: "P", kind: "period" }])).toBe("ok");
    expect(await s.grantScopes("dev-A", [{ tag: "M", kind: "period" }])).toBe("kind_conflict");
    expect(await s.grantScopes("dev-A", [{ tag: "P", kind: "master" }])).toBe("kind_conflict");
    expect(
      await s.grantScopes("dev-A", [
        { tag: "Q", kind: "period" },
        { tag: "Q", kind: "master" },
      ]),
    ).toBe("kind_conflict");
    expect(await s.isAuthorized("dev-A", "Q")).toBe(false); // all or nothing
  });

  it("a second master is refused, in a later request or within one; nothing is written", async () => {
    const { s } = await withOwner();
    expect(
      await s.grantScopes("dev-A", [
        { tag: "M1", kind: "master" },
        { tag: "M2", kind: "master" },
      ]),
    ).toBe("second_master");
    expect(await s.isAuthorized("dev-A", "M1")).toBe(false);
    expect(await s.grantScopes("dev-A", [{ tag: "M1", kind: "master" }])).toBe("ok");
    expect(
      await s.grantScopes("dev-A", [
        { tag: "P-new", kind: "period" },
        { tag: "M2", kind: "master" },
      ]),
    ).toBe("second_master");
    expect(await s.isAuthorized("dev-A", "P-new")).toBe(false);
  });

  it("concurrent master grants under different tags: exactly one lands", async () => {
    const { s } = await withOwner();
    const results = await Promise.all(
      ["M1", "M2", "M3"].map((tag) => s.grantScopes("dev-A", [{ tag, kind: "master" }])),
    );
    expect([...results].sort()).toEqual(["ok", "second_master", "second_master"]);
  });

  it("a member never holds the master scope", async () => {
    const { s } = await withOwner();
    expect(await s.grantScopes("dev-A", [{ tag: "M", kind: "master" }])).toBe("ok");
    expect(await pair(s, "sid-1", "dev-A", "dev-P", "member", [{ tag: "M", kind: "master" }])).toBe(
      "member_master",
    );
    expect(await s.deviceRole("dev-P")).toBeUndefined(); // the refused pairing enrolled nothing
    expect(
      await s.completePairing(
        "sid-1",
        "dev-A",
        "dev-P",
        "member",
        [{ tag: "P", kind: "period" }],
        "g",
      ),
    ).toBe("ok");
    expect(await s.deviceRole("dev-P")).toBe("member");
    expect(await s.grantScopes("dev-P", [{ tag: "M", kind: "master" }])).toBe("member_master");
    expect(await s.grantScopes("dev-P", [{ tag: "M-new", kind: "master" }])).toBe("member_master");
    expect(await s.isAuthorized("dev-P", "M")).toBe(false);
  });

  it("the last active owner cannot be revoked; a member can be", async () => {
    const { s, issue } = await withOwner();
    expect(await s.revoke("dev-A")).toBe("last_owner");
    expect(await s.deviceRole("dev-A")).toBe("owner");
    expect(await pair(s, "sid-1", "dev-A", "dev-P", "member", [])).toBe("ok");
    expect(await s.revoke("dev-P")).toBe("ok");
    await issue("code-B");
    expect(await s.redeemOwnerCode("code-B", "dev-B")).toBe("recovery");
    expect(await s.revoke("dev-A")).toBe("ok");
    expect(await s.revoke("dev-B")).toBe("last_owner");
    expect(await s.revoke("never-seen")).toBe("ok");
  });

  it("concurrent revokes of the only two owners: exactly one lands", async () => {
    const { s, issue } = await withOwner();
    await issue("code-B");
    expect(await s.redeemOwnerCode("code-B", "dev-B")).toBe("recovery");
    const results = await Promise.all([s.revoke("dev-A"), s.revoke("dev-B")]);
    expect([...results].sort()).toEqual(["last_owner", "ok"]);
    const owners = (await s.listDevices()).filter((d) => d.status === "active");
    expect(owners).toHaveLength(1);
  });

  it("a retired scope refuses appends and new grants, still serves reads; master is never retired", async () => {
    const { s } = await withOwner();
    expect(
      await s.grantScopes("dev-A", [
        { tag: "M", kind: "master" },
        { tag: "P", kind: "period" },
      ]),
    ).toBe("ok");
    const c1 = await s.append("doc-1", "P", ["a"]);
    expect(await s.retireScope("P")).toBe("ok");
    expect(await s.retireScope("P")).toBe("ok"); // idempotent
    expect(await s.append("doc-1", "P", ["b"])).toBeUndefined();
    expect(await s.append("doc-new", "P", ["c"])).toBeUndefined();
    expect(await s.docScope("doc-new")).toBeUndefined();
    expect(await s.fetch("doc-1", START)).toEqual({ cursor: c1, updates: ["a"] });
    expect(await s.isAuthorized("dev-A", "P")).toBe(true); // read-only, not revoked
    expect(await pair(s, "sid-1", "dev-A", "dev-P", "member", [{ tag: "P", kind: "period" }])).toBe(
      "retired",
    );
    expect(await s.grantScopes("dev-A", [{ tag: "P", kind: "period" }])).toBe("retired");
    expect(await s.retireScope("M")).toBe("master_scope");
    expect(await s.append("doc-m", "M", ["m"])).toBeDefined();
    expect(await s.retireScope("unknown")).toBe("not_found");
  });

  it("pairing: the full forward-only handshake", async () => {
    const { s } = await withOwner();
    expect(await s.grantScopes("dev-A", [{ tag: "P", kind: "period" }])).toBe("ok");
    expect(await s.openPairing("sid-1", "dev-A")).toBe(true);
    expect(await s.openPairing("sid-1", "dev-A")).toBe(false); // sid taken
    expect(await s.getPairingRequest("sid-1", "dev-A")).toBeUndefined(); // no request yet
    expect(await s.completePairing("sid-1", "dev-A", "dev-B", "member", [], "g")).toBe("not_found");
    expect(await s.putPairingRequest("sid-1", "dev-A", "self")).toBe(false); // opener can't request
    expect(await s.putPairingRequest("sid-1", "dev-B", "req-B")).toBe(true);
    expect(await s.putPairingRequest("sid-1", "dev-C", "req-C")).toBe(false); // first write wins
    expect(await s.putPairingRequest("unknown", "dev-C", "req-C")).toBe(false);
    expect(await s.getPairingRequest("sid-1", "dev-B")).toBeUndefined(); // opener only
    expect(await s.getPairingRequest("sid-1", "dev-A")).toBe("req-B");
    expect(await s.takePairingGrant("sid-1", "dev-B")).toBeUndefined(); // no grant yet
    const P = [{ tag: "P", kind: "period" as const }];
    expect(await s.completePairing("sid-1", "dev-X", "dev-B", "member", P, "g")).toBe("not_found");
    expect(await s.completePairing("sid-1", "dev-A", "dev-C", "member", P, "g")).toBe(
      "device_mismatch",
    );
    expect(await s.completePairing("sid-1", "dev-A", "dev-B", "member", P, "grant-B")).toBe("ok");
    expect(await s.completePairing("sid-1", "dev-A", "dev-B", "member", P, "again")).toBe(
      "not_found",
    );
    expect(await s.getPairingRequest("sid-1", "dev-A")).toBeUndefined(); // moved past request
    expect(await s.isAuthorized("dev-B", "P")).toBe(true);
    expect(await s.deviceRole("dev-B")).toBe("member");
    expect(await s.takePairingGrant("sid-1", "dev-C")).toBeUndefined(); // request signer only
    expect(await s.takePairingGrant("sid-1", "dev-A")).toBeUndefined();
    expect(await s.takePairingGrant("sid-1", "dev-B")).toBe("grant-B");
    expect(await s.takePairingGrant("sid-1", "dev-B")).toBeUndefined(); // deleted
    expect(await s.putPairingRequest("sid-1", "dev-C", "late")).toBe(false);
  });

  it("pairing: only an active owner opens or completes; at most 3 open sessions", async () => {
    const { s, clock, issue } = await withOwner();
    expect(await pair(s, "sid-m", "dev-A", "dev-P", "member", [])).toBe("ok");
    expect(await s.openPairing("sid-x", "dev-P")).toBe(false); // member
    expect(await s.openPairing("sid-x", "never-seen")).toBe(false);
    expect(await s.takePairingGrant("sid-m", "dev-P")).toBe("grant-sid-m");
    expect(await s.openPairing("sid-1", "dev-A")).toBe(true);
    expect(await s.openPairing("sid-2", "dev-A")).toBe(true);
    expect(await s.openPairing("sid-3", "dev-A")).toBe(true);
    expect(await s.openPairing("sid-4", "dev-A")).toBe(false); // limit
    clock.advance(PAIRING_TTL_MS);
    expect(await s.openPairing("sid-4", "dev-A")).toBe(true); // expired ones don't count

    // An opener revoked mid-handshake can no longer read the request or complete.
    await issue("code-B");
    expect(await s.redeemOwnerCode("code-B", "dev-B")).toBe("recovery");
    expect(await s.putPairingRequest("sid-4", "dev-C", "req")).toBe(true);
    expect(await s.revoke("dev-A")).toBe("ok");
    expect(await s.getPairingRequest("sid-4", "dev-A")).toBeUndefined();
    expect(await s.completePairing("sid-4", "dev-A", "dev-C", "member", [], "g")).toBe("not_found");
  });

  it("pairing: an owner device is re-paired only with its own role", async () => {
    const { s } = await withOwner();
    expect(await pair(s, "sid-1", "dev-A", "dev-P", "member", [])).toBe("ok");
    expect(await pair(s, "sid-2", "dev-A", "dev-P", "owner", [])).toBe("role_conflict");
    expect(await s.deviceRole("dev-P")).toBe("member");
  });

  it("pairing: every step refuses an expired session; sweepExpired removes it", async () => {
    const { s, clock } = await withOwner();
    expect(await s.openPairing("sid-1", "dev-A")).toBe(true);
    expect(await s.openPairing("sid-2", "dev-A")).toBe(true);
    expect(await s.putPairingRequest("sid-2", "dev-B", "req")).toBe(true);
    clock.advance(PAIRING_TTL_MS - 1);
    expect(await s.getPairingRequest("sid-2", "dev-A")).toBe("req");
    clock.advance(1);
    expect(await s.putPairingRequest("sid-1", "dev-B", "req")).toBe(false);
    expect(await s.getPairingRequest("sid-2", "dev-A")).toBeUndefined();
    expect(await s.completePairing("sid-2", "dev-A", "dev-B", "member", [], "g")).toBe("not_found");
    expect(await s.openPairing("sid-1", "dev-A")).toBe(false); // the expired row still holds the sid
    await s.sweepExpired();
    expect(await s.openPairing("sid-1", "dev-A")).toBe(true); // swept
  });

  it("an expired completed grant is never handed out", async () => {
    const { s, clock } = await withOwner();
    expect(await pair(s, "sid-1", "dev-A", "dev-B", "member", [])).toBe("ok");
    clock.advance(PAIRING_TTL_MS);
    expect(await s.takePairingGrant("sid-1", "dev-B")).toBeUndefined();
  });

  it("sweepExpired removes expired unused owner codes, keeps used and live ones", async () => {
    const { s, clock, issue } = await withOwner(); // code-A: used
    await issue("code-old", 1000);
    await issue("code-live", 2 * HOUR);
    clock.advance(HOUR + 1); // code-A and code-old expired
    await s.sweepExpired();
    // A re-issue succeeds only for a hash the sweep removed.
    await expect(issue("code-old")).resolves.toBeUndefined();
    await expect(issue("code-A")).rejects.toThrow();
    await expect(issue("code-live")).rejects.toThrow();
    expect(await s.redeemOwnerCode("code-live", "dev-B")).toBe("recovery");
  });

  it("listDevices: every device, its role, status and scopes with kind and retired", async () => {
    const { s } = await withOwner();
    expect(
      await s.grantScopes("dev-A", [
        { tag: "P2", kind: "period" },
        { tag: "M", kind: "master" },
      ]),
    ).toBe("ok");
    expect(
      await pair(s, "sid-1", "dev-A", "dev-P", "member", [{ tag: "P1", kind: "period" }]),
    ).toBe("ok");
    expect(await pair(s, "sid-2", "dev-A", "dev-Q", "member", [])).toBe("ok");
    expect(await s.retireScope("P1")).toBe("ok");
    expect(await s.revoke("dev-Q")).toBe("ok");
    expect(await s.listDevices()).toEqual([
      {
        device: "dev-A",
        role: "owner",
        status: "active",
        scopes: [
          { tag: "M", kind: "master", retired: false },
          { tag: "P2", kind: "period", retired: false },
        ],
      },
      {
        device: "dev-P",
        role: "member",
        status: "active",
        scopes: [{ tag: "P1", kind: "period", retired: true }],
      },
      { device: "dev-Q", role: "member", status: "revoked", scopes: [] },
    ]);
  });

  it("recovery wrap: absent, put, replaced", async () => {
    const { s } = await impl.make();
    expect(await s.getRecoveryWrap()).toBeUndefined();
    await s.putRecoveryWrap("wrap-1");
    expect(await s.getRecoveryWrap()).toBe("wrap-1");
    await s.putRecoveryWrap("wrap-2");
    expect(await s.getRecoveryWrap()).toBe("wrap-2");
  });
});
