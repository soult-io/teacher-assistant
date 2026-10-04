// The RelayStore contract, run against every implementation:
//   - memory    InMemoryRelayStore
//   - pglite    PostgresRelayStore on PGlite (real Postgres, in-process) — always runs
//   - postgres  PostgresRelayStore on a real server via pg.Pool — runs when
//               TEST_DATABASE_URL is set; REQUIRED in CI (the job provides one)
// Plus the Postgres-only guarantees: data survives a restart, the schema holds
// only the opaque columns, the database stores nothing but what it was given,
// updates are append-only at the database level, and migrations are idempotent.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, migrate, ROTATE_EPOCHS_SQL, SCHEMA } from "./migrations.js";
import { PostgresRelayStore } from "./postgres-store.js";
import { poolClient, type SqlClient } from "./sql.js";
import { InMemoryRelayStore, parseCursor, type RelayStore } from "./store.js";

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

async function openPostgresStore(backend: Backend) {
  const sql = await backend.open();
  cleanups.push(() => sql.close().catch(() => {}));
  await migrate(sql);
  return { store: new PostgresRelayStore(sql), sql };
}

interface Impl {
  readonly name: string;
  /** A fresh store, plus what a backup restore does to it (re-mint every epoch). */
  make(): Promise<{ s: RelayStore; restoreEpochs(): Promise<void> }>;
}

const impls: Impl[] = [
  {
    name: "memory",
    async make() {
      const s = new InMemoryRelayStore();
      return { s, restoreEpochs: async () => s.rotateEpochs() };
    },
  },
  ...pgBackends.map((b) => ({
    name: b.name,
    async make() {
      await b.reset();
      const { store, sql } = await openPostgresStore(b);
      return { s: store, restoreEpochs: () => rotateEpochsSql(sql) };
    },
  })),
];

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
  it("ACL: unknown is false; authorize grants exactly (device, scope); idempotent", async () => {
    const { s } = await impl.make();
    expect(await s.isAuthorized("dev-A", "scope-1")).toBe(false);
    await s.authorize("dev-A", "scope-1");
    await s.authorize("dev-A", "scope-1");
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

describe.each(pgBackends)("PostgresRelayStore durability + privacy — $name", (backend) => {
  it("data survives a relay restart (new connection, same database)", async () => {
    await backend.reset();
    const first = await openPostgresStore(backend);
    await first.store.authorize("dev-A", "scope-1");
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
    expect(rows.map((r) => `${r.t}.${r.c}:${r.ty}`)).toEqual([
      "acl.device_pubkey:text",
      "acl.scope_tag:text",
      "docs.doc_id:text",
      "docs.epoch:text",
      "docs.head_seq:bigint",
      "docs.scope_tag:text",
      "schema_migrations.version:integer",
      "updates.blob:text",
      "updates.doc_id:text",
      "updates.seq:bigint",
    ]);
  });

  it("the database stores nothing but the opaque values it was given", async () => {
    await backend.reset();
    const { store, sql } = await openPostgresStore(backend);
    const given = ["dev-A", "scope-1", "doc-1", "doc-2", "Y2lwaGVy", "dGV4dA", "Zm9v"];
    await store.authorize("dev-A", "scope-1");
    await store.append("doc-1", "scope-1", ["Y2lwaGVy", "dGV4dA"]);
    await store.append("doc-2", "scope-1", ["Zm9v"]);
    await store.append("doc-1", "scope-2", ["cmVqZWN0ZWQ"]); // rejected: other scope

    const seen = new Set<string>();
    for (const table of ["acl", "docs", "updates"]) {
      const { rows } = await sql.query<Record<string, unknown>>(`SELECT * FROM ${SCHEMA}.${table}`);
      for (const row of rows) {
        for (const v of Object.values(row)) {
          seen.add(String(v));
        }
      }
    }
    for (const v of seen) {
      // Every stored value is an input verbatim, a sequence number, or a
      // relay-minted random epoch (a UUID).
      const isEpoch = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        v,
      );
      expect(given.includes(v) || /^\d+$/.test(v) || isEpoch, `unexpected stored value ${v}`).toBe(
        true,
      );
    }
    expect(seen.has("cmVqZWN0ZWQ")).toBe(false);
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
