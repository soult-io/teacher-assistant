// Crypto-free Sessions backed by plain Yjs docs, for component/integration tests.
// They exercise the REAL two-doc write path (repository + data/writes DocMutators,
// the master-first validate coordinator, the publish diff) without libsodium (which
// cannot run under jsdom). The LIVE key boundary — a ParaKeyring cannot open the
// master stream — is proven separately with real crypto in data/session.test.ts.
//
// The teacher and para fake sessions SHARE the one para Yjs doc instance (no crypto
// to cross), so a para capture is immediately visible to the teacher's queue and a
// teacher republish to the para screen — the same end state the ciphertext-snapshot
// sharing produces in the real session.

import * as Y from "yjs";
import { applyEdit, validateParaPoint } from "@teacher-assistant/domain-core";
import {
  readParaVisible,
  readRecords,
  setParaTombstone,
  upsertParaPending,
  upsertPoint,
  writeParaVisibleProjection,
  writeRecords,
} from "../data/repository.js";
import { deriveParaQueue, paraPeriodId, publishParaVisible } from "../data/para-publish.js";
import type { ParaHandoff, ParaSession, Session } from "../data/session.js";
import type { SyntheticSeed } from "../data/synthetic-seed.js";

/** The fake handoff carries the shared para Yjs doc so the para session opens the same state. */
interface FakeParaHandoff {
  readonly __fakeParaDoc: Y.Doc;
}

function republish(master: Y.Doc, para: Y.Doc): void {
  const periodId = paraPeriodId(readRecords(master));
  if (periodId !== null) {
    para.transact(() =>
      writeParaVisibleProjection(para, publishParaVisible(readRecords(master), periodId)),
    );
  }
}

/** A crypto-free TEACHER session over a master doc + a shared para doc (seeded from the split seed). */
export function makeFakeSession(seed: SyntheticSeed): Session {
  const master = new Y.Doc();
  master.transact(() => writeRecords(master, seed.master));
  const para = new Y.Doc();
  republish(master, para);
  para.transact(() => {
    for (const pending of seed.paraPending) {
      upsertParaPending(para, pending);
    }
  });

  const handoff = { __fakeParaDoc: para } as unknown as ParaHandoff;
  return {
    role: "teacher",
    records: readRecords(master),
    capture: (mutator) => {
      master.transact(() => mutator(master));
      republish(master, para);
      return Promise.resolve();
    },
    readRecords: () => readRecords(master),
    refreshPara: () => Promise.resolve(),
    readParaQueue: () => deriveParaQueue(readRecords(master).points, readParaVisible(para).pending),
    validatePara: (pending, when) => {
      const { validated } = validateParaPoint(pending, { who: "teacher", when });
      master.transact(() => upsertPoint(master, validated));
      para.transact(() => setParaTombstone(para, pending.data_point_id, when));
      return Promise.resolve();
    },
    validateParaWithEdit: (pending, changes, when) => {
      const corrected = applyEdit(pending, changes, "teacher", when);
      const { validated } = validateParaPoint(corrected, { who: "teacher", when });
      master.transact(() => upsertPoint(master, validated));
      para.transact(() => setParaTombstone(para, pending.data_point_id, when));
      return Promise.resolve();
    },
    paraHandoff: handoff,
    sync: () => Promise.resolve(false),
  };
}

/** The companion crypto-free PARA session — opens the shared para doc handed off by the teacher. */
export function makeFakeParaSession(handoff: ParaHandoff): Promise<ParaSession> {
  const para = (handoff as unknown as FakeParaHandoff).__fakeParaDoc;
  return Promise.resolve({
    role: "para",
    paraRecords: readParaVisible(para),
    capturePara: (mutator) => {
      para.transact(() => mutator(para));
      return Promise.resolve();
    },
    // The fake shares the para doc instance, so a re-read is always current — no-op.
    refreshRecords: () => Promise.resolve(),
    readParaRecords: () => readParaVisible(para),
    sync: () => Promise.resolve(false),
  });
}
