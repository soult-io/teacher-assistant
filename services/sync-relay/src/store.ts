// The relay's append-only encrypted-update store + per-opaque-id ACL
// (architecture §1.5), plus the device-enrollment control plane (device
// enrollment spec §5.1–5.2: devices, scope kinds, owner codes, pairing
// mailbox, recovery wrap). It holds ONLY opaque ids, opaque scope tags, device
// signing public keys, base64 ciphertext/sealed blobs, sequence numbers, a
// random per-doc epoch (carries no information), fixed role/status/kind words,
// owner-code hashes and operator/pairing expiry times — never plaintext, never
// a student-identifying field, never a student or activity timestamp. It
// cannot decrypt anything it stores.
//
// Two implementations of one contract (store.contract.test.ts runs against both):
//   - InMemoryRelayStore (this file) — tests and local development only.
//   - PostgresRelayStore (postgres-store.ts) — the durable deploy backing.
// The choice is made at startup from configuration (config.ts); it does not
// change the wire protocol or the authorization logic.

import { randomUUID } from "node:crypto";

export interface FetchResult {
  readonly cursor: string;
  readonly updates: string[];
}

/**
 * A client cursor, parsed. On the wire it is the opaque string
 * `<epoch>.<seq>`: `seq` is the last sequence number the client has, and
 * `epoch` is a random id minted when the doc row is created. Restoring the
 * relay from a backup re-mints every doc's epoch (see migrations.ts), so a
 * cursor from before the restore no longer matches and the client is served
 * from 0 — sequence numbers are reused after a restore, so `seq` alone cannot
 * tell an old history from the current one.
 */
export interface Cursor {
  readonly epoch: string | undefined;
  readonly seq: number;
}

const START: Cursor = { epoch: undefined, seq: 0 };
const MAX_CURSOR_LENGTH = 128;

/** A relay-minted epoch is a UUID; accept only that alphabet from a client. */
const EPOCH = /^[0-9A-Za-z-]{1,64}$/;

/** Parse `?since=`. Anything that is not `<epoch>.<non-negative int>` is "from the start". */
export function parseCursor(raw: string | undefined): Cursor {
  if (raw === undefined || raw.length > MAX_CURSOR_LENGTH) {
    return START;
  }
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) {
    return START;
  }
  const epoch = raw.slice(0, dot);
  const digits = raw.slice(dot + 1);
  const seq = Number(digits);
  // The epoch alphabet check also keeps a NUL or other odd text away from the database.
  return EPOCH.test(epoch) && /^\d+$/.test(digits) && Number.isSafeInteger(seq)
    ? { epoch, seq }
    : START;
}

export function formatCursor(epoch: string, seq: number | string): string {
  return `${epoch}.${seq}`;
}

/** Mint a doc epoch (random; carries no information). */
export function newEpoch(): string {
  return randomUUID();
}

/** A device's role. `owner` = a teacher device (owner routes); `member` = a para device. */
export type DeviceRole = "owner" | "member";
/** `revoked` is permanent: a revoked key is never re-admitted (spec §5.4). */
export type DeviceStatus = "active" | "revoked";
/** `master` = the teacher's single master stream; `period` = one class period. */
export type ScopeKind = "master" | "period";

export interface ScopeGrant {
  readonly tag: string;
  readonly kind: ScopeKind;
}

export interface DeviceListing {
  readonly device: string;
  readonly role: DeviceRole;
  readonly status: DeviceStatus;
  readonly scopes: readonly {
    readonly tag: string;
    readonly kind: ScopeKind;
    readonly retired: boolean;
  }[];
}

/** `first` = the deployment's first owner (F1); `recovery` = an owner already exists or did (F5). */
export type RedeemResult = "first" | "recovery" | "refused";
export type GrantResult =
  | "ok"
  | "kind_conflict"
  | "member_master"
  | "second_master"
  | "not_active"
  | "retired";
export type RetireResult = "ok" | "master_scope" | "not_found";
export type RevokeResult = "ok" | "last_owner";
/**
 * `not_found`: no open session matches (unknown, expired, wrong opener, no request yet,
 * already granted, or the opener is no longer an active owner). `device_mismatch`: the
 * grant names a device other than the request signer. `role_conflict`: the device is
 * already enrolled with the other role.
 */
export type CompletePairingResult = GrantResult | "not_found" | "device_mismatch" | "role_conflict";

/** A pairing session lives this long from open (spec §5.5). */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** At most this many unexpired pairing sessions per deployment (spec §5.3). */
export const MAX_OPEN_PAIRINGS = 3;

