// Schema + forward-only migrations for PostgresRelayStore, applied at relay
// startup (index.ts) before the port opens.
//
// Each run is ONE parameterless script, which Postgres executes as a single
// implicit transaction: it takes a transaction-scoped advisory lock (so two
// relays starting together cannot race), creates the schema if missing, and
// applies every migration not yet recorded. Any failure rolls the whole run back.
//
// Columns are the FERPA surface (D1): opaque ids, opaque scope tags, device
// public keys, base64 ciphertext/sealed blobs, integer sequence numbers, a
// random per-doc epoch, and (v2, device enrollment) fixed role/status/kind
// words, owner-code hashes and operator/pairing expiry times. Nothing else — no
// student or activity timestamp, no client/IP metadata. store.contract.test.ts
// pins the exact column list; the FERPA review approved exactly that list, so
// any new column needs a new FERPA review.
//
// RESTORING FROM A BACKUP: after the restore and BEFORE the relay serves
// traffic, run ROTATE_EPOCHS_SQL (below) as the DB owner:
//   UPDATE sync_relay.docs SET epoch = gen_random_uuid()::text;
// Sequence numbers are reused after a restore; a new epoch makes every client
// cursor from before the restore re-sync from 0 instead of skipping updates.

import type { SqlClient } from "./sql.js";

export const SCHEMA = "sync_relay";

/** Run after restoring a backup, BEFORE the relay serves traffic (see header). */
export const ROTATE_EPOCHS_SQL = `UPDATE ${SCHEMA}.docs SET epoch = gen_random_uuid()::text`;

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
        head_seq  bigint NOT NULL CHECK (head_seq >= 0),
        epoch     text   NOT NULL  -- random id, part of every cursor (store.ts Cursor)
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
  {
    // Device enrollment (device-enrollment spec §5.1). No backfill: no existing
    // key is ever promoted to owner, so a non-empty acl refuses the migration
    // (and the relay refuses to start) until the operator empties it.
    version: 2,
    sql: `
      IF EXISTS (SELECT 1 FROM ${SCHEMA}.acl) THEN
        RAISE EXCEPTION 'sync_relay v2: acl must be empty before migration';
      END IF;
      CREATE TABLE ${SCHEMA}.devices (
        device_pubkey text PRIMARY KEY,
        role   text NOT NULL CHECK (role IN ('owner','member')),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked'))
      );
      CREATE TABLE ${SCHEMA}.scopes (
        scope_tag text    PRIMARY KEY,
        kind      text    NOT NULL CHECK (kind IN ('master','period')),
        retired   boolean NOT NULL DEFAULT false
      );
      -- One master per deployment; also covers a retired row (EU-12 must handle it).
      CREATE UNIQUE INDEX scopes_one_active_master ON ${SCHEMA}.scopes (kind) WHERE kind = 'master';
      ALTER TABLE ${SCHEMA}.acl
        ADD FOREIGN KEY (device_pubkey) REFERENCES ${SCHEMA}.devices (device_pubkey),
        ADD FOREIGN KEY (scope_tag)     REFERENCES ${SCHEMA}.scopes (scope_tag);
      CREATE TABLE ${SCHEMA}.owner_codes (
        code_sha256 text PRIMARY KEY,           -- hex SHA-256 of the 128-bit code
        expires_at  timestamptz NOT NULL,
        used        boolean NOT NULL DEFAULT false
      );
      CREATE TABLE ${SCHEMA}.pairing (
        sid            text PRIMARY KEY,         -- BLAKE2b-128 of the pairing secret
        opener_pubkey  text NOT NULL,
        request_pubkey text,                     -- signer of request-put
        request_blob   text,
        grant_blob     text,
        expires_at     timestamptz NOT NULL
      );
      CREATE TABLE ${SCHEMA}.recovery_wrap (
        id   boolean PRIMARY KEY DEFAULT true CHECK (id),   -- single row
        blob text NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

function migrationScript(target: number): string {
  const steps = MIGRATIONS.filter((m) => m.version <= target).map(
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
 * database cannot be reached, a migration fails (including the v2 preflight on
 * a non-empty acl), or the database carries a NEWER schema than this build
 * knows (a rollback onto a migrated database). `target` stops at an older
 * version; only tests pass it (to build a v1 database for the v2 preflight).
 */
export async function migrate(sql: SqlClient, target = LATEST_SCHEMA_VERSION): Promise<void> {
  await sql.exec(migrationScript(target));
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
