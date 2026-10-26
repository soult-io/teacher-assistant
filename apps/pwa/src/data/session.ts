// Bootstrap — the U1 data flow (ui-build-spec §1) plus the U6 para-device DOC/KEY
// boundary (architecture/para-doc-topology.md, D1–D4). The confidentiality boundary
// is KEY POSSESSION, not a UI filter:
//
//  - The TEACHER session opens from the unlocked device vault (device-enrollment-spec
//    rev 2.5 §3.4): the stored grant gives MK, the master scope tag and the master doc id;
//    the master doc's manifest (§3.3) gives the period DEKs (wrapped under MK) and the para
//    doc ids. Nothing is minted on unlock, so a reload reopens the SAME streams. It drives
//    TWO encrypted streams: `master` (MK scope — full goals/goal_text, all periods,
//    validated points, trend/history/exports) and `{period}/para-visible` (Period-DEK
//    scope — the published roster/administer slice + para pending points + tombstones).
//    It PUBLISHES the para-visible projection into the para stream (D2) and, on
//    validation, writes the record → master FIRST, then the tombstone → para (D3).
//  - The PARA session unlocks a ParaKeyring holding ONLY the Period DEK and opens ONLY
//    the para stream. It is cryptographically incapable of decrypting master (a
//    ParaKeyring on the master scope throws NoKeyForScopeError) — so a curious/compromised
//    para device reads EXACTLY the one para-visible doc, never goal_text/criterion/other
//    periods/validated/trend (D4 security invariant).
//
// FERPA: student data is decrypted only IN MEMORY; each stream reaches disk solely as
// its own ciphertext under its own scope key, a separate docId/persistence entry
// (hard-stop #10/#11, C-1). The synthetic caseload is written only at first setup on a
// QA/synthetic build (first-device.ts), never here. On such a build the teacher session
// also derives an in-process para device (a throwaway identity, QA only) for the role
// switch; a real para device pairs in EU-8.

import {
  approveParaEnrollment,
  completeDeviceEnrollment,
  createEnrollmentRequest,
  type DeviceEnrollmentGrant,
  type DeviceKeypair,
  fromBase64,
  generateDeviceKeypair,
  generateSigningKeypair,
  type ParaEnrollmentGrant,
  sodiumReady,
  TeacherKeyring,
  zeroize,
} from "@teacher-assistant/crypto";
import { unlockParaKeyring } from "@teacher-assistant/auth";
import { applyEdit, type EditableFields, validateParaPoint } from "@teacher-assistant/domain-core";
import type { OpaqueId, ProgressDataPoint, ScopeTag, Timestamp } from "@teacher-assistant/schema";
import {
  EncryptedStream,
  fetchTransport,
  InMemoryPersistence,
  keypairSigner,
  type PersistenceAdapter,
  RelayClient,
  type RequestSigner,
  SyncEngine,
  type Transport,
} from "@teacher-assistant/sync";
import { IndexedDbPersistence } from "./indexeddb-persistence.js";
import type { PasskeyGateway } from "./passkey.js";
import { SyntheticPasskeyGateway } from "./passkey.js";
import type { Doc as YDoc } from "yjs";
import { activeStream, readManifest } from "./manifest.js";
import {
  type DecryptedRecords,
  type ParaDocRecords,
  readParaVisible,
  readRecords,
  setParaTombstone,
  upsertPoint,
  writeParaVisibleProjection,
} from "./repository.js";
import { deriveParaQueue, paraPeriodId, publishParaVisible } from "./para-publish.js";

export type Role = "teacher" | "para";

/** A mutation over an encrypted stream's CRDT doc (persisted as ciphertext). */
export type DocMutator = (doc: YDoc) => void;

/**
 * The in-process material a teacher device hands to derive the para-device session.
 * It carries ONLY the para device's own keypair and the ParaEnrollmentGrant (the
 * Period DEK WRAPPED to that device) — never MK, never the TeacherKeyring, never the
 * master scope key. `unlockParaKeyring` can unwrap only the one Period DEK from it.
 */
