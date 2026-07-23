/**
 * QC run pipeline (architecture.md §6): prepare → corrections → schema →
 * rules → annotate, composed over the finished engines. One uniform code path
 * serves every shape — schema-only, rules-only, both, assess-only.
 *
 * Composition contract (P14, from the design review):
 * - ONE runQC call runs corrections AND validations; schema validation runs in
 *   its `betweenPhases` hook — the engine-spec §3 "phase 2" slot — so it reads
 *   the corrected `data`. runQC with zero rule files still performs the
 *   work-table CTAS + view refresh, so schema-only runs need no special case.
 * - runSchemaValidation is called AT MOST ONCE per run (its pertinence /
 *   advisory block is unconditional; a second call would inflate FlagStore
 *   dedupe counts). If runQC rejects before the hook, a containment fallback
 *   runs it afterward.
 * - prepare rebuilds quac_typed BEFORE corrections: with a schema, the cast
 *   plan CTAS (typed columns for rule SQL); without one, a plain copy of
 *   quac_raw (guards the stale-cast case after a schema is removed —
 *   quac_raw is never dropped in v1). The cast-failure scan does NOT run
 *   here: validation-run stays the single writer of `schema:prop:*:cast`
 *   flags, receiving the plan via `castPlan`.
 * - RunResult.flags is IGNORED — onFlags already streamed every batch into
 *   the FlagStore; merging both would double-count.
 * - Cancel is cooperative (store CancelToken → AbortSignal): engines stop at
 *   rule/chunk/batch boundaries with partial results kept. The annotate stage
 *   ALWAYS runs — even cancelled or after stage errors — so the partial state
 *   is presented; per-stage failures are contained in `stageErrors` and later
 *   stages still run.
 *
 * Core stays DOM-free: the annotate stage exports display bytes and builds
 * pure annotation/tooltip plans, then awaits the UI-provided `present` port
 * (the report view owns the DataTable instance).
 */
import { createBridgeRunner, runQC } from './rules/engine';
import { runSchemaValidation } from './schema/validation-run';
import { applyCastPlan, buildCastPlan, describeColumns } from './schema/casting';
import { createFlagStore } from './flags/flagStore';
import { hardenBridge } from './bridge/harden';
import {
  DATA_VIEW,
  DISPLAY_EXPORT_SQL,
  QUAC_RAW,
  QUAC_TYPED,
  copyToParquetBytes,
  ctas,
} from './bridge/tables';
import { ANNOTATION_CAP, buildAnnotationPlan } from './report/annotations';
import { buildHeaderTooltips } from './report/headerTooltips';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import type { CastPlan } from './schema/casting';
import type { ColumnDigest } from './schema/column-meta';
import type { SchemaSet } from './schema/types';
import type { ValidationSummary } from './schema/worker-protocol';
import type { JSSandbox, RuleFile, RuleRunStat } from './rules/types';
import type { FlagStore } from './flags/flagStore';
import type { AnnotationPlan } from './report/annotations';
import type { HeaderTooltipPlan } from './report/headerTooltips';

export type RunStage = 'prepare' | 'corrections' | 'schema' | 'rules' | 'annotate';

export interface RunProgress {
  stage: RunStage;
  done: number;
  /** 0 ⇒ indeterminate. */
  total: number;
  /** ruleId (engine stages) or schema phase name. */
  detail?: string;
  /** Running FlagStore total — cheap exact counter. */
  flagCount: number;
}

export interface StageError {
  stage: RunStage;
  message: string;
  cause: unknown;
}

export interface SchemaRunInput {
  set: SchemaSet;
  digest: ColumnDigest;
}

export interface PresentPayload {
  /** Parquet bytes of `data` ordered by __row__, __row__ excluded (V7). */
  displayBytes: Uint8Array;
  flagStore: FlagStore;
  annotations: AnnotationPlan;
  tooltips: HeaderTooltipPlan;
  /** True when a cancel or an engine abort cut the run short. */
  partial: boolean;
  stageErrors: readonly StageError[];
}

export interface RunArtifacts {
  flagStore: FlagStore;
  rules: { perRule: RuleRunStat[]; correctedCells: number; aborted: boolean } | null;
  schema: ValidationSummary | null;
  cancelled: boolean;
  stageErrors: StageError[];
  durations: Partial<Record<RunStage, number>>;
  rowsTotal: number;
  /** The "Apply corrections" toggle state this run executed with. */
  correctionsApplied: boolean;
}

