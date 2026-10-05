// The durable RelayStore: the same append-only, ciphertext-only contract as
// InMemoryRelayStore (store.contract.test.ts runs both), backed by Postgres.
//
// What the database holds (schema `sync_relay`, see migrations.ts) is exactly
// what the in-memory store holds: opaque doc ids, opaque scope tags, device
// signing public keys, base64 ciphertext/sealed blobs, integer sequence
// numbers, a random per-doc epoch (carries no information), fixed
// role/status/kind words, owner-code hashes and operator/pairing expiry times.
// No student or activity timestamp, no client metadata, no plaintext column.
//
// Data-plane writes (append) and the pairing request write are one SQL
// statement each, so each is atomic on its own. Every other control-plane
// write (including the pairing take and the expiry sweep) runs in one transaction that first takes CONTROL_LOCK_KEY, so its
// checks (last owner, single master, kind fixed, member never master) and its
// writes cannot interleave with another control write. Control writes are rare
// (enrollment, pairing, revoke), so serializing them costs nothing.

import { SCHEMA } from "./migrations.js";
import type { SqlClient, SqlQuery } from "./sql.js";
import {
  type CompletePairingResult,
  type Cursor,
  checkGrant,
  type DeviceListing,
  type DeviceRole,
  type DeviceStatus,
  type FetchResult,
  formatCursor,
  type GrantResult,
  MAX_OPEN_PAIRINGS,
  newEpoch,
  PAIRING_TTL_MS,
  type RedeemResult,
  type RelayStore,
  type RetireResult,
  type RevokeResult,
  type ScopeGrant,
  type ScopeKind,
  type StoreOptions,
} from "./store.js";

/** Fixed, arbitrary key for pg_advisory_xact_lock; only control-plane writes take it. */
const CONTROL_LOCK_KEY = 7_311_725_802;

// One statement: bind-or-extend the doc row (row-locked by ON CONFLICT, so
// concurrent appends to one doc serialize) and insert the blobs at the sequence
// numbers just reserved. When the doc is bound to another scope the WHERE
// suppresses the update, `head` is empty, nothing is inserted, and no row
// returns; a retired scope inserts no row at all, with the same result.
const APPEND_SQL = `
WITH head AS (
  INSERT INTO ${SCHEMA}.docs AS d (doc_id, scope_tag, head_seq, epoch)
  SELECT $1, $2, cardinality($3::text[]), $4
  WHERE NOT EXISTS (SELECT 1 FROM ${SCHEMA}.scopes WHERE scope_tag = $2 AND retired)
  ON CONFLICT (doc_id) DO UPDATE
    SET head_seq = d.head_seq + cardinality($3::text[])
    WHERE d.scope_tag = EXCLUDED.scope_tag
  RETURNING d.head_seq, d.epoch
), ins AS (
  INSERT INTO ${SCHEMA}.updates (doc_id, seq, blob)
  SELECT $1, head.head_seq - cardinality($3::text[]) + u.ord, u.blob
  FROM head, unnest($3::text[]) WITH ORDINALITY AS u(blob, ord)
)
SELECT epoch, head_seq::text AS head FROM head`;

// One statement, so the cursor (head_seq) and the updates come from the same
// snapshot: a concurrent append can never move the cursor past an update this
// fetch did not return. A cursor from another epoch, or past the head, restarts
// from 0 (see RelayStore.fetch).
const FETCH_SQL = `
SELECT d.epoch, d.head_seq::text AS head, u.blob
FROM ${SCHEMA}.docs d
LEFT JOIN ${SCHEMA}.updates u ON u.doc_id = d.doc_id
  AND u.seq > CASE
    WHEN d.epoch IS DISTINCT FROM $3::text OR $2::bigint > d.head_seq THEN 0
    ELSE $2::bigint
  END
WHERE d.doc_id = $1
ORDER BY u.seq`;

const ACTIVE_OWNER = (param: string) =>
  `EXISTS (SELECT 1 FROM ${SCHEMA}.devices
           WHERE device_pubkey = ${param} AND role = 'owner' AND status = 'active')`;

interface DeviceRow {
  readonly role: DeviceRole;
  readonly status: DeviceStatus;
}

interface PairingRow {
  readonly opener_pubkey: string;
  readonly request_pubkey: string | null;
  readonly grant_blob: string | null;
}

export class PostgresRelayStore implements RelayStore {
  readonly #sql: SqlClient;
  readonly #now: () => Date;

  /** The schema must already be migrated (migrate() in migrations.ts). */
  constructor(sql: SqlClient, options: StoreOptions = {}) {
    this.#sql = sql;
    this.#now = options.now ?? (() => new Date());
  }