export interface ParaHandoff {
  readonly deviceKeypair: DeviceKeypair;
  readonly grant: ParaEnrollmentGrant;
  readonly paraDocId: OpaqueId;
  readonly persistence: PersistenceAdapter;
  readonly relayBaseUrl: string;
  readonly gateway: PasskeyGateway;
}

/** The TEACHER session: master records + the two-doc para publication / validation surface. */
export interface Session {
  readonly role: "teacher";
  /** Decrypted, in-memory MASTER records the teacher projections read. */
  readonly records: DecryptedRecords;
  /** Apply a teacher write to the MASTER stream (M5 capture), then re-publish the para slice. */
  capture(mutator: DocMutator): Promise<void>;
  /** Re-read the decrypted master records after a capture(). */
  readRecords(): DecryptedRecords;
  /** Integrate any para-device captures (shared para ciphertext) into the teacher's para stream. */
  refreshPara(): Promise<void>;
  /** The validation queue: para pending points not yet validated in master (master-truth, ordered). */
  readParaQueue(): readonly ProgressDataPoint[];
  /** Validate a pending para point: validated record → master FIRST, tombstone → para (D3). */
  validatePara(pending: ProgressDataPoint, when: Timestamp): Promise<void>;
  /** Correct + validate a pending para point in one teacher action (the [Fix] flow). */
  validateParaWithEdit(
    pending: ProgressDataPoint,
    changes: EditableFields,
    when: Timestamp,
  ): Promise<void>;
  /**
   * Material to enter the in-process para-device session (wrapped Period DEK only).
   * Present only on a QA/synthetic build with a para stream; null otherwise.
   */
  readonly paraHandoff: ParaHandoff | null;
  /** Best-effort reconcile with the relay (offline-first: false when unreachable). */
  sync(): Promise<boolean>;
  /**
   * Lock (auto-lock or the Lock action): destroy the keyring (MK + period DEKs) and zeroize
   * every other private key this session made. Every later key use throws. Idempotent.
   * The caller also locks the para session and the device, then drops both sessions.
   */
  lock(): void;
}

/** The PARA-device session: opens ONLY the Period-DEK para stream (ParaKeyring). */
export interface ParaSession {
  readonly role: "para";
  /** The decrypted para-visible doc — roster/administer/settingPicklist + the para's own pending. */
  readonly paraRecords: ParaDocRecords;
  /** Capture a para pending write into the para doc (M13). Persisted as ciphertext under the Period DEK. */
  capturePara(mutator: DocMutator): Promise<void>;
  /** Integrate the latest para ciphertext (e.g. a teacher republish) before a re-read. */
  refreshRecords(): Promise<void>;
  /** Re-read the para-visible doc (after a capture, a refresh, or a teacher republish). */
  readParaRecords(): ParaDocRecords;
  sync(): Promise<boolean>;
  /** Lock: destroy the para keyring and zeroize this session's private keys. Idempotent. */
  lock(): void;
}

/**
 * What the unlocked device vault gives the teacher session (spec §3.1): the persistent
 * relay identity (it signs nothing once the device locks), the box keypair the grant is
 * sealed to, and the stored teacher grant.
 */
export interface TeacherVault {
  readonly signer: RequestSigner;
  readonly boxKeypair: DeviceKeypair;
  readonly grant: DeviceEnrollmentGrant;
}

export interface BootstrapOptions {
  /** The unlocked device: the relay identity, the box key and the stored grant. */
  readonly vault: TeacherVault;
  /** Relay base URL for the sync client. Default "" → same-origin "/sync/…". */
  readonly relayBaseUrl?: string;
  /** Relay transport; defaults to fetch against `relayBaseUrl` (tests inject the relay in process). */
  readonly transport?: Transport;
  /** Ciphertext persistence. Defaults to IndexedDB, falling back to in-memory (both ciphertext-only). */
  readonly persistence?: PersistenceAdapter;
  /** QA/synthetic build only: derive the in-process para device behind the role switch. */
  readonly inProcessPara?: boolean;
}

