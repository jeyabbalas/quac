/**
 * Report export orchestrator (P15) — LAZY: imported on the Summary panel's
 * Download click so neither exceljs nor the writer enters the entry chunk.
 * Assembles the pure report model from the run artifacts + the module stores,
 * streams `data` out of DuckDB in 10k-row pages (clearing the SELECT cache
 * after each so a big export never pins the LRU), hands both to the exceljs
 * writer, and triggers a browser download of the resulting Blob.
 *
 * Cancellation is cooperative: the caller passes an AbortSignal, which is
 * threaded into every bridge query and the writer's chunk loop. An aborted
 * export rejects; the caller distinguishes it via `signal.aborted`.
 */
import { getBridge } from '../../../core/bridge/bridge';
import { reportRowsSQL } from '../../../core/bridge/tables';
import { triggerDownload } from '../../components/download';
import { buildReportModel } from '../../../core/report/reportModel';
import { writeReportWorkbook } from '../../../core/report/excelWriter';
import { ANNOTATION_CAP } from '../../../core/report/annotations';
import { FLAG_CAP_DEFAULT } from '../../../core/flags/flagStore';
import { columnDigest } from '../../../core/schema/column-meta';
import { schemaState } from '../../../core/schema/schema-store';
import { rulesState } from '../../../core/rules/rules-store';
import { APP_VERSION } from '../../../app/version';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import type { ShellContext } from '../../../app/shell';
import type { RunArtifacts, RunStage } from '../../../core/pipeline';
import type { ReportDataRow, ReportRowSource } from '../../../core/report/excelWriter';
import type { ReportModelInput, RunInfoInput } from '../../../core/report/reportModel';

const CHUNK_ROWS = 10_000;
const STAGE_ORDER: readonly RunStage[] = ['prepare', 'corrections', 'schema', 'rules', 'annotate'];

export interface ExportOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Schema file list + resolved root/index for the Run Info sheet. */
function schemaRunInfo(): Pick<RunInfoInput, 'schemaFiles' | 'schemaRoot' | 'schemaIndexId'> {
  const state = schemaState.get();
  if (state.phase !== 'ready' || state.set === null) return { schemaFiles: [] };
  const set = state.set;
  const root = set.files.find((f) => f.fileId === set.root.rootFileId);
  return {
    schemaFiles: set.schemas.map((f) => f.relativePath),
    ...(root === undefined ? {} : { schemaRoot: root.relativePath }),
    ...(set.root.indexFileId === undefined ? {} : { schemaIndexId: set.root.indexFileId }),
  };
}

function buildRunInfo(dataset: { name: string; format: string }, artifacts: RunArtifacts): RunInfoInput {
  const ruleFiles = rulesState.get().files;
  const durations = STAGE_ORDER.flatMap((stage) => {
    const ms = artifacts.durations[stage];
    return ms === undefined ? [] : [{ stage, ms }];
  });
  return {
    appVersion: APP_VERSION,
    runAt: new Date(),
    datasetName: dataset.name,
    datasetFormat: dataset.format,
    ...schemaRunInfo(),
    ruleFileSummaries: ruleFiles.map((p) => ({ name: p.file.name, ruleCount: p.file.rules.length })),
    durations,
    correctionsApplied: artifacts.correctionsApplied,
    caps: [
      { label: 'Flags materialized', value: FLAG_CAP_DEFAULT.toLocaleString('en-US') },
      { label: 'Cell annotations painted', value: ANNOTATION_CAP.toLocaleString('en-US') },
    ],
    stageErrors: artifacts.stageErrors.map((e) => ({ stage: e.stage, message: e.message })),
  };
}

/** Page `data` by __row__, clearing the SELECT cache after every chunk. */
function pageRows(bridge: WorkerBridge, rowLimit: number): ReportRowSource {
  return async function* stream(signal?: AbortSignal) {
    for (let offset = 0; offset < rowLimit; offset += CHUNK_ROWS) {
      if (signal?.aborted) throw new Error('Export cancelled');
      const limit = Math.min(CHUNK_ROWS, rowLimit - offset);
      const rows = await bridge.query(reportRowsSQL(offset, limit), signal);
      bridge.clearQueryCache();
      yield rows.map<ReportDataRow>((r) => ({ row: Number(r.__row__), values: r }));
    }
  };
}

/**
 * Build the workbook and download it. Rejects on failure or cancel — the
 * caller reports it (EXPORT_FAILED) or, when `opts.signal.aborted`, treats it
 * as a user cancel.
 */
export async function runReportExport(ctx: ShellContext, opts: ExportOptions = {}): Promise<void> {
  const dataset = ctx.store.dataset.get();
  const artifacts = ctx.store.runArtifacts.get();
  if (dataset === null || artifacts === null) {
    throw new Error('Run QC before exporting the report.');
  }

  const schema = schemaState.get();
  const digest =
    schema.phase === 'ready' && schema.set !== null ? columnDigest(schema.set) : null;

  const input: ReportModelInput = {
    flagStore: artifacts.flagStore,
    datasetColumns: dataset.columns,
    rowCount: dataset.rowCount,
    columnMeta: digest?.meta ?? null,
    ruleFiles: rulesState.get().files.map((p) => p.file),
    rules: artifacts.rules,
    schema: artifacts.schema,
    runInfo: buildRunInfo(dataset, artifacts),
  };

  const model = buildReportModel(input);
  const bridge = await getBridge();
  const blob = await writeReportWorkbook(model, pageRows(bridge, model.data.rowLimit), {
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.onProgress === undefined ? {} : { onProgress: (p) => opts.onProgress?.(p.done, p.total) }),
  });
  if (opts.signal?.aborted) throw new Error('Export cancelled');
  triggerDownload(blob, model.filename);
}