/** Injectable executor seam — production defaults; unit tests override. */
export interface PipelineExecutors {
  harden: (bridge: WorkerBridge) => Promise<void>;
  /**
   * Rebuild quac_typed for this run: cast-plan CTAS when a schema is loaded
   * (returns the plan for validation-run), plain copy of quac_raw otherwise.
   */
  rebuildTyped: (
    bridge: WorkerBridge,
    schema: SchemaRunInput | null,
    datasetColumns: readonly string[],
  ) => Promise<CastPlan | null>;
  runQC: typeof runQC;
  runSchemaValidation: typeof runSchemaValidation;
  exportDisplay: (bridge: WorkerBridge) => Promise<Uint8Array>;
}

export interface PipelineConfig {
  batchRows?: number;
  schemaFlagCap?: number;
  annotationCap?: number;
  rowCapPerRule?: number;
  datasetRowCap?: number;
  globalFlagCap?: number;
}

export interface PipelineDeps {
  bridge: WorkerBridge;
  dataset: { name: string; columns: readonly string[]; rowCount: number };
  schema: SchemaRunInput | null;
  /** Pre-filtered by the caller: lint-error rules removed (executableRuleFile). */
  ruleFiles: RuleFile[];
  applyCorrections: boolean;
  /** Caller resolves lazily — only when an enabled js correct rule exists. */
  jsSandbox?: JSSandbox | null;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
  /** UI port: loadData + annotations + tooltips + panels. Awaited. */
  present: (payload: PresentPayload) => Promise<void>;
  executors?: Partial<PipelineExecutors>;
  config?: PipelineConfig;
}

async function defaultRebuildTyped(
  bridge: WorkerBridge,
  schema: SchemaRunInput | null,
  datasetColumns: readonly string[],
): Promise<CastPlan | null> {
  if (schema === null) {
    // quac_raw is never dropped in v1 (architecture §4's drop clause is
    // unexercised) — pin: a schema removal must not leave a stale cast.
    await ctas(bridge, QUAC_TYPED, `SELECT * FROM ${QUAC_RAW}`);
    return null;
  }
  const rawTypes = await describeColumns(bridge);
  const plan = buildCastPlan(schema.digest.meta, datasetColumns, rawTypes);
  await applyCastPlan(bridge, plan);
  return plan;
}

