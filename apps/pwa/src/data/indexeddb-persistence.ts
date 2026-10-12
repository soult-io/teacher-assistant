// Browser at-rest persistence (architecture §1.3, FERPA hard-stop #10/#11). The
// ONLY thing that ever reaches disk is CIPHERTEXT: this adapter stores a
// PersistedStream — opaque encrypted update blobs, an opaque cursor, and an
// optional encrypted snapshot — exactly what the PersistenceAdapter contract
// allows and nothing more. It never sees a decrypted doc or any plaintext field
// (decryption happens in memory on unlock). A plaintext response cache of
// student data would violate D1 / FERPA Item-2a, so there is deliberately no
// plaintext fallback: if IndexedDB is unavailable the app uses the in-memory
// (also ciphertext-only) adapter instead — never localStorage of plaintext.

import type { PersistedStream, PersistenceAdapter } from "@teacher-assistant/sync";

const DB_NAME = "ta-sync";
const STORE = "streams";
const DB_VERSION = 1;

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE); // keyed explicitly by opaque docId (no in-value key)
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

/**
 * Ciphertext-only IndexedDB persistence. Keyed by opaque doc id; the stored
 * value is the ciphertext PersistedStream unchanged. Structured-clone stores the
 * Uint8Array blobs natively, so nothing is re-serialised through a plaintext
 * form.
 */
export class IndexedDbPersistence implements PersistenceAdapter {
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory | undefined = globalThis.indexedDB) {
    if (factory === undefined) {
      throw new Error("IndexedDB is unavailable in this environment");
    }
    this.#factory = factory;
  }

  #database(): Promise<IDBDatabase> {
    this.#db ??= openDb(this.#factory);
    return this.#db;
  }

  async load(docId: string): Promise<PersistedStream | null> {
    const db = await this.#database();
    const tx = db.transaction(STORE, "readonly");
    const value = await promisifyRequest<unknown>(tx.objectStore(STORE).get(docId));
    return (value as PersistedStream | undefined) ?? null;
  }

  async save(docId: string, state: PersistedStream): Promise<void> {
    const db = await this.#database();
    const tx = db.transaction(STORE, "readwrite");
    await promisifyRequest(tx.objectStore(STORE).put(state, docId));
  }
}
