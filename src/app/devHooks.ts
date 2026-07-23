/**
 * Headless dev hooks: `window.__quacDev.runSchemaValidation()` (phase-09
 * task 6) runs the schema engine end-to-end; `window.__quacDev.runRules()`
 * (P12 task 4) hardens the bridge then runs the rules engine — corrections +
 * validations — against the loaded dataset + rules. The real Run button and
 * annotations display arrive in P14, which deletes both hooks; until then
 * runRules is the app-code call site for "hardenBridge() at run start".
 *
 * Everything heavy is lazy-imported at call time, so the entry chunk gains
 * only this installer. After a run, `quac_typed` holds the schema-cast
 * table; `quac_work` and the `data` view hold the rules run's output (rebuilt
 * from `quac_typed` at every runRules call).
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

  const runRules = async (applyCorrections = true): Promise<unknown> => {
    const dataset = store.dataset.get();
    if (!dataset) throw new Error('QuaC dev: load a dataset first');
    const [rulesStore, engine, hardenModule, bridgeModule] = await Promise.all([
      import('../core/rules/rules-store'),
      import('../core/rules/engine'),
      import('../core/bridge/harden'),
      import('../core/bridge/bridge'),
    ]);
    const rules = rulesStore.rulesState.get();
    if (rules.files.length === 0) throw new Error('QuaC dev: load a rules file first');

    // Run start (phase-12 task 4): harden BEFORE any rule SQL, then runQC.
    const bridge = await bridgeModule.getBridge();
    await hardenModule.hardenBridge(bridge);
    const result = await engine.runQC(
      engine.createBridgeRunner(bridge),
      rules.files.map((f) => f.file),
      {
        applyCorrections,
        onProgress: (p) => {
          console.log(
            `[quac:rules] ${p.phase} ${String(p.index + 1)}/${String(p.total)} ${p.ruleId}`,
          );
        },
      },
    );
    console.table(
      result.perRule.map((s) => ({
        rule: s.ruleId,
        status: s.status,
        violations: s.violationCount,
        changed: s.changedCells ?? 0,
        flags: s.flagsEmitted,
      })),
    );
    console.log(
      `[quac:rules] ${String(result.flags.length)} flags · ` +
        `${String(result.correctedCells)} corrected cells`,
    );
    return result;
  };

  (window as unknown as Record<string, unknown>).__quacDev = { runSchemaValidation, runRules };
}
