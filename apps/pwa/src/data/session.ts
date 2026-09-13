// Bootstrap — the U1 data flow (ui-build-spec §1): passkey auth (M0-AUTH) →
// unlock device-held keys (M0 keyring) → sync client (M1) → decrypt in memory →
// store/M3 projections. Offline-first: the app renders from the local encrypted
// store; it syncs with the relay when reachable, and never blocks render on it.
//
// FERPA: student data is decrypted only IN MEMORY (the returned records). It
// reaches disk exclusively as the stream's ciphertext via the PersistenceAdapter
// (hard-stop #10/#11). The synthetic MK/keyring are generated per session; U1
// does not persist key material, so cross-reload continuity (and live capture)
// arrive with the write units — U1 proves the read/render wiring end to end.

import {
  approveDeviceEnrollment,
  createEnrollmentRequest,
  generateDeviceKeypair,
  generateMasterKey,
  generateSigningKeypair,
  sodiumReady,
  TeacherKeyring,
} from "@teacher-assistant/crypto";
import { newOpaqueId, newScopeTag } from "@teacher-assistant/schema";
import {
  EncryptedStream,
  fetchTransport,
  InMemoryPersistence,
  type PersistenceAdapter,
  RelayClient,
  SyncEngine,
} from "@teacher-assistant/sync";
import { unlockTeacherKeyring } from "@teacher-assistant/auth";
import { IndexedDbPersistence } from "./indexeddb-persistence.js";
import type { PasskeyGateway } from "./passkey.js";
import { SyntheticPasskeyGateway } from "./passkey.js";
import { type DecryptedRecords, isEmpty, readRecords, writeRecords } from "./repository.js";
import { buildSyntheticSeed } from "./synthetic-seed.js";

export type Role = "teacher" | "para";

export interface Session {
  readonly role: Role;
  /** Decrypted, in-memory records the projections read. */
  readonly records: DecryptedRecords;
  /** Best-effort reconcile with the relay (offline-first: resolves false when unreachable). */
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

/**
 * Synthesize a teacher keyring for the offline synthetic session: mint a master
 * key, enroll THIS device against it, then unlock through the real M0-AUTH gate
 * (unlockTeacherKeyring refuses unless the passkey response is verified). This
 * exercises the enrollment + key-unwrap crypto for real on a synthetic MK.
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

/** Seed the synthetic caseload into the stream (persisted as ciphertext) on first run. */
async function seedIfEmpty(engine: SyncEngine, stream: EncryptedStream, now: Date): Promise<void> {
  await engine.load();
  if (isEmpty(stream.doc)) {
    const seed = buildSyntheticSeed(now);
    await engine.capture((doc) => writeRecords(doc, seed));
  }
}

/** Run the full unlock → sync-bootstrap → decrypt → project pipeline for a teacher session. */
export async function bootstrapTeacherSession(options: BootstrapOptions = {}): Promise<Session> {
  await sodiumReady();
  const gateway = options.gateway ?? new SyntheticPasskeyGateway();
  const persistence = options.persistence ?? defaultPersistence();
  const now = options.now ?? new Date();

  const keyring = await synthesizeTeacherKeyring(gateway);
  const stream = new EncryptedStream(newOpaqueId(), keyring.masterScopeTag, keyring);
  const relay = new RelayClient({
    transport: fetchTransport(options.relayBaseUrl ?? ""),
    signingKeypair: generateSigningKeypair(),
  });
  const engine = new SyncEngine(stream, relay, persistence);

  await seedIfEmpty(engine, stream, now);

  return {
    role: "teacher",
    records: readRecords(stream.doc),
    sync: async () => {
      try {
        await engine.sync();
        return true;
      } catch {
        return false; // offline-first: unreachable relay is not an error
      }
    },
  };
}
