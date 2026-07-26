/**
 * Run controller (P14): collects inputs from the module stores, drives
 * core/pipeline.ts, and mirrors progress into store.pipeline / store.run /
 * store.runArtifacts. This module is LAZY — imported on the Run/Re-run click —
 * so the pipeline graph (engines, bridge, data-table helpers) stays out of
 * the entry chunk. It replaces the P09/P12 devHooks as the app-code call site
 * for "hardenBridge() at run start" (the pipeline's prepare stage owns it).
 */
import { reportError } from './errors';
import { showToast } from './toast';
import { getBridge } from '../core/bridge/bridge';
import { assessRunReadiness } from './runReadiness';
import { runPipeline } from '../core/pipeline';
import { presentRun } from '../ui/views/report/presenter';
import { createCancelToken } from './store';
import type { RuleFile } from '../core/rules/types';
import type { JSSandbox } from '../core/rules/types';
import type { ShellContext } from './shell';

/** QuickJS loads only when the run will actually execute a js correction. */
async function resolveSandbox(
  ruleFiles: readonly RuleFile[],
  applyCorrections: boolean,
): Promise<JSSandbox | null> {
  if (!applyCorrections) return null;
  const hasJsRules = ruleFiles.some((f) =>
    f.rules.some((r) => r.enabled && r.ruleType === 'correct' && r.updateLanguage === 'js'),
  );
  if (!hasJsRules) return null;
  try {
    const { loadJSSandbox } = await import('../core/rules/sandbox-loader');
    return await loadJSSandbox();
  } catch (err) {
    // EngineOptions contract: null sandbox ⇒ js rules break, the run continues.
    reportError(err, { fallbackCode: 'RULE_JS_ERROR' });
    return null;
  }
}

/**
 * The Run QC button (Load view) and Re-run (Report panel) both land here.
 * Never auto-invoked (ingestion.md §1: user consent to compute).
 */
export async function startRun(ctx: ShellContext): Promise<void> {
  const { store, router } = ctx;
  const readiness = assessRunReadiness(store);
  if (!readiness.ready) {
    // Same predicate as the Run QC button — a refusal here means the caller
    // bypassed the button (report Re-run), so say why. Silent while running.
    if (readiness.code !== 'running') {
      showToast(readiness.reason, {
        kind: 'info',
        ...(readiness.hint === undefined ? {} : { hint: readiness.hint }),
      });
    }
    return;
  }
  const { schema, ruleFiles } = readiness;
  const dataset = store.dataset.get();
  if (dataset === null) return; // readiness guarantees otherwise (TS narrowing)

  const applyCorrections = store.applyCorrections.get();
  const controller = new AbortController();
  const token = {
    get cancelled(): boolean {
      return controller.signal.aborted;
    },
    cancel: (): void => {
      controller.abort();
    },
  };
  const generationAtStart = dataset.generation;
  store.pipeline.set({ stage: 'prepare', progress: { done: 0, total: 0 }, cancel: token });
  router.navigate('report');

  try {
    const jsSandbox = await resolveSandbox(ruleFiles, applyCorrections);
    const bridge = await getBridge();
    const artifacts = await runPipeline({
      bridge,
      dataset: {
        name: dataset.name,
        columns: dataset.columns,
        rowCount: dataset.rowCount,
      },
      schema,
      ruleFiles,
      applyCorrections,
      jsSandbox,
      signal: controller.signal,
      onProgress: (p) => {
        store.pipeline.set({
          stage: p.stage,
          progress: { done: p.done, total: p.total },
          cancel: token,
        });
      },
      present: presentRun,
    });

    // A dataset replaced mid-run wins: the reset effect already cleared run
    // state and cancelled us — do not resurrect stale results over it.
    if (store.dataset.get()?.generation !== generationAtStart) return;

    store.runArtifacts.set(artifacts);
    const summary = artifacts.flagStore.summary(artifacts.rowsTotal);
    store.run.set({
      flagsSummary: {
        errors: summary.severityTotals.error,
        warnings: summary.severityTotals.warning,
        infos: summary.severityTotals.info,
        corrections: artifacts.rules?.correctedCells ?? 0,
      },
      lastRunAt: Date.now(),
      datasetName: dataset.name,
    });

    for (const stageError of artifacts.stageErrors) {
      reportError(stageError.cause, { fallbackCode: 'BRIDGE_FAILED' });
    }
    const hardFailure = artifacts.stageErrors.some(
      (e) => e.stage === 'prepare' || e.stage === 'annotate',
    );
    const stage = artifacts.cancelled ? 'cancelled' : hardFailure ? 'failed' : 'done';
    if (artifacts.cancelled) {
      showToast('Run cancelled — showing partial results.', { kind: 'info' });
    }
    store.pipeline.set({ stage, progress: { done: 0, total: 0 }, cancel: createCancelToken() });
  } catch (err) {
    // runPipeline contains stage failures; reaching here means the run could
    // not execute at all (e.g. bridge init failed).
    reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
    store.pipeline.set({
      stage: 'failed',
      progress: { done: 0, total: 0 },
      cancel: createCancelToken(),
    });
  }
}
