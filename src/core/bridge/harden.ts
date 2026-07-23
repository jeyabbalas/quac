/**
 * Privacy hardening, SQL side (architecture.md §8; Verified facts V6): shared
 * rule URLs make rule SQL/JS untrusted code running against private data.
 *
 * The network channel itself is closed at the platform level, not here: the
 * DuckDB worker runs with a generated prelude that deletes XMLHttpRequest /
 * WebSocket / EventSource / importScripts and restricts fetch to the boot-time
 * same-origin .wasm binary (scripts/copy-duckdb-assets.mjs). That is active
 * from bridge creation, before any user data exists.
 *
 * The P03 spike proved every SQL-level gate unusable in duckdb-wasm:
 * - `SET enable_external_access=false` disables ALL file-system operations —
 *   exportToBuffer's COPY and loadData's registered-buffer reads included —
 *   and is one-way ("Cannot enable external access while database is
 *   running"), so the annotate stage could never run after it.
 * - `SET lock_configuration=true` rejects every later SET, and data-table's
 *   loaders issue `SET TimeZone` on each loadData (csv AND parquet), so a
 *   locked bridge can never refresh the display again.
 * - `SET disabled_filesystems` does not govern duckdb-wasm's XHR path.
 *
 * What remains here: per-run app SETs (caps arrive with P12/P14), pre-loading
 * the extensions the pipeline needs from the vendored same-origin repository
 * (parquet: annotate's COPY export; icu: data-table's SET TimeZone on every
 * loadData; json: read_json in rules/ingest) so nothing autoloads later, then
 * disabling extension auto-install/auto-load — an unloaded extension after
 * this point is an error, never a fetch.
 * Idempotent — every statement can be re-issued on later runs.
 */
import type { WorkerBridge } from '@jeyabbalas/data-table';

export async function hardenBridge(
  bridge: WorkerBridge,
  appSets: readonly string[] = [],
): Promise<void> {
  for (const sql of appSets) {
    await bridge.query(sql);
  }
  // Served from the vendored same-origin extension repository (createBridge
  // sets custom_extension_repository; the worker prelude blocks cross-origin).
  await bridge.query('LOAD parquet');
  await bridge.query('LOAD icu');
  await bridge.query('LOAD json');
  await bridge.query('SET autoinstall_known_extensions = false');
  await bridge.query('SET autoload_known_extensions = false');
  bridge.clearQueryCache();
}
