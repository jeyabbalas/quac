/**
 * Lazy singleton WorkerBridge — the one DuckDB-WASM instance shared by the
 * QuaC engine and every data-table mount (architecture.md §1; data-table-api.md
 * §3). WASM bundles are self-hosted under `${BASE_URL}duckdb/` by
 * scripts/copy-duckdb-assets.mjs; exact filenames and wiring are recorded in
 * architecture.md → Verified facts V8. Only `duckdbBundles` is overridden:
 * data-table's own dispatcher worker is bundled same-origin by Vite, so
 * `workerUrl` stays default.
 */
import type { DuckDBBundles } from '@duckdb/duckdb-wasm';
import { WorkerBridge } from '@jeyabbalas/data-table';
import type { WorkerBridgeOptions } from '@jeyabbalas/data-table';

/** Mirrors app/urlBase.ts joinBase — core must not import from app (architecture.md §2). */
function joinBase(base: string, path: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return b + path.replace(/^\/+/, '');
}

/**
 * duckdb-wasm spawns its own worker via the blob-importScripts pattern, whose
 * opaque base URL cannot resolve path-absolute URLs like '/quac/duckdb/x' —
 * bundle URLs must therefore carry the origin (Verified facts V8). In
 * location-less environments (node unit tier) the path form is returned as-is.
 */
function toAbsolute(url: string): string {
  return typeof location === 'undefined' ? url : new URL(url, location.href).href;
}

/**
 * Self-hosted bundle URLs. `base` defaults to the Vite base ('/quac/' in
 * dev/build); tests pass it explicitly because the Vitest node env reports
 * BASE_URL as '/' (Verified facts V9).
 */
export function buildDuckDBBundles(base: string = import.meta.env.BASE_URL): DuckDBBundles {
  const url = (file: string): string => toAbsolute(joinBase(base, `duckdb/${file}`));
  // quac-*.worker.js = upstream worker + generated hardening prelude that
  // removes the worker's network access (see scripts/copy-duckdb-assets.mjs).
  return {
    mvp: {
      mainModule: url('duckdb-mvp.wasm'),
      mainWorker: url('quac-duckdb-browser-mvp.worker.js'),
    },
    eh: {
      mainModule: url('duckdb-eh.wasm'),
      mainWorker: url('quac-duckdb-browser-eh.worker.js'),
    },
  };
}

/**
 * Construct and initialize a non-singleton bridge. Tests use this directly
 * for isolated instances; the app goes through getBridge().
 *
 * duckdb-wasm 1.33.1-dev57.0 autoloads parquet/icu/json from
 * extensions.duckdb.org at first use (they are not statically linked), so the
 * repository is pointed at the vendored same-origin copies before any query
 * runs — the worker prelude only lets same-origin .wasm fetches through, and
 * QuaC must work on locked-down networks.
 */
export async function createBridge(
  overrides: Partial<WorkerBridgeOptions> = {},
): Promise<WorkerBridge> {
  const bridge = new WorkerBridge({ duckdbBundles: buildDuckDBBundles(), ...overrides });
  await bridge.initialize();
  const repo = toAbsolute(joinBase(import.meta.env.BASE_URL, 'duckdb/extensions'));
  await bridge.query(`SET custom_extension_repository = '${repo}'`);
  return bridge;
}

let singleton: Promise<WorkerBridge> | null = null;
let pagehideRegistered = false;

/** The shared app bridge. First call creates + initializes; a failed init clears the memo so a retry is possible. */
export function getBridge(): Promise<WorkerBridge> {
  if (!singleton) {
    const created: Promise<WorkerBridge> = createBridge().catch((error: unknown) => {
      if (singleton === created) singleton = null;
      throw error;
    });
    singleton = created;
    if (!pagehideRegistered && typeof window !== 'undefined') {
      pagehideRegistered = true;
      window.addEventListener('pagehide', () => {
        terminateBridge();
      });
    }
  }
  return singleton;
}

/** Terminate the shared bridge (teardown/tests). Safe to call when none exists. */
export function terminateBridge(): void {
  const current = singleton;
  if (!current) return;
  singleton = null;
  void current
    .then((bridge) => {
      bridge.terminate();
    })
    .catch(() => undefined);
}