/** Ciphertext-only at-rest store: IndexedDB when available, else in-memory — never plaintext. */
export function defaultPersistence(): PersistenceAdapter {
  try {
    return new IndexedDbPersistence();
  } catch {
    return new InMemoryPersistence();
  }
}

function relayFor(baseUrl: string, signer: RequestSigner): RelayClient {
  return new RelayClient({ transport: fetchTransport(baseUrl), signer });
}

/** A per-session throwaway relay identity for the in-process para device. lock() zeroizes it. */
function throwawayIdentity(): { readonly signer: RequestSigner; readonly lock: () => void } {
  const keypair = generateSigningKeypair();
  return { signer: keypairSigner(keypair), lock: () => zeroize(keypair.privateKey) };
}

/**
 * An enrollment request for in-process key material. The request only needs the signing
 * PUBLIC key, so the throwaway signing private key is zeroized at once.
 */
function throwawayEnrollmentRequest(boxPublicKey: Uint8Array) {
  const signing = generateSigningKeypair();
  zeroize(signing.privateKey);
  return createEnrollmentRequest({ boxPublicKey, signingPublicKey: signing.publicKey });
}

/**
 * Integrate the para doc's persisted ciphertext snapshot (shared in-process by both
 * sessions) into `stream`. Idempotent — a no-op when nothing is persisted yet — so it
 * is safe to call defensively before a publish/capture. Shared by both the teacher's
 * refreshPara and the para session's refresh (they differ only in stream + docId).
 */
async function integrateParaSnapshot(
  persistence: PersistenceAdapter,
  paraDocId: OpaqueId,
  stream: EncryptedStream,
): Promise<void> {
  const st = await persistence.load(paraDocId);
  if (st?.snapshot !== undefined) {
    stream.integrateRemote(st.snapshot);
  }
}

/** The teacher keyring from the stored grant: MK, under the grant's master scope tag. */
export function teacherKeyringFromGrant(
  boxKeypair: DeviceKeypair,
  grant: DeviceEnrollmentGrant,
): TeacherKeyring {
  const { mk, masterScopeTag } = completeDeviceEnrollment(boxKeypair, grant);
  return new TeacherKeyring(masterScopeTag, mk);
}

/** One stream + its engine, with its persisted ciphertext (snapshot + backlog) loaded. */
export async function openStream(
  docId: OpaqueId,
  scopeTag: ScopeTag,
  keyring: TeacherKeyring,
  relay: RelayClient,
  persistence: PersistenceAdapter,
): Promise<{ readonly stream: EncryptedStream; readonly engine: SyncEngine }> {
  const stream = new EncryptedStream(docId, scopeTag, keyring);
  const engine = new SyncEngine(stream, relay, persistence);
  await engine.load();
  return { stream, engine };
}

/** Add every manifest period DEK (wrapped under MK) to the keyring. */
function addPeriodKeys(keyring: TeacherKeyring, masterDoc: YDoc): void {
  for (const [scopeTag, wrapped] of readManifest(masterDoc).periodKeys) {
    keyring.addWrappedPeriodKey(scopeTag, fromBase64(wrapped));
  }
}

/**
 * Best-effort reconcile of ONE stream's engine with the relay. Offline-first: any relay
 * failure — unreachable, OR the relay reached but erroring/404-ing an un-enrolled device
 * (H-PUB-3) — degrades to local-only and resolves `false`; it NEVER throws. So the
 * bootstrap-time reconcile can never block unlock or surface as a passkey failure, and a
 * failure on one stream never skips the other.
 */
async function reconcile(engine: SyncEngine): Promise<boolean> {
  try {
    await engine.sync();
    return true;
  } catch {
    return false;
  }
}

