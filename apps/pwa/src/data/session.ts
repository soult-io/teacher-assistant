// Bootstrap — the U1 data flow (ui-build-spec §1) plus the U6 para-device DOC/KEY
// boundary (architecture/para-doc-topology.md, D1–D4). The confidentiality boundary
// is KEY POSSESSION, not a UI filter:
//
//  - The TEACHER session unlocks a TeacherKeyring (MK) and mints + holds the Period
//    DEK, and drives TWO encrypted streams: `master` (MK scope — full goals/goal_text,
//    all periods, validated points, trend/history/exports) and `{period}/para-visible`
//    (Period-DEK scope — the published roster/administer slice + para pending points +
//    tombstones). It PUBLISHES the para-visible projection into the para stream (D2)
//    and, on validation, writes the record → master FIRST, then the tombstone → para
//    (D3, master-first ordering; the queue is derived from master truth).
//  - The PARA session unlocks a ParaKeyring holding ONLY the Period DEK and opens ONLY
//    the para stream. It is cryptographically incapable of decrypting master (a
//    ParaKeyring on the master scope throws NoKeyForScopeError) — so a curious/compromised
//    para device reads EXACTLY the one para-visible doc, never goal_text/criterion/other
//    periods/validated/trend (D4 security invariant).
//
// FERPA: student data is decrypted only IN MEMORY; each stream reaches disk solely as
// its own ciphertext under its own scope key, a separate docId/persistence entry
// (hard-stop #10/#11, C-1). The synthetic MK/Period DEK are generated per session; U6
// proves the boundary + the two-doc validate flow on synthetic data. Two-DEVICE relay
// sync is the go-live follow-on (D4); in-process the two streams share a
// PersistenceAdapter and the teacher integrates the para snapshot as ciphertext.

import {
  approveDeviceEnrollment,
  approveParaEnrollment,
  createEnrollmentRequest,
  type DeviceKeypair,
  generateDeviceKeypair,
  generateMasterKey,
  generatePeriodKey,
  generateSigningKeypair,
  type ParaEnrollmentGrant,
  sodiumReady,
  TeacherKeyring,
} from "@teacher-assistant/crypto";
import { unlockParaKeyring, unlockTeacherKeyring } from "@teacher-assistant/auth";
import { applyEdit, type EditableFields, validateParaPoint } from "@teacher-assistant/domain-core";
import { newOpaqueId, newScopeTag } from "@teacher-assistant/schema";
import type { OpaqueId, ProgressDataPoint, Timestamp } from "@teacher-assistant/schema";
import {
  EncryptedStream,
  fetchTransport,
  InMemoryPersistence,
  type PersistenceAdapter,
  RelayClient,
  SyncEngine,
} from "@teacher-assistant/sync";
import { IndexedDbPersistence } from "./indexeddb-persistence.js";
import type { PasskeyGateway } from "./passkey.js";
import { SyntheticPasskeyGateway } from "./passkey.js";
import type { Doc as YDoc } from "yjs";
import {
  type DecryptedRecords,
  isEmpty,
  type ParaDocRecords,
  readParaVisible,
  readRecords,
  setParaTombstone,
  upsertParaPending,
  upsertPoint,
  writeParaVisibleProjection,
  writeRecords,
} from "./repository.js";
import { deriveParaQueue, paraPeriodId, publishParaVisible } from "./para-publish.js";
import { buildSyntheticSeed, type SyntheticSeed } from "./synthetic-seed.js";

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
  /** Material to enter the in-process para-device session (wrapped Period DEK only). */
  readonly paraHandoff: ParaHandoff;
  /** Best-effort reconcile with the relay (offline-first: false when unreachable). */
  sync(): Promise<boolean>;
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
}

export interface BootstrapOptions {
  readonly gateway?: PasskeyGateway;
  /** Relay base URL for the sync client. Default "" → same-origin "/sync/…". */
  readonly relayBaseUrl?: string;
  /** Ciphertext persistence. Defaults to IndexedDB, falling back to in-memory (both ciphertext-only). */
  readonly persistence?: PersistenceAdapter;
  /** Injectable clock for the synthetic seed's admin dates (tests pin it). */
  readonly now?: Date;
}

/** Ciphertext-only at-rest store: IndexedDB when available, else in-memory — never plaintext. */
function defaultPersistence(): PersistenceAdapter {
  try {
    return new IndexedDbPersistence();
  } catch {
    return new InMemoryPersistence();
  }
}

