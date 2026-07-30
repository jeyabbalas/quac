/**
 * The session storage seam (P19b, ingestion.md §6): raw IndexedDB behind the
 * smallest interface the persister needs — `SQLRunner`-style, so the write-
 * through and restore logic never touch IDB APIs and the browser tier can
 * exercise the adapter alone.
 *
 * One database `quac-session` (v1), one object store `session`, out-of-line
 * string keys — no library, no schema migrations to carry. Every failure is
 * swallowed into a value (`null` backend / `false` write / `{}` read): storage
 * is best-effort by contract, and the app must never break because IDB is
 * unavailable (private modes), quota-starved, or torn down mid-flight.
 *
 * Multi-tab: each `write` is ONE transaction, so records are never torn, but
 * two tabs writing interleave last-flush-wins (documented, not solved).
 */

export const SESSION_KEYS = ['meta', 'dataset', 'schema', 'rules', 'studio', 'prefs'] as const;
export type SessionKey = (typeof SESSION_KEYS)[number];

export interface SessionBackend {
  /** Every stored record by key; missing/failed keys are simply absent. */
  readAll: () => Promise<Partial<Record<SessionKey, unknown>>>;
  /** One transaction; a `null` value deletes that key. False = nothing was
   *  committed (quota, clone failure, torn-down DB) — never rejects. */
  write: (entries: Partial<Record<SessionKey, unknown>>) => Promise<boolean>;
  /** Drop every record. Never rejects. */
  clear: () => Promise<void>;
}

const DB_NAME = 'quac-session';
const DB_VERSION = 1;
const STORE = 'session';

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/** Open (creating on first run) or resolve `null` when IDB is unusable. */
export function openSessionBackend(): Promise<SessionBackend | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      // Some privacy modes throw synchronously on `open`, others reject async.
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onerror = () => {
      resolve(null);
    };
    request.onblocked = () => {
      resolve(null);
    };
    request.onsuccess = () => {
      resolve(wrap(request.result));
    };
  });
}

function wrap(db: IDBDatabase): SessionBackend {
  return {
    readAll: async () => {
      const out: Partial<Record<SessionKey, unknown>> = {};
      try {
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const values = await Promise.all(
          SESSION_KEYS.map((key) => requestAsPromise<unknown>(store.get(key))),
        );
        SESSION_KEYS.forEach((key, i) => {
          if (values[i] !== undefined) out[key] = values[i];
        });
      } catch {
        return {};
      }
      return out;
    },
    write: (entries) =>
      new Promise<boolean>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          const store = tx.objectStore(STORE);
          for (const key of SESSION_KEYS) {
            if (!(key in entries)) continue;
            const value = entries[key];
            // `put` throws synchronously on non-clonable values; the catch
            // below turns that into an aborted transaction → false.
            if (value === null) store.delete(key);
            else store.put(value, key);
          }
          tx.oncomplete = () => {
            resolve(true);
          };
          tx.onerror = () => {
            resolve(false);
          };
          tx.onabort = () => {
            resolve(false);
          };
        } catch {
          resolve(false);
        }
      }),
    clear: () =>
      new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          tx.oncomplete = () => {
            resolve();
          };
          tx.onerror = () => {
            resolve();
          };
          tx.onabort = () => {
            resolve();
          };
        } catch {
          resolve();
        }
      }),
  };
}
