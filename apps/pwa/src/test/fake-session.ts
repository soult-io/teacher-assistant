// A crypto-free Session backed by a plain Yjs doc, for component/integration
// tests. It exercises the REAL write path (the data/writes.ts DocMutators + the
// repository read/write) without libsodium — which cannot run under jsdom's
// realm. The live crypto session is covered separately in data/session.test.ts
// (node env).

import * as Y from "yjs";
import { type DecryptedRecords, readRecords, writeRecords } from "../data/repository.js";
import type { Session } from "../data/session.js";

export function makeFakeSession(seed: DecryptedRecords): Session {
  const doc = new Y.Doc();
  doc.transact(() => writeRecords(doc, seed));
  return {
    role: "teacher",
    records: readRecords(doc),
    capture: (mutator) => {
      doc.transact(() => mutator(doc));
      return Promise.resolve();
    },
    readRecords: () => readRecords(doc),
    sync: () => Promise.resolve(false),
  };
}