const DEFAULT_EXECUTORS: PipelineExecutors = {
  harden: (bridge) => hardenBridge(bridge),
  rebuildTyped: defaultRebuildTyped,
  runQC,
  runSchemaValidation,
  exportDisplay: (bridge) => copyToParquetBytes(bridge, DISPLAY_EXPORT_SQL),
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export async function runPipeline(deps: PipelineDeps): Promise<RunArtifacts> {
  const ex: PipelineExecutors = { ...DEFAULT_EXECUTORS, ...deps.executors };
  const schema = deps.schema;
  const flagStore = createFlagStore();
  const stageErrors: StageError[] = [];
  const durations: Partial<Record<RunStage, number>> = {};
  const cancelled = (): boolean => deps.signal?.aborted === true;
  const emit = (stage: RunStage, done: number, total: number, detail?: string): void => {
    deps.onProgress?.({
      stage,
      done,
      total,
      ...(detail === undefined ? {} : { detail }),
      flagCount: flagStore.totalCount(),
    });
  };
  const recordError = (stage: RunStage, err: unknown): void => {
    stageErrors.push({ stage, message: errorMessage(err), cause: err });
  };

  // ---- prepare ----
  let castPlan: CastPlan | null = null;
  let prepared = false;
  if (!cancelled()) {
    emit('prepare', 0, 0);
    const t0 = performance.now();
    try {
      await ex.harden(deps.bridge);
      castPlan = await ex.rebuildTyped(deps.bridge, schema, deps.dataset.columns);
      prepared = true;
    } catch (err) {
      recordError('prepare', err);
    } finally {
      durations.prepare = performance.now() - t0;
    }
  }

  // ---- schema stage (invoked from runQC's betweenPhases hook; at most once) ----
  // Object properties on purpose: TS/lint pin closure-assigned `let`s to their
  // initializer type/value (same gotcha as engine.ts isAborted).
  const schemaState: { ran: boolean; summary: ValidationSummary | null } = {
    ran: false,
    summary: null,
  };
  const schemaStage = async (): Promise<void> => {
    if (schema === null || schemaState.ran || cancelled()) return;
    schemaState.ran = true;
    emit('schema', 0, 0);
    const t0 = performance.now();
    try {
      schemaState.summary = await ex.runSchemaValidation({
        runner: deps.bridge,
        set: schema.set,
        digest: schema.digest,
        datasetColumns: deps.dataset.columns,
        flagStore,
        sourceTable: DATA_VIEW,
        ...(castPlan === null ? {} : { castPlan }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        onProgress: (p) => {
          emit('schema', p.rowsDone, p.phase === 'validating' ? p.rowsTotal : 0, p.phase);
        },
        config: {
          ...(deps.config?.batchRows === undefined ? {} : { batchRows: deps.config.batchRows }),
          ...(deps.config?.schemaFlagCap === undefined
            ? {}
            : { flagCap: deps.config.schemaFlagCap }),
        },
      });
    } catch (err) {
      // An abort surfaces as summary.aborted, not a throw — anything caught
      // here while cancelled is abort collateral, not a schema failure.
      if (!cancelled()) recordError('schema', err);
    } finally {
      durations.schema = performance.now() - t0;
    }
  };

  // ---- corrections + rules (ONE engine call, schema in the hook) ----
  let rulesResult: RunArtifacts['rules'] = null;
  const hasEnabledCorrections =
    deps.applyCorrections &&
    deps.ruleFiles.some((f) => f.rules.some((r) => r.enabled && r.ruleType === 'correct'));

  if (prepared && !cancelled()) {
    const engineStart = performance.now();
    // Object properties on purpose: closure-assigned locals get pinned to
    // their initializer by TS/lint narrowing (see getSchemaSummary above).
    const hookTime = { start: 0, end: 0 };
    const hook = async (): Promise<void> => {
      hookTime.start = performance.now();
      await schemaStage();
      hookTime.end = performance.now();
    };
    if (hasEnabledCorrections) emit('corrections', 0, 0);
    try {
      const result = await ex.runQC(createBridgeRunner(deps.bridge), deps.ruleFiles, {
        applyCorrections: deps.applyCorrections,
        jsSandbox: deps.jsSandbox ?? null,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        onFlags: (batch) => {
          flagStore.add(batch);
        },
        onProgress: (p) => {
          emit(p.phase === 'correct' ? 'corrections' : 'rules', p.index, p.total, p.ruleId);
        },
        ...(schema === null ? {} : { betweenPhases: hook }),
        ...(deps.config?.rowCapPerRule === undefined
          ? {}
          : { rowCapPerRule: deps.config.rowCapPerRule }),
        ...(deps.config?.datasetRowCap === undefined
          ? {}
          : { datasetRowCap: deps.config.datasetRowCap }),
        ...(deps.config?.globalFlagCap === undefined
          ? {}
          : { globalFlagCap: deps.config.globalFlagCap }),
      });
      // result.flags deliberately ignored — onFlags already streamed them.
      rulesResult = {
        perRule: result.perRule,
        correctedCells: result.correctedCells,
        aborted: result.aborted === true,
      };
    } catch (err) {
      recordError(schemaState.ran ? 'rules' : 'corrections', err);
    } finally {
      const engineEnd = performance.now();
      if (hookTime.end > 0) {
        durations.corrections = hookTime.start - engineStart;
        durations.rules = engineEnd - hookTime.end;
      } else {
        durations[hasEnabledCorrections ? 'corrections' : 'rules'] = engineEnd - engineStart;
      }
    }
    // Containment fallback: runQC rejected before its hook fired (e.g. the
    // work-table CTAS failed mid-phase) — schema still gets its shot.
    await schemaStage();
  }

  // ---- annotate (ALWAYS — partial state must display) ----
  emit('annotate', 0, 0);
  {
    const t0 = performance.now();
    try {
      const displayBytes = await ex.exportDisplay(deps.bridge);
      const annotations = buildAnnotationPlan(flagStore, {
        cap: deps.config?.annotationCap ?? ANNOTATION_CAP,
      });
      const tooltips = buildHeaderTooltips(
        schema?.digest ?? null,
        deps.ruleFiles,
        deps.dataset.columns,
      );
      const partial =
        cancelled() || (rulesResult?.aborted ?? false) || (schemaState.summary?.aborted ?? false);
      await deps.present({ displayBytes, flagStore, annotations, tooltips, partial, stageErrors });
    } catch (err) {
      recordError('annotate', err);
    } finally {
      durations.annotate = performance.now() - t0;
    }
  }

  return {
    flagStore,
    rules: rulesResult,
    schema: schemaState.summary,
    cancelled: cancelled(),
    stageErrors,
    durations,
    rowsTotal: deps.dataset.rowCount,
    correctionsApplied: deps.applyCorrections,
  };
}
