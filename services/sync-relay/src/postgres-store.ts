// The durable RelayStore: the same append-only, ciphertext-only contract as
// InMemoryRelayStore (store.contract.test.ts runs both), backed by Postgres.
//
// What the database holds (schema `sync_relay`, see migrations.ts) is exactly
// what the in-memory store holds: opaque doc ids, opaque scope tags, device
// signing public keys, base64 ciphertext blobs and integer sequence numbers.
// No timestamps, no client metadata, no plaintext column of any kind.
//
// Every write is a single SQL statement, so each is atomic on its own and the
// store needs no client-side transaction (or a dedicated connection).

import { SCHEMA } from "./migrations.js";
import type { SqlClient } from "./sql.js";
import type { FetchResult, RelayStore } from "./store.js";

// One statement: bind-or-extend the doc row (row-locked by ON CONFLICT, so
// concurrent appends to one doc serialize) and insert the blobs at the sequence
// numbers just reserved. When the doc is bound to another scope the WHERE
// suppresses the update, `head` is empty, nothing is inserted, and no row returns.
const APPEND_SQL = `
WITH head AS (
  INSERT INTO ${SCHEMA}.docs AS d (doc_id, scope_tag, head_seq)
  VALUES ($1, $2, cardinality($3::text[]))
  ON CONFLICT (doc_id) DO UPDATE
    SET head_seq = d.head_seq + cardinality($3::text[])
    WHERE d.scope_tag = EXCLUDED.scope_tag
  RETURNING d.head_seq
), ins AS (
  INSERT INTO ${SCHEMA}.updates (doc_id, seq, blob)
  SELECT $1, head.head_seq - cardinality($3::text[]) + u.ord, u.blob
  FROM head, unnest($3::text[]) WITH ORDINALITY AS u(blob, ord)
)
SELECT head_seq::text AS cursor FROM head`;

// One statement, so the cursor (head_seq) and the updates come from the same
// snapshot: a concurrent append can never move the cursor past an update this
// fetch did not return. A `since` past the head restarts from 0 (see RelayStore).
const FETCH_SQL = `
SELECT d.head_seq::text AS head, u.blob
FROM ${SCHEMA}.docs d
LEFT JOIN ${SCHEMA}.updates u ON u.doc_id = d.doc_id
  AND u.seq > CASE WHEN $2::numeric > d.head_seq THEN 0 ELSE $2::numeric END
WHERE d.doc_id = $1
ORDER BY u.seq`;

export class PostgresRelayStore implements RelayStore {
  readonly #sql: SqlClient;

  /** The schema must already be migrated (migrate() in migrations.ts). */
  constructor(sql: SqlClient) {
    this.#sql = sql;
  }

  async isAuthorized(devicePublicKeyB64: string, scopeTag: string): Promise<boolean> {
    const { rows } = await this.#sql.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${SCHEMA}.acl WHERE device_pubkey = $1 AND scope_tag = $2) AS ok`,
      [devicePublicKeyB64, scopeTag],
    );
    return rows[0]?.ok === true;
  }

  async authorize(devicePublicKeyB64: string, scopeTag: string): Promise<void> {
    await this.#sql.query(
      `INSERT INTO ${SCHEMA}.acl (device_pubkey, scope_tag) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [devicePublicKeyB64, scopeTag],
    );
  }

  async docScope(docId: string): Promise<string | undefined> {
    const { rows } = await this.#sql.query<{ scope_tag: string }>(
      `SELECT scope_tag FROM ${SCHEMA}.docs WHERE doc_id = $1`,
      [docId],
    );
    return rows[0]?.scope_tag;
  }

  async append(
    docId: string,
    scopeTag: string,
    blobsB64: readonly string[],
  ): Promise<string | undefined> {
    const { rows } = await this.#sql.query<{ cursor: string }>(APPEND_SQL, [
      docId,
      scopeTag,
      [...blobsB64],
    ]);
    return rows[0]?.cursor;
  }

  async fetch(docId: string, since: number): Promise<FetchResult> {
    const { rows } = await this.#sql.query<{ head: string; blob: string | null }>(FETCH_SQL, [
      docId,
      since,
    ]);
    const first = rows[0];
    if (first === undefined) {
      return { cursor: "0", updates: [] };
    }
    const updates = rows.flatMap((r) => (r.blob === null ? [] : [r.blob]));
    return { cursor: first.head, updates };
  }
}