function relayFor(baseUrl: string): RelayClient {
  return new RelayClient({
    transport: fetchTransport(baseUrl),
    signingKeypair: generateSigningKeypair(),
  });
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

/**
 * Synthesize a teacher keyring for the offline synthetic session: mint a master key,
 * enroll THIS device against it, then unlock through the real M0-AUTH gate. Exercises
 * the enrollment + key-unwrap crypto for real on a synthetic MK.
 */
async function synthesizeTeacherKeyring(gateway: PasskeyGateway): Promise<TeacherKeyring> {
  const deviceKeypair = generateDeviceKeypair();
  const masterScopeTag = newScopeTag();
  const issuing = new TeacherKeyring(masterScopeTag, generateMasterKey());
  const { request, verificationCode } = createEnrollmentRequest(deviceKeypair);
  const grant = approveDeviceEnrollment(issuing, request, verificationCode);
  const authentication = await gateway.authenticate();
  return unlockTeacherKeyring({ authentication, deviceKeypair, grant });
}

/** Load an engine's persisted ciphertext (snapshot + backlog) if any exists. */
async function loadEngine(engine: SyncEngine): Promise<void> {
  await engine.load();
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

/** Seed the master caseload into the master stream on first run (ciphertext). */
async function seedMaster(
  engine: SyncEngine,
  stream: EncryptedStream,
  seed: SyntheticSeed,
): Promise<void> {
  if (isEmpty(stream.doc)) {
    await engine.capture((doc) => writeRecords(doc, seed.master));
  }
}

/** Run the full unlock → two-stream bootstrap → decrypt → publish pipeline for a teacher session. */
export async function bootstrapTeacherSession(options: BootstrapOptions = {}): Promise<Session> {
  await sodiumReady();
  const gateway = options.gateway ?? new SyntheticPasskeyGateway();
  const persistence = options.persistence ?? defaultPersistence();
  const relayBaseUrl = options.relayBaseUrl ?? "";
  const now = options.now ?? new Date();
  const seed = buildSyntheticSeed(now);

  // Keys: MK (TeacherKeyring) + a minted Period DEK the teacher also holds.
  const keyring = await synthesizeTeacherKeyring(gateway);
  const periodKey = generatePeriodKey(newScopeTag());
  keyring.addPeriodKey(periodKey);

  // The two streams — distinct docIds → distinct ciphertext-at-rest entries (C-1).
  const masterDocId = newOpaqueId();
  const paraDocId = newOpaqueId();
  const masterStream = new EncryptedStream(masterDocId, keyring.masterScopeTag, keyring);
  const paraStream = new EncryptedStream(paraDocId, periodKey.scopeTag, keyring);
  const masterEngine = new SyncEngine(masterStream, relayFor(relayBaseUrl), persistence);
  const paraEngine = new SyncEngine(paraStream, relayFor(relayBaseUrl), persistence);

  await loadEngine(masterEngine);
  await loadEngine(paraEngine);
  await seedMaster(masterEngine, masterStream, seed);

  // Integrate any para-device captures held in shared persistence into the teacher's
  // para stream, WITHOUT touching the engine's own backlog (integrate is idempotent).
  const refreshPara = (): Promise<void> =>
    integrateParaSnapshot(persistence, paraDocId, paraStream);

  // Publish (materialize) the para-visible slice from master into the para stream (D2).
  // Deterministic + idempotent (the diff is a no-op when nothing changed), so it is
  // safe to run defensively after every teacher capture + on bootstrap.
  const republishPara = async (): Promise<void> => {
    const records = readRecords(masterStream.doc);
    const periodId = paraPeriodId(records);
    if (periodId === null) {
      return;
    }
    await refreshPara(); // never clobber a para-device write with a stale projection
    const projection = publishParaVisible(records, periodId);
    await paraEngine.capture((doc) => writeParaVisibleProjection(doc, projection));
  };

  // Seed the two synthetic para pending captures into the PARA doc (never master).
  await republishPara();
  if (readParaVisible(paraStream.doc).pending.length === 0) {
    for (const pending of seed.paraPending) {
      await paraEngine.capture((doc) => upsertParaPending(doc, pending));
    }
  }

  // A para-device write to the master stream — the confidentiality boundary — is by
  // key possession: the teacher holds both keys; the para handoff carries only the
  // Period DEK, wrapped to the para device.
  const paraDeviceKeypair = generateDeviceKeypair();
  const { request, verificationCode } = createEnrollmentRequest(paraDeviceKeypair);
  const grant = approveParaEnrollment(keyring, periodKey.scopeTag, request, verificationCode);

  const masterFirstThenTombstone = async (
    validated: ProgressDataPoint,
    dataPointId: OpaqueId,
    when: Timestamp,
  ): Promise<void> => {
    await masterEngine.capture((doc) => upsertPoint(doc, validated)); // 1. MASTER (system of record)
    await refreshPara();
    await paraEngine.capture((doc) => setParaTombstone(doc, dataPointId, when)); // 2. then para cleanup
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
      deriveParaQueue(
        readRecords(masterStream.doc).points,
        readParaVisible(paraStream.doc).pending,
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
    paraHandoff: {
      deviceKeypair: paraDeviceKeypair,
      grant,
      paraDocId,
      persistence,
      relayBaseUrl,
      gateway,
    },
    sync: async () => {
      // Reconcile BOTH streams best-effort + independently (offline-first): one stream's
      // relay failure must not skip the other, and degrades to offline rather than throw.
      const masterOk = await reconcile(masterEngine);
      const paraOk = await reconcile(paraEngine);
      return masterOk && paraOk;
    },
  };
}

/**
 * Enter the PARA-device session from the teacher handoff. Unlocks a ParaKeyring
 * holding ONLY the Period DEK and opens ONLY the para stream — it cannot decrypt the
 * master stream (NoKeyForScopeError). On a real para device the handoff arrives via
 * physical OOB-QR enrollment; in-process it is derived from the teacher session.
 */
export async function bootstrapParaSession(handoff: ParaHandoff): Promise<ParaSession> {
  await sodiumReady();
  const authentication = await handoff.gateway.authenticate();
  const paraKeyring = unlockParaKeyring({
    authentication,
    deviceKeypair: handoff.deviceKeypair,
    grant: handoff.grant,
  });
  const stream = new EncryptedStream(handoff.paraDocId, handoff.grant.scopeTag, paraKeyring);
  const engine = new SyncEngine(stream, relayFor(handoff.relayBaseUrl), handoff.persistence);
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
  };
}