export interface StoreOptions {
  /** The clock for code and pairing expiry; tests inject one. */
  readonly now?: () => Date;
}

interface KnownScope {
  readonly kind: ScopeKind;
  readonly retired: boolean;
}

/** One requested scope against what is registered so far (see checkGrant). */
function checkScope(
  role: DeviceRole,
  { kind }: ScopeGrant,
  existing: KnownScope | undefined,
  masterTag: string | undefined,
): GrantResult {
  if (existing !== undefined && existing.kind !== kind) {
    return "kind_conflict";
  }
  if (existing?.retired === true) {
    return "retired";
  }
  if (kind === "master" && role === "member") {
    return "member_master";
  }
  if (kind === "master" && existing === undefined && masterTag !== undefined) {
    return "second_master";
  }
  return "ok";
}

/**
 * The scope-kind invariants (spec §5.3), shared by both stores so they cannot
 * drift. `device` is the grantee's current row (undefined = not enrolled);
 * `known` holds every requested tag already registered; `masterTag` is the
 * registered master tag, if any. Requests are checked in order, as if each were
 * registered before the next, so one request cannot carry two masters or one
 * tag under two kinds.
 */
export function checkGrant(
  device: { readonly role: DeviceRole; readonly status: DeviceStatus } | undefined,
  requested: readonly ScopeGrant[],
  known: ReadonlyMap<string, KnownScope>,
  masterTag: string | undefined,
): GrantResult {
  if (device?.status !== "active") {
    return "not_active";
  }
  const seen = new Map(known);
  let master = masterTag;
  for (const scope of requested) {
    const result = checkScope(device.role, scope, seen.get(scope.tag), master);
    if (result !== "ok") {
      return result;
    }
    if (scope.kind === "master") {
      master = scope.tag;
    }
    seen.set(scope.tag, { kind: scope.kind, retired: false });
  }
  return "ok";
}

/**
 * The pre-grant checks of completePairing (spec §5.3), shared so the stores
 * cannot drift. Returns the refusal, or the device row to pass to checkGrant.
 */
export function checkEnrollment(
  requestSigner: string,
  device: string,
  existing: { readonly role: DeviceRole; readonly status: DeviceStatus } | undefined,
  role: DeviceRole,
):
  | "device_mismatch"
  | "role_conflict"
  | { readonly role: DeviceRole; readonly status: DeviceStatus } {
  if (requestSigner !== device) {
    return "device_mismatch";
  }
  if (existing?.status === "active" && existing.role !== role) {
    return "role_conflict";
  }
  return existing ?? { role, status: "active" };
}

export interface RelayStore {
  /** Whether an ACTIVE device (by signing pubkey) may access a scope. */
  isAuthorized(devicePublicKeyB64: string, scopeTag: string): Promise<boolean>;
  /** The scope a doc is bound to, or undefined if the doc is unknown. */
  docScope(docId: string): Promise<string | undefined>;
  /**
   * Atomically append ciphertext updates; binds docId→scope (and mints the doc's
   * epoch) on first write. Returns the new cursor, or undefined (nothing written) when the doc is
   * already bound to a DIFFERENT scope, or the scope is retired (read-only) — the
   * check and the write are one step, so two concurrent first writers under
   * different scopes cannot both land.
   */
  append(docId: string, scopeTag: string, blobsB64: readonly string[]): Promise<string | undefined>;
  /**
   * Fetch updates after `since`. The returned cursor is `<epoch>.<head>`, read in
   * the same snapshot as the updates; an unknown doc returns cursor "0" and no
   * updates. `since` is honoured only if its epoch is the doc's AND its seq is
   * not past the head; otherwise (a cursor from before a restore, a legacy or
   * malformed cursor) every update is returned, so the client re-applies them
   * (idempotent for CRDT updates) instead of silently skipping any.
   * (Pagination, when it lands, will make the cursor "last seq returned"; do not
   * rely on cursor == head elsewhere.)
   */
  fetch(docId: string, since: Cursor): Promise<FetchResult>;

  // ── Enrollment control plane (device-enrollment spec §5.2). Production code
  // adds ACL rows ONLY through grantScopes and completePairing. ──