/**
 * The in-process para device (QA/synthetic builds only): a throwaway box keypair and a
 * para grant carrying ONLY the period DEK, wrapped to it.
 */
function inProcessParaDevice(
  keyring: TeacherKeyring,
  periodScopeTag: ScopeTag,
  paraDocId: OpaqueId,
): { readonly deviceKeypair: DeviceKeypair; readonly grant: ParaEnrollmentGrant } {
  const deviceKeypair = generateDeviceKeypair();
  const { request, verificationCode } = throwawayEnrollmentRequest(deviceKeypair.publicKey);
  const grant = approveParaEnrollment(
    keyring,
    periodScopeTag,
    request,
    verificationCode,
    paraDocId,
  );
  return { deviceKeypair, grant };
}

/**
 * Open the teacher session from the unlocked device vault: the grant's master stream,
 * then the para stream and period keys from the master manifest. Nothing is minted and
 * nothing is seeded here. The keyring is destroyed if any step fails.
 */
export async function bootstrapTeacherSession(options: BootstrapOptions): Promise<Session> {
  await sodiumReady();
  const keyring = teacherKeyringFromGrant(options.vault.boxKeypair, options.vault.grant);
  try {
    return await openTeacherSession(keyring, options);
  } catch (err) {
    keyring.destroy(); // never leave MK behind a failed bootstrap
    throw err;
  }
}

async function openTeacherSession(
  keyring: TeacherKeyring,
  options: BootstrapOptions,
): Promise<Session> {
  const { vault } = options;
  const persistence = options.persistence ?? defaultPersistence();
  const relayBaseUrl = options.relayBaseUrl ?? "";
  // Both streams sign with the device identity, so the relay sees one device across reloads.
  const relay = new RelayClient({
    transport: options.transport ?? fetchTransport(relayBaseUrl),
    signer: vault.signer,
  });

  const master = await openStream(
    vault.grant.masterDocId,
    keyring.masterScopeTag,
    keyring,
    relay,
    persistence,
  );
  const masterStream = master.stream;
  const masterEngine = master.engine;
  addPeriodKeys(keyring, masterStream.doc);
  const active = activeStream(readManifest(masterStream.doc));
  const para =
    active === null
      ? null
      : await openStream(active.entry.paraDocId, active.scopeTag, keyring, relay, persistence);

  // Integrate any para-device captures held in shared persistence into the teacher's
  // para stream, WITHOUT touching the engine's own backlog (integrate is idempotent).
  const refreshPara = async (): Promise<void> => {
    if (para !== null && active !== null) {
      await integrateParaSnapshot(persistence, active.entry.paraDocId, para.stream);
    }
  };

  // Publish (materialize) the para-visible slice from master into the para stream (D2).
  // Deterministic + idempotent (the diff is a no-op when nothing changed), so it is
  // safe to run defensively after every teacher capture + on bootstrap.
  const republishPara = async (): Promise<void> => {
    const records = readRecords(masterStream.doc);
    const periodId = paraPeriodId(records);
    if (para === null || periodId === null) {
      return;
    }
    await refreshPara(); // never clobber a para-device write with a stale projection
    const projection = publishParaVisible(records, periodId);
    await para.engine.capture((doc) => writeParaVisibleProjection(doc, projection));
  };
  await republishPara();

  // A para-device write to the master stream — the confidentiality boundary — is by
  // key possession: the teacher holds both keys; the para handoff carries only the
  // Period DEK, wrapped to the para device.
  const paraDevice =
    options.inProcessPara === true && active !== null
      ? inProcessParaDevice(keyring, active.scopeTag, active.entry.paraDocId)
      : null;

  const masterFirstThenTombstone = async (
    validated: ProgressDataPoint,
    dataPointId: OpaqueId,
    when: Timestamp,
  ): Promise<void> => {
    if (para === null) {
      throw new Error("this device has no para stream");
    }
    await masterEngine.capture((doc) => upsertPoint(doc, validated)); // 1. MASTER (system of record)
    await refreshPara();
    await para.engine.capture((doc) => setParaTombstone(doc, dataPointId, when)); // 2. then para cleanup
  };

  return {
    role: "teacher",
    records: readRecords(masterStream.doc),
    capture: async (mutator) => {
      await masterEngine.capture(mutator);
      await republishPara();
    },
    readRecords: () => readRecords(masterStream.doc),
    refreshPara,
    readParaQueue: () =>
      para === null
        ? []
        : deriveParaQueue(
            readRecords(masterStream.doc).points,
            readParaVisible(para.stream.doc).pending,
          ),
    validatePara: async (pending, when) => {
      const { validated } = validateParaPoint(pending, { who: "teacher", when });
      await masterFirstThenTombstone(validated, pending.data_point_id, when);
    },
    validateParaWithEdit: async (pending, changes, when) => {
      const corrected = applyEdit(pending, changes, "teacher", when);
      const { validated } = validateParaPoint(corrected, { who: "teacher", when });
      await masterFirstThenTombstone(validated, pending.data_point_id, when);
    },
    paraHandoff:
      paraDevice === null || active === null
        ? null
        : {
            deviceKeypair: paraDevice.deviceKeypair,
            grant: paraDevice.grant,
            paraDocId: active.entry.paraDocId,
            persistence,
            relayBaseUrl,
            gateway: new SyntheticPasskeyGateway(),
          },
    sync: async () => {
      // Reconcile BOTH streams best-effort + independently (offline-first): one stream's
      // relay failure must not skip the other, and degrades to offline rather than throw.
      const masterOk = await reconcile(masterEngine);
      const paraOk = para === null ? true : await reconcile(para.engine);
      return masterOk && paraOk;
    },
    lock: () => {
      keyring.destroy(); // MK + every period DEK, zeroized in place
      if (paraDevice !== null) {
        zeroize(paraDevice.deviceKeypair.privateKey); // the in-process para device's box key
      }
    },
  };
}

