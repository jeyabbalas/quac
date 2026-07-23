/**
 * Privacy hardening (architecture.md §8): shared rule URLs make rule SQL/JS
 * untrusted code running against private data, so before the first rule
 * statement of a run the bridge's DuckDB is cut off from external state and
 * the configuration is locked so rules cannot re-enable it.
 *
 * Locking is IRREVERSIBLE for the lifetime of the DuckDB worker: after
 * hardenBridge() no further SET works (including app-level ones), so any
 * per-session caps must be passed via `appSets` on the first call.
 * hardenBridge() is idempotent — later calls detect the lock and no-op.
 * Verified sequencing + interaction with loadData()/exportToBuffer() is
 * recorded in architecture.md → Verified facts V6.
 */
import type { WorkerBridge } from '@jeyabbalas/data-table';

const LOCK_PROBE_SQL = "SELECT value FROM duckdb_settings() WHERE name = 'lock_configuration'";

async function isConfigurationLocked(bridge: WorkerBridge): Promise<boolean> {
  const rows = await bridge.query<{ value: unknown }>(LOCK_PROBE_SQL);
  return rows[0]?.value === 'true' || rows[0]?.value === true;
}

export async function hardenBridge(
  bridge: WorkerBridge,
  appSets: readonly string[] = [],
): Promise<void> {
  if (await isConfigurationLocked(bridge)) return;
  for (const sql of appSets) {
    await bridge.query(sql);
  }
  await bridge.query('SET enable_external_access = false');
  await bridge.query('SET lock_configuration = true');
  bridge.clearQueryCache();
}