  /** One control-plane transaction, serialized against every other (see header). */
  #control<T>(fn: (tx: SqlQuery) => Promise<T>): Promise<T> {
    return this.#sql.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(${CONTROL_LOCK_KEY})`);
      return fn(tx);
    });
  }

  async isAuthorized(devicePublicKeyB64: string, scopeTag: string): Promise<boolean> {
    const { rows } = await this.#sql.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ${SCHEMA}.acl a JOIN ${SCHEMA}.devices d USING (device_pubkey)
         WHERE a.device_pubkey = $1 AND a.scope_tag = $2 AND d.status = 'active'
       ) AS ok`,
      [devicePublicKeyB64, scopeTag],
    );
    return rows[0]?.ok === true;
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
    const { rows } = await this.#sql.query<{ epoch: string; head: string }>(APPEND_SQL, [
      docId,
      scopeTag,
      [...blobsB64],
      newEpoch(),
    ]);
    const row = rows[0];
    return row === undefined ? undefined : formatCursor(row.epoch, row.head);
  }

  async fetch(docId: string, since: Cursor): Promise<FetchResult> {
    const { rows } = await this.#sql.query<{ epoch: string; head: string; blob: string | null }>(
      FETCH_SQL,
      [docId, since.seq, since.epoch ?? null],
    );
    const first = rows[0];
    if (first === undefined) {
      return { cursor: "0", updates: [] };
    }
    const updates = rows.flatMap((r) => (r.blob === null ? [] : [r.blob]));
    return { cursor: formatCursor(first.epoch, first.head), updates };
  }

  async issueOwnerCode(codeSha256: string, expiresAt: Date): Promise<void> {
    await this.#sql.query(
      `INSERT INTO ${SCHEMA}.owner_codes (code_sha256, expires_at) VALUES ($1, $2)`,
      [codeSha256, expiresAt],
    );
  }

  redeemOwnerCode(codeSha256: string, devicePublicKeyB64: string): Promise<RedeemResult> {
    return this.#control(async (tx) => {
      const { rows } = await tx.query<{ usable: boolean; revoked: boolean; first: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM ${SCHEMA}.owner_codes
                   WHERE code_sha256 = $1 AND NOT used AND expires_at > $3) AS usable,
           EXISTS (SELECT 1 FROM ${SCHEMA}.devices
                   WHERE device_pubkey = $2 AND status = 'revoked') AS revoked,
           NOT EXISTS (SELECT 1 FROM ${SCHEMA}.devices WHERE role = 'owner' AND status = 'active')
             AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.scopes WHERE kind = 'master') AS first`,
        [codeSha256, devicePublicKeyB64, this.#now()],
      );
      const row = rows[0];
      if (row === undefined || !row.usable || row.revoked) {
        return "refused";
      }
      await tx.query(`UPDATE ${SCHEMA}.owner_codes SET used = true WHERE code_sha256 = $1`, [
        codeSha256,
      ]);
      await tx.query(
        `INSERT INTO ${SCHEMA}.devices (device_pubkey, role) VALUES ($1, 'owner')
         ON CONFLICT (device_pubkey) DO UPDATE SET role = 'owner'`,
        [devicePublicKeyB64],
      );
      return row.first ? "first" : "recovery";
    });
  }

  async deviceRole(devicePublicKeyB64: string): Promise<DeviceRole | undefined> {
    const { rows } = await this.#sql.query<{ role: DeviceRole }>(
      `SELECT role FROM ${SCHEMA}.devices WHERE device_pubkey = $1 AND status = 'active'`,
      [devicePublicKeyB64],
    );
    return rows[0]?.role;
  }

  /** checkGrant against the database, inside a control transaction. */
  async #checkGrant(
    tx: SqlQuery,
    device: DeviceRow | undefined,
    scopes: readonly ScopeGrant[],
  ): Promise<GrantResult> {
    const { rows } = await tx.query<{ scope_tag: string; kind: ScopeKind; retired: boolean }>(
      `SELECT scope_tag, kind, retired FROM ${SCHEMA}.scopes
       WHERE scope_tag = ANY($1::text[]) OR kind = 'master'`,
      [scopes.map((s) => s.tag)],
    );
    const known = new Map(rows.map((r) => [r.scope_tag, { kind: r.kind, retired: r.retired }]));
    const master = rows.find((r) => r.kind === "master")?.scope_tag;
    return checkGrant(device, scopes, known, master);
  }

  async #writeGrant(tx: SqlQuery, devicePublicKeyB64: string, scopes: readonly ScopeGrant[]) {
    const tags = scopes.map((s) => s.tag);
    await tx.query(
      `INSERT INTO ${SCHEMA}.scopes (scope_tag, kind)
       SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING`,
      [tags, scopes.map((s) => s.kind)],
    );
    await tx.query(
      `INSERT INTO ${SCHEMA}.acl (device_pubkey, scope_tag)
       SELECT $1, t FROM unnest($2::text[]) AS t ON CONFLICT DO NOTHING`,
      [devicePublicKeyB64, tags],
    );
  }

  async #device(tx: SqlQuery, devicePublicKeyB64: string): Promise<DeviceRow | undefined> {
    const { rows } = await tx.query<DeviceRow>(
      `SELECT role, status FROM ${SCHEMA}.devices WHERE device_pubkey = $1`,
      [devicePublicKeyB64],
    );
    return rows[0];
  }

  grantScopes(devicePublicKeyB64: string, scopes: readonly ScopeGrant[]): Promise<GrantResult> {
    return this.#control(async (tx) => {
      const result = await this.#checkGrant(tx, await this.#device(tx, devicePublicKeyB64), scopes);
      if (result === "ok") {
        await this.#writeGrant(tx, devicePublicKeyB64, scopes);
      }
      return result;
    });
  }

  retireScope(scopeTag: string): Promise<RetireResult> {
    return this.#control(async (tx) => {
      const { rows } = await tx.query<{ kind: ScopeKind }>(
        `SELECT kind FROM ${SCHEMA}.scopes WHERE scope_tag = $1`,
        [scopeTag],
      );
      const kind = rows[0]?.kind;
      if (kind === undefined) {
        return "not_found";
      }
      if (kind === "master") {
        return "master_scope";
      }
      await tx.query(`UPDATE ${SCHEMA}.scopes SET retired = true WHERE scope_tag = $1`, [scopeTag]);
      return "ok";
    });
  }

  revoke(devicePublicKeyB64: string): Promise<RevokeResult> {
    return this.#control(async (tx) => {
      const device = await this.#device(tx, devicePublicKeyB64);
      if (device?.status !== "active") {
        return "ok";
      }
      if (device.role === "owner") {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${SCHEMA}.devices WHERE role = 'owner' AND status = 'active'`,
        );
        if ((rows[0]?.n ?? 0) <= 1) {
          return "last_owner";
        }
      }
      await tx.query(`UPDATE ${SCHEMA}.devices SET status = 'revoked' WHERE device_pubkey = $1`, [
        devicePublicKeyB64,
      ]);
      await tx.query(`DELETE FROM ${SCHEMA}.acl WHERE device_pubkey = $1`, [devicePublicKeyB64]);
      await tx.query(
        `DELETE FROM ${SCHEMA}.pairing WHERE opener_pubkey = $1 OR request_pubkey = $1`,
        [devicePublicKeyB64],
      );
      return "ok";
    });
  }

  async listDevices(): Promise<DeviceListing[]> {
    const { rows } = await this.#sql.query<
      DeviceRow & {
        device_pubkey: string;
        scope_tag: string | null;
        kind: ScopeKind | null;
        retired: boolean | null;
      }
    >(
      `SELECT d.device_pubkey, d.role, d.status, s.scope_tag, s.kind, s.retired
       FROM ${SCHEMA}.devices d
       LEFT JOIN ${SCHEMA}.acl a ON a.device_pubkey = d.device_pubkey
       LEFT JOIN ${SCHEMA}.scopes s ON s.scope_tag = a.scope_tag
       ORDER BY d.device_pubkey COLLATE "C", s.scope_tag COLLATE "C"`,
    );
    const out: {
      device: string;
      role: DeviceRole;
      status: DeviceStatus;
      scopes: DeviceListing["scopes"][number][];
    }[] = [];
    for (const r of rows) {
      let entry = out.at(-1);
      if (entry?.device !== r.device_pubkey) {
        entry = { device: r.device_pubkey, role: r.role, status: r.status, scopes: [] };
        out.push(entry);
      }
      if (r.scope_tag !== null && r.kind !== null && r.retired !== null) {
        entry.scopes.push({ tag: r.scope_tag, kind: r.kind, retired: r.retired });
      }
    }
    return out;
  }

  openPairing(sid: string, openerPublicKeyB64: string): Promise<boolean> {
    return this.#control(async (tx) => {
      const now = this.#now();
      const { rows } = await tx.query<{ sid: string }>(
        `INSERT INTO ${SCHEMA}.pairing (sid, opener_pubkey, expires_at)
         SELECT $1, $2, $4
         WHERE ${ACTIVE_OWNER("$2")}
           AND (SELECT count(*) FROM ${SCHEMA}.pairing WHERE expires_at > $3) < ${MAX_OPEN_PAIRINGS}
         ON CONFLICT (sid) DO NOTHING
         RETURNING sid`,
        [sid, openerPublicKeyB64, now, new Date(now.getTime() + PAIRING_TTL_MS)],
      );
      return rows.length === 1;
    });
  }

  async putPairingRequest(sid: string, signerPublicKeyB64: string, blob: string): Promise<boolean> {
    const { rows } = await this.#sql.query<{ sid: string }>(
      `UPDATE ${SCHEMA}.pairing SET request_pubkey = $2, request_blob = $3
       WHERE sid = $1 AND request_pubkey IS NULL AND expires_at > $4 AND opener_pubkey <> $2
         AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}.devices
                         WHERE device_pubkey = $2 AND status = 'revoked')
       RETURNING sid`,
      [sid, signerPublicKeyB64, blob, this.#now()],
    );
    return rows.length === 1;
  }

  async getPairingRequest(sid: string, openerPublicKeyB64: string): Promise<string | undefined> {
    const { rows } = await this.#sql.query<{ request_blob: string }>(
      `SELECT request_blob FROM ${SCHEMA}.pairing
       WHERE sid = $1 AND opener_pubkey = $2 AND expires_at > $3
         AND request_blob IS NOT NULL AND grant_blob IS NULL AND ${ACTIVE_OWNER("$2")}`,
      [sid, openerPublicKeyB64, this.#now()],
    );
    return rows[0]?.request_blob;
  }

  completePairing(
    sid: string,
    openerPublicKeyB64: string,
    devicePublicKeyB64: string,
    role: DeviceRole,
    scopes: readonly ScopeGrant[],
    grantBlob: string,
  ): Promise<CompletePairingResult> {
    return this.#control(async (tx) => {
      const { rows } = await tx.query<PairingRow>(
        `SELECT opener_pubkey, request_pubkey, grant_blob FROM ${SCHEMA}.pairing
         WHERE sid = $1 AND opener_pubkey = $2 AND expires_at > $3
           AND request_pubkey IS NOT NULL AND grant_blob IS NULL AND ${ACTIVE_OWNER("$2")}`,
        [sid, openerPublicKeyB64, this.#now()],
      );
      const session = rows[0];
      if (session === undefined) {
        return "not_found";
      }
      if (session.request_pubkey !== devicePublicKeyB64) {
        return "device_mismatch";
      }
      const existing = await this.#device(tx, devicePublicKeyB64);
      if (existing?.status === "active" && existing.role !== role) {
        return "role_conflict";
      }
      const result = await this.#checkGrant(tx, existing ?? { role, status: "active" }, scopes);
      if (result !== "ok") {
        return result;
      }
      await tx.query(
        `INSERT INTO ${SCHEMA}.devices (device_pubkey, role) VALUES ($1, $2)
         ON CONFLICT (device_pubkey) DO NOTHING`,
        [devicePublicKeyB64, role],
      );
      await this.#writeGrant(tx, devicePublicKeyB64, scopes);
      const stored = await tx.query(
        `UPDATE ${SCHEMA}.pairing SET grant_blob = $2 WHERE sid = $1 RETURNING sid`,
        [sid, grantBlob],
      );
      if (stored.rows.length !== 1) {
        // Unreachable while every pairing delete holds the control lock; if it
        // ever happens, roll the enrollment back rather than enroll without a grant.
        throw new Error("pairing session vanished during completePairing");
      }
      return "ok";
    });
  }

  /** Under the control lock, so a grant is never handed to a key a concurrent revoke just revoked. */
  takePairingGrant(sid: string, signerPublicKeyB64: string): Promise<string | undefined> {
    return this.#control(async (tx) => {
      const { rows } = await tx.query<{ grant_blob: string }>(
        `DELETE FROM ${SCHEMA}.pairing
         WHERE sid = $1 AND request_pubkey = $2 AND grant_blob IS NOT NULL AND expires_at > $3
           AND EXISTS (SELECT 1 FROM ${SCHEMA}.devices
                       WHERE device_pubkey = $2 AND status = 'active')
         RETURNING grant_blob`,
        [sid, signerPublicKeyB64, this.#now()],
      );
      return rows[0]?.grant_blob;
    });
  }

  async putRecoveryWrap(blob: string): Promise<void> {
    await this.#sql.query(
      `INSERT INTO ${SCHEMA}.recovery_wrap (blob) VALUES ($1)
       ON CONFLICT (id) DO UPDATE SET blob = EXCLUDED.blob`,
      [blob],
    );
  }

  async getRecoveryWrap(): Promise<string | undefined> {
    const { rows } = await this.#sql.query<{ blob: string }>(
      `SELECT blob FROM ${SCHEMA}.recovery_wrap`,
    );
    return rows[0]?.blob;
  }

  /** Under the control lock, so a sweep never deletes a session mid-completePairing. */
  async sweepExpired(): Promise<void> {
    await this.#control((tx) =>
      tx.query(
        `WITH p AS (DELETE FROM ${SCHEMA}.pairing WHERE expires_at <= $1)
         DELETE FROM ${SCHEMA}.owner_codes WHERE expires_at <= $1 AND NOT used`,
        [this.#now()],
      ),
    );
  }
}