/**
 * Enter the PARA-device session from the teacher handoff. Unlocks a ParaKeyring
 * holding ONLY the Period DEK and opens ONLY the para stream — it cannot decrypt the
 * master stream (NoKeyForScopeError). On a real para device the handoff arrives via
 * physical OOB-QR enrollment (EU-8); in-process (QA builds) it is derived from the
 * teacher session.
 */
export async function bootstrapParaSession(handoff: ParaHandoff): Promise<ParaSession> {
  await sodiumReady();
  const authentication = await handoff.gateway.authenticate();
  const paraKeyring = unlockParaKeyring({
    authentication,
    deviceKeypair: handoff.deviceKeypair,
    grant: handoff.grant,
  });
  // The in-process para device has no vault of its own (EU-8 pairs a real one).
  const identity = throwawayIdentity();
  const stream = new EncryptedStream(handoff.paraDocId, handoff.grant.scopeTag, paraKeyring);
  const engine = new SyncEngine(
    stream,
    relayFor(handoff.relayBaseUrl, identity.signer),
    handoff.persistence,
  );
  await engine.load(); // rebuild from the teacher-published para ciphertext

  const refresh = (): Promise<void> =>
    integrateParaSnapshot(handoff.persistence, handoff.paraDocId, stream);
  await refresh();

  return {
    role: "para",
    paraRecords: readParaVisible(stream.doc),
    capturePara: async (mutator) => {
      await refresh(); // pick up any teacher republish before writing
      await engine.capture(mutator);
    },
    refreshRecords: refresh,
    readParaRecords: () => readParaVisible(stream.doc),
    sync: () => reconcile(engine), // best-effort, offline-first (never throws)
    lock: () => {
      paraKeyring.destroy();
      zeroize(handoff.deviceKeypair.privateKey);
      identity.lock();
    },
  };
}
