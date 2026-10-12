/**
 * The data dictionary's Semantic search switch (Load → Preview → JSON Schema):
 * json-schema-data-dictionary's opt-in semantic search, run by MongoDB's
 * LEAF-IR in a worker of QuaC's own (semantic.worker.ts) from files this site
 * serves (semanticModel.ts). With it on, a search also lists variables related
 * in meaning ("money owed" → the debt variables), each badged "related".
 *
 * Off by default. On, it costs a model download — 23 MB on WebAssembly, 46 MB
 * on WebGPU, which the browser then caches — and the work of embedding every
 * variable, which a reader who never searches should not pay.
 *
 * What it keeps:
 * - the switch's position, a trivial UI preference in localStorage
 *   (architecture.md §5), so a reader who turned it on finds it on;
 * - while it is on, the dictionary's vectors — numbers computed from its
 *   variables' names and descriptions; no text — in QuaC's own IndexedDB
 *   database, so a reload need not embed the same schema again. Turning the
 *   switch off, clearing the JSON Schema, Clear all inputs and Reset delete
 *   them. The name is QuaC's alone: on a shared origin (github.io) the
 *   library's default database would be every other dictionary's too.
 *
 * Entry-chunk discipline: the package is reached through the dictionary
 * panel's dynamic import, handed in as `lib`; only types are imported here.
 */
import type { Embedder, SemanticSearchOptions, VectorCache } from 'json-schema-data-dictionary';
import { SEMANTIC_MODEL } from './semanticModel';

/** The package exports semantic search uses, handed in by the panel. */
export type SemanticLibraryExports = 'createWorkerEmbedder' | 'createIndexedDbVectorCache';
type Library = Pick<typeof import('json-schema-data-dictionary'), SemanticLibraryExports>;

const PREF = 'quac.dictionary.semanticSearch';

/** QuaC's vector store. Deleted by name only — never any other database. */
export const VECTOR_DB = 'quac-semantic';

/** Swallow-guarded like the Studio rail preference: storage throws in some privacy modes. */
export function readSemanticPref(): boolean {
  try {
    return localStorage.getItem(PREF) === '1';
  } catch {
    return false;
  }
}

export function writeSemanticPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF, '1');
    else localStorage.removeItem(PREF);
  } catch {
    // A preference is best-effort.
  }
}

interface Running {
  /** Null when the browser would not start one: the embedder then only fails. */
  worker: Worker | null;
  embedder: Embedder;
}

/** One worker while the switch is on: every dictionary it indexes reuses the loaded model. */
let running: Running | null = null;
/** One cache instance for the page: its writes are queued, so a clear lands after them. */
let cache: VectorCache | null = null;

/**
 * The page's stand-in for the worker's embedder, usable at once. The worker
 * describes itself (model, vector space, cosine floor) only after it has
 * booted, and the dictionary reads that identity only after `load()`, which
 * waits for the boot. A worker that cannot start rejects `load()`, and the
 * dictionary says "Semantic search unavailable" with the reason.
 */
function startWorker(lib: Library): Running {
  let worker: Worker | null = null;
  let remote: Promise<Embedder>;
  try {
    worker = new Worker(new URL('./semantic.worker.ts', import.meta.url), {
      type: 'module',
      name: 'quac-semantic-search',
    });
    remote = lib.createWorkerEmbedder(worker);
  } catch (err) {
    // No module worker here. The dictionary keeps its keyword search and
    // says why the semantic half is missing; it must not fail to render.
    remote = Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  let booted: Embedder | undefined;
  remote.then(
    (embedder) => {
      booted = embedder;
    },
    () => {
      // Surfaced by load(), through the dictionary's status.
    },
  );
  const embedder: Embedder = {
    get id() {
      return booted?.id ?? SEMANTIC_MODEL;
    },
    get spaceId() {
      return booted?.spaceId;
    },
    get minScore() {
      return booted?.minScore;
    },
    get info() {
      return booted?.info;
    },
    async load(onProgress) {
      await (await remote).load?.(onProgress);
    },
    async embed(texts, kind) {
      return (await remote).embed(texts, kind);
    },
  };
  return { worker, embedder };
}

/** The dictionary's `semanticSearch` options; starts the worker on first use. */
export function semanticSearchOptions(lib: Library): SemanticSearchOptions {
  running ??= startWorker(lib);
  cache ??= lib.createIndexedDbVectorCache({ dbName: VECTOR_DB });
  return { embedder: running.embedder, cache };
}

/**
 * Stop the worker (and the model in it) and delete the vectors: the switch
 * went off, or the JSON Schema was cleared (Clear, Clear all inputs, Reset).
 * The next dictionary shown with the switch on starts a new worker.
 *
 * Terminating first is what makes the deletion final: a batch still being
 * embedded would otherwise come back after it and be written for an index
 * that no longer exists.
 */
export async function stopSemanticSearch(): Promise<void> {
  const stopping = running;
  running = null;
  stopping?.worker?.terminate();
  // The dictionary has just dropped its index, which hands its last vectors
  // to the cache a few microtasks later. Let that write queue first, so the
  // clear behind it removes them and nothing reopens the database afterwards.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await cache?.clear();
  } catch {
    // Best-effort; the database goes below either way.
  }
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(VECTOR_DB);
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => {
        resolve();
      };
      // Another tab holds it open: the library closes it on versionchange,
      // and the deletion completes then. Nothing to wait for here.
      request.onblocked = () => {
        resolve();
      };
    } catch {
      resolve();
    }
  });
}
