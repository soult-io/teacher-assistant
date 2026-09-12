// @teacher-assistant/sync — M1 sync client (encrypted CRDT engine).
//
// Client-side only. Local Yjs docs (one per (period,purpose) stream), an
// app-level encrypted-update relay client, an offline queue, reconnect
// reconciliation that is conflict-free (no overwrite/duplicate), ciphertext-only
// persistence, and identity-clean errors (opaque ids only).

export { EncryptedStream } from "./doc.js";
export { SyncEngine } from "./engine.js";
export {
  RelayClient,
  fetchTransport,
  type Transport,
  type RelayHttpRequest,
  type RelayHttpResponse,
  type RelayClientConfig,
} from "./relay-client.js";
export {
  type PersistenceAdapter,
  type PersistedStream,
  InMemoryPersistence,
} from "./persistence.js";
export { SyncError, RelayRequestError, IntegrateError } from "./errors.js";
