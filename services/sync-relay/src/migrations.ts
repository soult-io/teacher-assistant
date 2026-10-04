// Schema + forward-only migrations for PostgresRelayStore, applied at relay
// startup (index.ts) before the port opens.
//
// Each run is ONE parameterless script, which Postgres executes as a single
// implicit transaction: it takes a transaction-scoped advisory lock (so two
// relays starting together cannot race), creates the schema if missing, and
// applies every migration not yet recorded. Any failure rolls the whole run back.
//
// Columns are the FERPA surface (D1): opaque ids, opaque scope tags, device
// public keys, base64 ciphertext, integer sequence numbers. Nothing else — no
// timestamps, no client/IP metadata. store.contract.test.ts pins this list.

import type { SqlClient } from "./sql.js";

export const SCHEMA = "sync_relay";

/** Fixed, arbitrary key for pg_advisory_xact_lock; only this migration takes it. */
const MIGRATION_LOCK_KEY = 7_311_725_801;

/**
 * Ordered; append new entries, never edit a shipped one. Each runs inside a
 * PL/pgSQL DO block in one transaction, so statements that cannot run there
 * (e.g. CREATE INDEX CONCURRENTLY) need a different mechanism. Startup shares
 * the pool's 10 s statement_timeout: a long migration must raise it locally.
 */
const MIGRATIONS: readonly { readonly version: number; readonly sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE ${SCHEMA}.acl (
        device_pubkey text NOT NULL,
        scope_tag     text NOT NULL,
        PRIMARY KEY (device_pubkey, scope_tag)
      );
      CREATE TABLE ${SCHEMA}.docs (
        doc_id    text   PRIMARY KEY,
        scope_tag text   NOT NULL,
        head_seq  bigint NOT NULL CHECK (head_seq >= 0)
      );
      CREATE TABLE ${SCHEMA}.updates (
        doc_id text   NOT NULL REFERENCES ${SCHEMA}.docs (doc_id),
        seq    bigint NOT NULL CHECK (seq > 0),
        blob   text   NOT NULL,
        PRIMARY KEY (doc_id, seq)
      );
      -- Append-only, enforced by the database as well as the code.
      CREATE FUNCTION ${SCHEMA}.reject_update_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'sync_relay.updates is append-only';
        END
      $fn$;
      CREATE TRIGGER updates_append_only
        BEFORE UPDATE OR DELETE ON ${SCHEMA}.updates
        FOR EACH ROW EXECUTE FUNCTION ${SCHEMA}.reject_update_mutation();
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

function migrationScript(): string {
  const steps = MIGRATIONS.map(
    (m) => `
    DO $migrate$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM ${SCHEMA}.schema_migrations WHERE version = ${m.version}) THEN
        ${m.sql}
        INSERT INTO ${SCHEMA}.schema_migrations (version) VALUES (${m.version});
      END IF;
    END
    $migrate$;`,
  );
  return [
    `SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY});`,
    `CREATE SCHEMA IF NOT EXISTS ${SCHEMA};`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (version integer PRIMARY KEY);`,
    ...steps,
  ].join("\n");
}

/**
 * Bring the schema up to LATEST_SCHEMA_VERSION. Throws (fail closed) if the
 * database cannot be reached, a migration fails, or the database carries a
 * NEWER schema than this build knows (a rollback onto a migrated database).
 */
export async function migrate(sql: SqlClient): Promise<void> {
  await sql.exec(migrationScript());
  const { rows } = await sql.query<{ v: number | null }>(
    `SELECT max(version) AS v FROM ${SCHEMA}.schema_migrations`,
  );
  const current = rows[0]?.v ?? 0;
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `sync_relay schema version ${current} is newer than this build (${LATEST_SCHEMA_VERSION})`,
    );
  }
}
