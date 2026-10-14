// Minimal IndexedDB key/value store. CryptoKey objects are stored directly
// (structured clone); the browser keeps non-extractable keys non-extractable.

const DB_NAME = 'vesper';
const STORE = 'kv';

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error ?? new Error('indexedDB transaction failed'));
      t.onabort = () => reject(t.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return tx<T>('readonly', (s) => s.get(key) as IDBRequest<T>);
}

export async function idbPut(key: string, value: unknown): Promise<void> {
  await tx('readwrite', (s) => s.put(value, key));
}

export async function idbPutMany(entries: Record<string, unknown>): Promise<void> {
  await tx('readwrite', (s) => {
    for (const [k, v] of Object.entries(entries)) s.put(v, k);
  });
}

export async function idbDelete(key: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(key));
}

export async function idbClear(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}
