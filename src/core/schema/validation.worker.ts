/**
 * QC validation worker (json-schema-subsystem.md §F): owns the Ajv compile,
 * the per-row loop (§C.3 shape → validate → §D translate), and the flag cap.
 * The DuckDB worker does the SQL; the main thread (validation-run.ts)
 * orchestrates and never touches Ajv.
 *
 * Abort granularity: batch boundaries. The single-slot pipeline keeps at
 * most one batch queued, so an abort posted mid-batch is handled right after
 * the current batch (worst case ≈ one 5,000-row batch) — architecture §6's
 * "cancellable between chunks"; §F's "between rows" wording is noted in the
 * phase deferred notes.
 */
import { buildAjv, collectMetaErrors, compileRowValidator, registerSchemaFiles } from './ajv-engine';
import { createRowShaper, shapingColumns } from './row-shaping';
import { createTranslateCtx, translateRowErrors } from './translator';
import { deserializeColumnMeta } from './worker-protocol';
import type { ValidateFunction } from 'ajv';
import type { QCFlag } from '../flags/flag';
import type { RowShaper } from './row-shaping';
import type { AjvErrorLike, TranslateCtx } from './translator';
import type { MainToWorker, ValidationSummary, WorkerToMain } from './worker-protocol';

/** Minimal structural view of the dedicated-worker scope (no WebWorker lib — it conflicts with DOM). */
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: WorkerToMain) => void;
}

const scope = self as unknown as WorkerScope;

interface EngineState {
  validateRow: ValidateFunction;
  ctx: TranslateCtx;
  /** The live Set inside ctx — shaping-discovered castKeys are added here. */
  liveCastFailures: Set<string>;
  ordinalByName: ReadonlyMap<string, number>;
  metaByName: TranslateCtx['metaByName'];
  shaper: RowShaper | null;
  columns: string[] | null;
  flagCap: number;
  counts: Map<string, number>;
  emitted: number;
  rowsDone: number;
  rowsWithErrors: number;
  truncated: boolean;
  startedAt: number;
  aborted: boolean;
  finished: boolean;
}

let state: EngineState | null = null;

function summarize(s: EngineState): ValidationSummary {
  const countsByRuleId: Record<string, number> = {};
  for (const [ruleId, n] of s.counts) countsByRuleId[ruleId] = n;
  return {
    rowsTotal: s.rowsDone,
    rowsWithErrors: s.rowsWithErrors,
    flagsEmitted: s.emitted,
    flagsTruncated: s.truncated,
    countsByRuleId,
    elapsedMs: Math.round(performance.now() - s.startedAt),
    aborted: s.aborted,
  };
}

function handleInit(msg: Extract<MainToWorker, { type: 'init' }>): void {
  const t0 = performance.now();
  const ajv = buildAjv(msg.draft);
  const metaErrors = collectMetaErrors(ajv, msg.files, msg.draft);
  if (metaErrors.length > 0) {
    const detail = metaErrors.map((e) => `${e.uri}: ${e.message}`).join('; ');
    scope.postMessage({ type: 'fatal', message: `schema meta-validation failed — ${detail}` });
    return;
  }
  registerSchemaFiles(ajv, msg.files, msg.draft);
  const validateRow = compileRowValidator(ajv, msg.rootBase);
  const compileMs = Math.round(performance.now() - t0);

  const meta = deserializeColumnMeta(msg.columnMeta);
  const ctx = createTranslateCtx(meta, msg.conditionals, {
    missingColumns: msg.missingColumns,
    castFailures: msg.castFailures,
  });
  state = {
    validateRow,
    ctx,
    liveCastFailures: ctx.castFailures as Set<string>,
    ordinalByName: ctx.ordinalByName,
    metaByName: ctx.metaByName,
    shaper: null,
    columns: null,
    flagCap: msg.config.flagCap,
    counts: new Map(),
    emitted: 0,
    rowsDone: 0,
    rowsWithErrors: 0,
    truncated: false,
    startedAt: performance.now(),
    aborted: false,
    finished: false,
  };
  scope.postMessage({ type: 'ready', compileMs });
}

function handleBatch(msg: Extract<MainToWorker, { type: 'batch' }>): void {
  const s = state;
  if (s === null) throw new Error('batch before init');
  if (s.aborted || s.finished) return;
  const t0 = performance.now();

  if (msg.columns !== undefined) {
    s.columns = msg.columns;
    s.shaper = createRowShaper(shapingColumns(msg.columns, s.metaByName), {
      // The main thread already excluded out-of-universe columns from the
      // SELECT list (§C.3); anything that arrives is meant to be presented.
      includeExtras: true,
    });
  }
  const shaper = s.shaper;
  if (shaper === null) throw new Error('batch before columns');

  const ordinal = (column: string | undefined): number =>
    column === undefined
      ? Number.MAX_SAFE_INTEGER
      : (s.ordinalByName.get(column) ?? Number.MAX_SAFE_INTEGER);

  const out: QCFlag[] = [];
  let rowsWithErrors = 0;
  msg.rows.forEach((values, i) => {
    const row = msg.rowStart + i;
    const { obj, flags: shapeFlags, castKeys } = shaper.shapeRow(values, row);
    for (const key of castKeys) s.liveCastFailures.add(key);
    const valid = s.validateRow(obj);
    const errors = valid ? [] : ((s.validateRow.errors ?? []) as AjvErrorLike[]);
    const rowFlags = [...shapeFlags, ...translateRowErrors(errors, row, s.ctx)].sort(
      (a, b) =>
        ordinal(a.column) - ordinal(b.column) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
    );
    if (rowFlags.length > 0) rowsWithErrors += 1;
    for (const flag of rowFlags) {
      s.counts.set(flag.ruleId, (s.counts.get(flag.ruleId) ?? 0) + 1);
      if (s.emitted < s.flagCap) {
        out.push(flag);
        s.emitted += 1;
      } else {
        s.truncated = true;
      }
    }
    s.rowsDone += 1;
  });
  s.rowsWithErrors += rowsWithErrors;

  scope.postMessage({
    type: 'batchDone',
    seq: msg.seq,
    flags: out,
    rowsDone: msg.rows.length,
    rowsWithErrors,
    truncated: s.truncated,
    elapsedMs: Math.round(performance.now() - t0),
  });
}

function finish(aborted: boolean): void {
  const s = state;
  if (s === null || s.finished) return;
  s.aborted = s.aborted || aborted;
  s.finished = true;
  scope.postMessage({ type: 'done', summary: summarize(s) });
}

scope.onmessage = (event: MessageEvent): void => {
  const msg = event.data as MainToWorker;
  try {
    switch (msg.type) {
      case 'init':
        handleInit(msg);
        break;
      case 'batch':
        handleBatch(msg);
        break;
      case 'flush':
        finish(false);
        break;
      case 'abort':
        finish(true);
        break;
    }
  } catch (err) {
    scope.postMessage({
      type: 'fatal',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
