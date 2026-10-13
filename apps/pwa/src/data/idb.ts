// IndexedDB plumbing shared by the two at-rest stores: the ciphertext sync streams
// (indexeddb-persistence.ts) and the device record (device/device-store.ts).

/** Resolve with a request's result; reject with its error. */
export function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolve when the transaction commits; reject when it errors or aborts. */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * Open `name` at `version`, creating the one object store `store` on first use. The store
 * has no in-value key path: every record is keyed explicitly on put/add.
 */
export function openSingleStoreDb(
  factory: IDBFactory,
  name: string,
  version: number,
  store: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) {
        db.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}
