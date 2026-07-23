/**
 * Headless dev hook (phase-09 task 6): `window.__quacDev.runSchemaValidation()`
 * runs the schema engine end-to-end against the currently loaded dataset +
 * schema and dumps the summary to the console — the real Run button and
 * annotations display arrive in P14, which deletes this hook.
 *
 * Everything heavy is lazy-imported at call time, so the entry chunk gains
 * only this installer. After a run, `quac_typed` holds the schema-cast
 * table; `quac_work` and the `data` view intentionally keep the plain
 * ingest copy until P14's prepare stage re-CTASes them.
 */
import type { AppStore } from './store';

export function installDevHooks(store: AppStore): void {
  const runSchemaValidation = async (): Promise<unknown> => {
    const dataset = store.dataset.get();
    if (!dataset) throw new Error('QuaC dev: load a dataset first');
    const [schemaStore, columnMeta, flags, validationRun, bridgeModule] = await Promise.all([
      import('../core/schema/schema-store'),
      import('../core/schema/column-meta'),
      import('../core/flags/flagStore'),
      import('../core/schema/validation-run'),
      import('../core/bridge/bridge'),
    ]);
    const schema = schemaStore.schemaState.get();
    if (schema.phase !== 'ready' || schema.set === null) {
      throw new Error('QuaC dev: load a schema first');
    }
    const digest = columnMeta.columnDigest(schema.set);
    if (!digest) {
      throw new Error('QuaC dev: no column digest — unresolved root or fatal schema errors');
    }
    const bridge = await bridgeModule.getBridge();
    const flagStore = flags.createFlagStore();
    const summary = await validationRun.runSchemaValidation({
      runner: bridge,
      set: schema.set,
      digest,
      datasetColumns: dataset.columns,
      flagStore,
      onProgress: (p) => {
        console.log(
          `[quac:schema] ${p.phase} ${String(p.rowsDone)}/${String(p.rowsTotal)} rows, ` +
            `${String(p.flagCount)} flags`,
        );
      },
    });
    console.log('[quac:schema] summary', summary);
    console.log('[quac:schema] flag store', flagStore.summary(summary.rowsTotal));
    return { summary, flagStore };
  };
  (window as unknown as Record<string, unknown>).__quacDev = { runSchemaValidation };
}