  /** Register an operator owner code by its hex SHA-256 (the CLI only). */
  issueOwnerCode(codeSha256: string, expiresAt: Date): Promise<void>;
  /**
   * Single-use: an unused, unexpired code is marked used and the device becomes
   * an active owner. `first` only when there is no active owner and no master
   * scope. A revoked key is refused and the code is left unused.
   */
  redeemOwnerCode(codeSha256: string, devicePublicKeyB64: string): Promise<RedeemResult>;
  /** The role of an ACTIVE device; undefined for an unknown or revoked one. */
  deviceRole(devicePublicKeyB64: string): Promise<DeviceRole | undefined>;
  /** Grant an active device scopes, all or nothing, under the scope-kind invariants. */
  grantScopes(devicePublicKeyB64: string, scopes: readonly ScopeGrant[]): Promise<GrantResult>;
  /** Make a period scope read-only. The master scope is never retired (N3). */
  retireScope(scopeTag: string): Promise<RetireResult>;
  /**
   * Revoke permanently and drop the device's ACL rows and pairing sessions.
   * Idempotent (an unknown or revoked key is `ok`); refuses the last active owner.
   */
  revoke(devicePublicKeyB64: string): Promise<RevokeResult>;
  /** Every device with its scopes, ordered by device then tag. */
  listDevices(): Promise<DeviceListing[]>;

  /** Open a session; false if `sid` is taken, the limit is reached, or the opener is not an active owner. */
  openPairing(sid: string, openerPublicKeyB64: string): Promise<boolean>;
  /** First write wins; false if unknown, expired, taken, or the signer is the opener or revoked. */
  putPairingRequest(sid: string, signerPublicKeyB64: string, blob: string): Promise<boolean>;
  /** The request blob, for the opener only, before the grant is put. */
  getPairingRequest(sid: string, openerPublicKeyB64: string): Promise<string | undefined>;
  /** Enroll the request signer with `role` and `scopes`, and store the grant blob — one step. */
  completePairing(
    sid: string,
    openerPublicKeyB64: string,
    devicePublicKeyB64: string,
    role: DeviceRole,
    scopes: readonly ScopeGrant[],
    grantBlob: string,
  ): Promise<CompletePairingResult>;
  /** The grant blob, for the (still active) request signer only; the session is deleted. */
  takePairingGrant(sid: string, signerPublicKeyB64: string): Promise<string | undefined>;

  putRecoveryWrap(blob: string): Promise<void>;
  getRecoveryWrap(): Promise<string | undefined>;

  /** Delete expired pairing sessions and expired unused owner codes. */
  sweepExpired(): Promise<void>;
}

interface StoredUpdate {
  readonly seq: number;
  readonly blobB64: string;
}

interface StoredDoc {
  readonly scopeTag: string;
  readonly epoch: string;
  readonly updates: StoredUpdate[];
}

interface StoredDevice {
  role: DeviceRole;
  status: DeviceStatus;
}

interface StoredScope {
  readonly kind: ScopeKind;
  retired: boolean;
}

interface StoredCode {
  readonly expiresAt: number;
  used: boolean;
}

interface StoredPairing {
  readonly opener: string;
  readonly expiresAt: number;
  request?: { readonly signer: string; readonly blob: string };
  grantBlob?: string;
}

/**
 * Every method body runs without an await between its checks and its writes,
 * so each is atomic on the single JS thread — the in-memory analogue of the
 * Postgres store's one transaction per control operation.
 */
export class InMemoryRelayStore implements RelayStore {
  readonly #docs = new Map<string, StoredDoc>();
  readonly #acl = new Map<string, Set<string>>();
  readonly #devices = new Map<string, StoredDevice>();
  readonly #scopes = new Map<string, StoredScope>();
  readonly #codes = new Map<string, StoredCode>();
  readonly #pairings = new Map<string, StoredPairing>();
  #recoveryWrap: string | undefined;
  readonly #now: () => Date;

  constructor(options: StoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  #nowMs(): number {
    return this.#now().getTime();
  }

