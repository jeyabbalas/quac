/**
 * quac_typed ↔ schema synchronization (P14; architecture.md §4 "created:
 * ingest (+ after schema load)"). Ingest builds quac_typed as a plain copy;
 * once BOTH a dataset and a resolved schema are present, this effect rebuilds
 * it with the schema cast plan and points quac_work + the `data` view at the
 * typed columns — so the rules lint dry-runs (EXPLAIN), the 50-row preview,
 * and the pre-run report grid all see what the run will see. Without this, a
 * CSV dataset stays all-VARCHAR until the first run and every arithmetic rule
 * lints as a binder error (and would be excluded from the run).
 *
 * After each rebuild the rules lint context is re-installed, which re-lints —
 * order-independent convergence with the slot card's own dataset-driven lint.
 * Skipped while a run is in flight (the pipeline owns the tables then) and
 * retried when the pipeline settles. Heavy modules stay behind dynamic
 * imports (entry-chunk discipline).
 */
import { reportError } from './errors';
import { columnDigest } from '../core/schema/column-meta';
import { schemaState } from '../core/schema/schema-store';
import { effect } from './signals';
import type { ColumnDigest } from '../core/schema/column-meta';
import type { ShellContext } from './shell';

const RUNNING = new Set(['prepare', 'corrections', 'schema', 'rules', 'annotate']);

export function installTypedSync(ctx: ShellContext): void {
  let lastKey = '';
  effect(() => {
    const dataset = ctx.store.dataset.get();
    const schema = schemaState.get();
    const stage = ctx.store.pipeline.get().stage;
    if (dataset === null) {
      lastKey = '';
      return;
    }
    if (RUNNING.has(stage)) return; // retried when the pipeline settles

    let digest: ColumnDigest | null = null;
    let setId = 'none';
    if (schema.phase === 'ready' && schema.set !== null) {
      digest = columnDigest(schema.set);
      if (digest !== null) setId = schema.set.setId;
    }
    const key = `${String(dataset.generation)}|${setId}`;
    if (key === lastKey) return;
    // Fresh ingest without a schema already IS the plain copy — nothing to do
    // unless a previously-applied cast must be reverted (schema removed).
    const hadSchemaForGeneration = lastKey.startsWith(`${String(dataset.generation)}|`)
      ? !lastKey.endsWith('|none')
      : false;
    lastKey = key;
    if (digest === null && !hadSchemaForGeneration) return;

    const generation = dataset.generation;
    const frozenDigest = digest;
    void (async () => {
      const [{ getBridge }, casting, tables, rulesStore] = await Promise.all([
        import('../core/bridge/bridge'),
        import('../core/schema/casting'),
        import('../core/bridge/tables'),
        import('../core/rules/rules-store'),
      ]);
      const bridge = await getBridge();
      const stale = (): boolean => ctx.store.dataset.get()?.generation !== generation;
      if (stale()) return;
      if (frozenDigest !== null) {
        const rawTypes = await casting.describeColumns(bridge);
        const plan = casting.buildCastPlan(frozenDigest.meta, dataset.columns, rawTypes);
        if (stale()) return;
        await casting.applyCastPlan(bridge, plan);
      } else {
        await tables.ctas(bridge, tables.QUAC_TYPED, `SELECT * FROM ${tables.QUAC_RAW}`);
      }
      if (stale()) return;
      await tables.swapWorkTable(bridge, `SELECT * FROM ${tables.QUAC_TYPED}`);
      await tables.refreshDataView(bridge);
      if (stale()) return;
      await rulesStore.setLintContext({ runner: bridge, datasetColumns: dataset.columns });
    })().catch((err: unknown) => {
      lastKey = ''; // allow a retry on the next signal change
      reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
    });
  });
}
