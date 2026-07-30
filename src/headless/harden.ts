/**
 * Node-side prepare hardening (headless.md §2), the `PipelineExecutors.harden`
 * counterpart to `core/bridge/harden.ts`.
 *
 * Two differences from the browser, both consequences of the engine:
 *
 * 1. **No `LOAD`s.** duckdb-wasm autoloads parquet/icu/json from
 *    extensions.duckdb.org at first use (V11), which is why the browser
 *    vendors them and pre-loads them here. `@duckdb/node-api` 1.5.5 links them
 *    statically — there is nothing to load and nothing to fetch.
 *
 * 2. **`enable_external_access = false` is usable.** V6 recorded it as
 *    unusable in wasm: it kills the COPY/loadData round trip the display path
 *    needs, and it is one-way. Native DuckDB has the same one-way semantics
 *    but not the same conflict — every `loadData` temp-file read happens
 *    BEFORE prepare, and everything after prepare is table-only SQL
 *    (corrections CTAS, JS staging, validation SELECTs, report paging). So the
 *    threat model's headline channel (untrusted rule SQL reaching the local
 *    filesystem or the network) is closed at the engine, not merely by policy.
 *
 * A future corrected-data file export would run afoul of this and must either
 * happen before harden or relax it deliberately.
 */
import type { WorkerBridge } from '@jeyabbalas/data-table';

export async function nodeHarden(bridge: WorkerBridge): Promise<void> {
  await bridge.query('SET autoinstall_known_extensions = false');
  await bridge.query('SET autoload_known_extensions = false');
  try {
    await bridge.query('SET enable_external_access = false');
  } catch {
    // One-way per instance: a second harden against the same connection (a
    // re-run) finds it already disabled and DuckDB refuses the no-op.
  }
  bridge.clearQueryCache();
}
