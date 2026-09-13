// Holds the decrypted records in React state and applies writes through the
// session's M5 capture path, re-reading the projection after each write. This is
// the single write→re-render loop the U3 write surfaces use; the records never
// leave memory as plaintext (the session persists ciphertext).

import { useCallback, useState } from "react";
import type { DecryptedRecords } from "../data/repository.js";
import type { DocMutator, Session } from "../data/session.js";

export interface SessionRecords {
  readonly records: DecryptedRecords;
  /** Capture a write (a DocMutator built via data/writes.ts) then refresh the records. */
  apply(mutator: DocMutator): Promise<void>;
}

export function useSessionRecords(session: Session): SessionRecords {
  const [records, setRecords] = useState<DecryptedRecords>(session.records);
  const apply = useCallback(
    async (mutator: DocMutator) => {
      await session.capture(mutator);
      setRecords(session.readRecords());
    },
    [session],
  );
  return { records, apply };
}