  #activeRole(pubkey: string): DeviceRole | undefined {
    const d = this.#devices.get(pubkey);
    return d?.status === "active" ? d.role : undefined;
  }

  #activeOwnerCount(): number {
    return [...this.#devices.values()].filter((d) => d.role === "owner" && d.status === "active")
      .length;
  }

  #masterTag(): string | undefined {
    for (const [tag, scope] of this.#scopes) {
      if (scope.kind === "master") {
        return tag;
      }
    }
    return undefined;
  }

  #openPairing(sid: string): StoredPairing | undefined {
    const p = this.#pairings.get(sid);
    return p !== undefined && p.expiresAt > this.#nowMs() ? p : undefined;
  }

  #checkGrant(device: StoredDevice | undefined, scopes: readonly ScopeGrant[]): GrantResult {
    return checkGrant(device, scopes, this.#scopes, this.#masterTag());
  }

  #writeGrant(pubkey: string, scopes: readonly ScopeGrant[]): void {
    const acl = this.#acl.get(pubkey) ?? new Set<string>();
    for (const { tag, kind } of scopes) {
      if (!this.#scopes.has(tag)) {
        this.#scopes.set(tag, { kind, retired: false });
      }
      acl.add(tag);
    }
    this.#acl.set(pubkey, acl);
  }

  async isAuthorized(devicePublicKeyB64: string, scopeTag: string): Promise<boolean> {
    return (
      this.#activeRole(devicePublicKeyB64) !== undefined &&
      (this.#acl.get(devicePublicKeyB64)?.has(scopeTag) ?? false)
    );
  }

  async docScope(docId: string): Promise<string | undefined> {
    return this.#docs.get(docId)?.scopeTag;
  }

  async append(
    docId: string,
    scopeTag: string,
    blobsB64: readonly string[],
  ): Promise<string | undefined> {
    if (this.#scopes.get(scopeTag)?.retired === true) {
      return undefined;
    }
    let doc = this.#docs.get(docId);
    if (doc === undefined) {
      doc = { scopeTag, epoch: newEpoch(), updates: [] };
      this.#docs.set(docId, doc);
    } else if (doc.scopeTag !== scopeTag) {
      return undefined;
    }
    for (const blobB64 of blobsB64) {
      doc.updates.push({ seq: doc.updates.length + 1, blobB64 });
    }
    return formatCursor(doc.epoch, doc.updates.length);
  }

  async fetch(docId: string, since: Cursor): Promise<FetchResult> {
    const doc = this.#docs.get(docId);
    if (doc === undefined) {
      return { cursor: "0", updates: [] };
    }
    const head = doc.updates.length;
    const from = since.epoch === doc.epoch && since.seq <= head ? since.seq : 0;
    const updates = doc.updates.filter((u) => u.seq > from).map((u) => u.blobB64);
    return { cursor: formatCursor(doc.epoch, head), updates };
  }

  async issueOwnerCode(codeSha256: string, expiresAt: Date): Promise<void> {
    if (this.#codes.has(codeSha256)) {
      throw new Error("owner code already issued");
    }
    this.#codes.set(codeSha256, { expiresAt: expiresAt.getTime(), used: false });
  }

  async redeemOwnerCode(codeSha256: string, devicePublicKeyB64: string): Promise<RedeemResult> {
    const code = this.#codes.get(codeSha256);
    if (code === undefined || code.used || code.expiresAt <= this.#nowMs()) {
      return "refused";
    }
    const device = this.#devices.get(devicePublicKeyB64);
    if (device?.status === "revoked") {
      return "refused";
    }
    const mode =
      this.#activeOwnerCount() === 0 && this.#masterTag() === undefined ? "first" : "recovery";
    code.used = true;
    this.#devices.set(devicePublicKeyB64, { role: "owner", status: "active" });
    return mode;
  }

  async deviceRole(devicePublicKeyB64: string): Promise<DeviceRole | undefined> {
    return this.#activeRole(devicePublicKeyB64);
  }

  async grantScopes(
    devicePublicKeyB64: string,
    scopes: readonly ScopeGrant[],
  ): Promise<GrantResult> {
    const result = this.#checkGrant(this.#devices.get(devicePublicKeyB64), scopes);
    if (result === "ok") {
      this.#writeGrant(devicePublicKeyB64, scopes);
    }
    return result;
  }

  async retireScope(scopeTag: string): Promise<RetireResult> {
    const scope = this.#scopes.get(scopeTag);
    if (scope === undefined) {
      return "not_found";
    }
    if (scope.kind === "master") {
      return "master_scope";
    }
    scope.retired = true;
    return "ok";
  }

  async revoke(devicePublicKeyB64: string): Promise<RevokeResult> {
    const device = this.#devices.get(devicePublicKeyB64);
    if (device?.status !== "active") {
      return "ok";
    }
    if (device.role === "owner") {
      if (this.#activeOwnerCount() <= 1) {
        return "last_owner";
      }
    }
    device.status = "revoked";
    this.#acl.delete(devicePublicKeyB64);
    for (const [sid, p] of this.#pairings) {
      if (p.opener === devicePublicKeyB64 || p.request?.signer === devicePublicKeyB64) {
        this.#pairings.delete(sid);
      }
    }
    return "ok";
  }

  async listDevices(): Promise<DeviceListing[]> {
    // Code-unit order, the same as the Postgres store's COLLATE "C".
    return [...this.#devices.keys()].sort().map((device) => {
      const { role, status } = this.#devices.get(device) as StoredDevice;
      return {
        device,
        role,
        status,
        scopes: [...(this.#acl.get(device) ?? [])].sort().map((tag) => {
          const scope = this.#scopes.get(tag) as StoredScope;
          return { tag, kind: scope.kind, retired: scope.retired };
        }),
      };
    });
  }

  async openPairing(sid: string, openerPublicKeyB64: string): Promise<boolean> {
    const now = this.#nowMs();
    const open = [...this.#pairings.values()].filter((p) => p.expiresAt > now).length;
    if (
      this.#pairings.has(sid) ||
      open >= MAX_OPEN_PAIRINGS ||
      this.#activeRole(openerPublicKeyB64) !== "owner"
    ) {
      return false;
    }
    this.#pairings.set(sid, { opener: openerPublicKeyB64, expiresAt: now + PAIRING_TTL_MS });
    return true;
  }

  async putPairingRequest(sid: string, signerPublicKeyB64: string, blob: string): Promise<boolean> {
    const p = this.#openPairing(sid);
    if (
      p === undefined ||
      p.request !== undefined ||
      p.opener === signerPublicKeyB64 ||
      this.#devices.get(signerPublicKeyB64)?.status === "revoked"
    ) {
      return false;
    }
    p.request = { signer: signerPublicKeyB64, blob };
    return true;
  }

  async getPairingRequest(sid: string, openerPublicKeyB64: string): Promise<string | undefined> {
    const p = this.#openPairing(sid);
    if (
      p === undefined ||
      p.opener !== openerPublicKeyB64 ||
      p.grantBlob !== undefined ||
      this.#activeRole(openerPublicKeyB64) !== "owner"
    ) {
      return undefined;
    }
    return p.request?.blob;
  }

  async completePairing(
    sid: string,
    openerPublicKeyB64: string,
    devicePublicKeyB64: string,
    role: DeviceRole,
    scopes: readonly ScopeGrant[],
    grantBlob: string,
  ): Promise<CompletePairingResult> {
    const p = this.#openPairing(sid);
    if (
      p === undefined ||
      p.opener !== openerPublicKeyB64 ||
      p.request === undefined ||
      p.grantBlob !== undefined ||
      this.#activeRole(openerPublicKeyB64) !== "owner"
    ) {
      return "not_found";
    }
    const grantee = checkEnrollment(
      p.request.signer,
      devicePublicKeyB64,
      this.#devices.get(devicePublicKeyB64),
      role,
    );
    if (typeof grantee === "string") {
      return grantee;
    }
    const result = this.#checkGrant(grantee, scopes);
    if (result !== "ok") {
      return result;
    }
    this.#devices.set(devicePublicKeyB64, { role, status: "active" });
    this.#writeGrant(devicePublicKeyB64, scopes);
    p.grantBlob = grantBlob;
    return "ok";
  }

  async takePairingGrant(sid: string, signerPublicKeyB64: string): Promise<string | undefined> {
    const p = this.#openPairing(sid);
    if (
      p?.grantBlob === undefined ||
      p.request?.signer !== signerPublicKeyB64 ||
      this.#activeRole(signerPublicKeyB64) === undefined
    ) {
      return undefined;
    }
    this.#pairings.delete(sid);
    return p.grantBlob;
  }

  async putRecoveryWrap(blob: string): Promise<void> {
    this.#recoveryWrap = blob;
  }

  async getRecoveryWrap(): Promise<string | undefined> {
    return this.#recoveryWrap;
  }

  async sweepExpired(): Promise<void> {
    const now = this.#nowMs();
    for (const [sid, p] of this.#pairings) {
      if (p.expiresAt <= now) {
        this.#pairings.delete(sid);
      }
    }
    for (const [hash, code] of this.#codes) {
      if (!code.used && code.expiresAt <= now) {
        this.#codes.delete(hash);
      }
    }
  }

  /** Test hook: what a backup restore does to every doc (see migrations.ts). */
  rotateEpochs(): void {
    for (const [id, doc] of this.#docs) {
      this.#docs.set(id, { ...doc, epoch: newEpoch() });
    }
  }
}
