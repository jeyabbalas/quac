/**
 * Main-thread validation orchestrator (json-schema-subsystem.md §F): casting
 * into quac_typed, column/dataset-scope flags, the single-slot batch pipeline
 * into the QC worker, progress, abort, and the SQL dataset checks. Never
 * imports Ajv — the worker chunk owns it (entry-bundle budget).
 *
 * Duplicate scan: explicit GROUP BY over the quoted data columns — GROUP BY
 * ALL with an aggregate-only select list collapses to ONE whole-table group
 * (verified against @duckdb/node-api 1.5.5); string_agg keeps the row list a
 * plain VARCHAR on both SQL backends (node list() wraps values, Arrow
 * differs).
 */
import { quoteIdentifier } from '@jeyabbalas/data-table';
import { QUAC_TYPED } from '../bridge/tables';
import { computePertinence } from '../pertinence';
import { applyCastPlan, buildCastPlan, describeColumns, scanCastFailures } from './casting';
import { hasOpenPropertyUniverse } from './row-shaping';
import {
  SCHEMA_DATASET_RULE_IDS,
  schemaAdvisoryRuleId,
  schemaColumnRuleId,
} from './rule-ids';
import {
  duplicateRecordsMessage,
  minItemsMessage,
  missingColumnMessage,
  unexpectedColumnMessage,
} from './translator';
import {
  DEFAULT_BATCH_ROWS,
  DEFAULT_FLAG_CAP,
  serializeColumnMeta,
} from './worker-protocol';
import type { QCFlag } from '../flags/flag';
import type { FlagStore } from '../flags/flagStore';
import type { SqlRunner } from './casting';
import type { ColumnDigest } from './column-meta';
import type { SchemaFile, SchemaSet } from './types';
import type {
  MainToWorker,
  ValidationPhase,
  ValidationProgress,
  ValidationSummary,
  WorkerToMain,
} from './worker-protocol';

export interface ValidationRunConfig {
  batchRows?: number;
  flagCap?: number;
}

export interface ValidationRunDeps {
  runner: SqlRunner;
  set: SchemaSet;
  digest: ColumnDigest;
  /** Dataset column names, file order, `__row__` excluded (DatasetSession.columns). */
  datasetColumns: readonly string[];
  flagStore: FlagStore;
  /** Table the row loop and dataset checks read (P14 points this at the corrected data). */
  sourceTable?: string;
  onProgress?: (progress: ValidationProgress) => void;
  signal?: AbortSignal;
  config?: ValidationRunConfig;
  /** Injectable for tests; defaults to the Vite-bundled module worker. */
  createWorker?: () => Worker;
}

const defaultCreateWorker = (): Worker =>
  new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' });

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

const datasetFlag = (
  ruleId: string,
  severity: QCFlag['severity'],
  message: string,
): QCFlag => ({ source: 'schema', ruleId, scope: 'dataset', severity, message });

const columnFlag = (
  ruleId: string,
  column: string,
  severity: QCFlag['severity'],
  message: string,
): QCFlag => ({ source: 'schema', ruleId, scope: 'column', column, severity, message });

/** §E.3: optional-declared variables absent from the dataset are info, not error. */
function optionalMissingMessage(name: string, title?: string): string {
  const titled = title === undefined ? '' : ` (${title})`;
  return `Variable '${name}'${titled} is declared in the schema but not present in the dataset.`;
}

interface WorkerChannel {
  expect: <K extends WorkerToMain['type']>(
    type: K,
  ) => Promise<Extract<WorkerToMain, { type: K }>>;
}

function createChannel(worker: Worker): WorkerChannel {
  const queue: (WorkerToMain | Error)[] = [];
  let wake: (() => void) | null = null;
  const push = (entry: WorkerToMain | Error): void => {
    queue.push(entry);
    wake?.();
  };
  worker.onmessage = (event: MessageEvent): void => {
    push(event.data as WorkerToMain);
  };
  worker.onerror = (event: ErrorEvent): void => {
    push(new Error(`validation worker error: ${event.message}`));
  };
  worker.onmessageerror = (): void => {
    push(new Error('validation worker message failed to deserialize'));
  };
  return {
    async expect(type) {
      for (;;) {
        const entry = queue.shift();
        if (entry === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        if (entry instanceof Error) throw entry;
        if (entry.type === 'fatal') throw new Error(entry.message);
        if (entry.type !== type) {
          throw new Error(`unexpected worker message '${entry.type}' (expected '${type}')`);
        }
        return entry as Extract<WorkerToMain, { type: typeof type }>;
      }
    },
  };
}

function rootFileOf(set: SchemaSet): SchemaFile {
  const root = set.files.find((f) => f.fileId === set.root.rootFileId);
  if (root === undefined) throw new Error('schema set has no resolved root');
  return root;
}

/**
 * End-to-end schema validation (§F): pertinence-derived column flags →
 * casting (+ cast-failure scan) → chunked worker row loop (single-slot
 * pipeline: the fetch of batch N+1 overlaps validation of batch N) → SQL
 * dataset checks. Flags land in the FlagStore as they are produced; the
 * returned summary is the worker's, with `rowsTotal` patched to the
 * authoritative dataset count. Cooperative abort via `signal` (checked
 * between batches; V12: per-call AbortSignal on the bridge fetches).
 */
export async function runSchemaValidation(deps: ValidationRunDeps): Promise<ValidationSummary> {
  const { runner, set, digest, datasetColumns, flagStore, onProgress, signal } = deps;
  const sourceTable = deps.sourceTable ?? QUAC_TYPED;
  const batchRows = Math.max(1, deps.config?.batchRows ?? DEFAULT_BATCH_ROWS);
  const flagCap = deps.config?.flagCap ?? DEFAULT_FLAG_CAP;
  const root = rootFileOf(set);
  const rootJson = (root.json ?? {}) as Record<string, unknown>;
  const meta = digest.meta;
  const metaByName = new Map(meta.map((m) => [m.name, m]));
  const ordinalByName = new Map(meta.map((m, i) => [m.name, i]));

  let flagCount = 0;
  const addFlags = (flags: readonly QCFlag[]): void => {
    if (flags.length === 0) return;
    flagStore.add(flags);
    flagCount += flags.length;
  };

  const startedAt = performance.now();
  let validateStartedAt = startedAt;
  let lastEmit = 0;
  let rowsTotal = 0;
  const emitProgress = (phase: ValidationPhase, rowsDone: number, force = false): void => {
    if (onProgress === undefined) return;
    const now = performance.now();
    if (!force && now - lastEmit < 100) return; // ≤10 Hz (§F)
    lastEmit = now;
    const elapsedS = (now - validateStartedAt) / 1000;
    const rowsPerSec = phase === 'validating' && elapsedS > 0 ? rowsDone / elapsedS : 0;
    onProgress({
      phase,
      rowsDone,
      rowsTotal,
      flagCount,
      rowsPerSec: Math.round(rowsPerSec),
      etaMs: rowsPerSec > 0 ? Math.round(((rowsTotal - rowsDone) / rowsPerSec) * 1000) : 0,
    });
  };

  // ---- Column-scope flags from the shared pertinence check (§E.3/§E.5) ----
  const pertinence = computePertinence({
    schemaColumns: meta.map((m) => ({ name: m.name, required: m.required })),
    datasetColumns: [...datasetColumns],
  });
  const missingColumns: string[] = [];
  {
    const flags: QCFlag[] = [];
    if (pertinence === null) {
      flags.push(
        datasetFlag(
          SCHEMA_DATASET_RULE_IDS.pertinence,
          'info',
          'The schema defines no per-column properties, so data pertinence could not be assessed.',
        ),
      );
    } else {
      const caseMismatchedDataset = new Set(pertinence.caseMismatches.map((c) => c.dataset));
      for (const name of pertinence.missingRequired) {
        missingColumns.push(name);
        flags.push(
          columnFlag(
            schemaColumnRuleId(name, 'missing'),
            name,
            'error',
            missingColumnMessage(name, metaByName.get(name)?.title),
          ),
        );
      }
      for (const name of pertinence.missingOptional) {
        missingColumns.push(name);
        flags.push(
          columnFlag(
            schemaColumnRuleId(name, 'missing'),
            name,
            'info',
            optionalMissingMessage(name, metaByName.get(name)?.title),
          ),
        );
      }
      for (const name of pertinence.extra) {
        // Case-mismatched headers get the dedicated warning below, not
        // `unexpected` on top of it (§H edge 11).
        if (caseMismatchedDataset.has(name)) continue;
        flags.push(
          columnFlag(
            schemaColumnRuleId(name, 'unexpected'),
            name,
            'error',
            unexpectedColumnMessage(name),
          ),
        );
      }
      for (const { dataset, schema } of pertinence.caseMismatches) {
        flags.push(
          columnFlag(
            schemaColumnRuleId(schema, 'case-mismatch'),
            schema,
            'warning',
            `Found column '${dataset}'; the schema defines '${schema}'. Rename the column to validate it.`,
          ),
        );
      }
    }
    // Category/root-level `$comment` advisories (§D.6) — document-root
    // `$comment` of each schema file; constant per schema set.
    for (const file of set.schemas) {
      const comment = (file.json as Record<string, unknown> | null)?.$comment;
      if (typeof comment === 'string' && comment.length > 0) {
        flags.push(
          datasetFlag(
            schemaAdvisoryRuleId(file.fileId),
            'info',
            `Schema note (${file.relativePath}): ${comment}`,
          ),
        );
      }
    }
    addFlags(flags);
  }

  // ---- Casting into quac_typed + cast-failure scan (§C) ----
  emitProgress('casting', 0, true);
  const rawTypes = await describeColumns(runner);
  const plan = buildCastPlan(meta, datasetColumns, rawTypes);
  await applyCastPlan(runner, plan);
  const scan = await scanCastFailures(runner, plan, ordinalByName);
  addFlags(scan.flags);

  const st = quoteIdentifier(sourceTable);
  rowsTotal = num((await runner.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${st}`))[0]?.n);

  // ---- Empty dataset (§H edge 17): no worker run ----
  const minItems = typeof rootJson.minItems === 'number' ? rootJson.minItems : undefined;
  if (rowsTotal === 0) {
    const flags: QCFlag[] = [
      datasetFlag(
        SCHEMA_DATASET_RULE_IDS.empty,
        'error',
        'The dataset contains no records — nothing to validate.',
      ),
    ];
    if (minItems !== undefined && minItems > 0) {
      flags.push(
        datasetFlag(SCHEMA_DATASET_RULE_IDS.minItems, 'error', minItemsMessage(0, minItems)),
      );
    }
    addFlags(flags);
    return {
      rowsTotal: 0,
      rowsWithErrors: 0,
      flagsEmitted: 0,
      flagsTruncated: false,
      countsByRuleId: {},
      elapsedMs: Math.round(performance.now() - startedAt),
      aborted: false,
    };
  }

  // ---- Worker init (§F) ----
  emitProgress('compiling', 0, true);
  const includeExtras = hasOpenPropertyUniverse(set, root.fileId);
  const selected = plan.columns
    .filter((c) => c.inSchema || includeExtras)
    .map((c) => c.column);
  const worker = (deps.createWorker ?? defaultCreateWorker)();
  try {
    const channel = createChannel(worker);
    const post = (msg: MainToWorker): void => {
      worker.postMessage(msg);
    };
    post({
      type: 'init',
      files: set.schemas.map((f) => ({ uri: f.retrievalUri, json: f.json })),
      rootBase: root.declaredId ?? root.retrievalUri,
      draft: root.draft,
      columnMeta: serializeColumnMeta(meta),
      conditionals: digest.conditionals,
      missingColumns,
      castFailures: [...scan.castFailures],
      config: { flagCap },
    });
    await channel.expect('ready');

    // ---- Single-slot batch pipeline (§B.4/§F) ----
    validateStartedAt = performance.now();
    emitProgress('validating', 0, true);
    const selectList = selected.map((c) => quoteIdentifier(c)).join(', ');
    const fetchBatch = async (start: number): Promise<unknown[][]> => {
      const end = Math.min(start + batchRows, rowsTotal);
      const rows = await runner.query(
        `SELECT ${selectList} FROM ${st} ` +
          `WHERE __row__ >= ${String(start)} AND __row__ < ${String(end)} ORDER BY __row__`,
        signal,
      );
      return rows.map((r) => selected.map((name) => r[name]));
    };

    const summary = await (async (): Promise<ValidationSummary> => {
      let rowsDone = 0;
      let aborted = false;
      let pending: Promise<unknown[][]> = Promise.resolve([]);
      try {
        pending = fetchBatch(0);
        for (let start = 0, seq = 0; start < rowsTotal; start += batchRows, seq += 1) {
          const rows = await pending;
          const nextStart = start + batchRows;
          pending =
            nextStart < rowsTotal ? fetchBatch(nextStart) : Promise.resolve([] as unknown[][]);
          post({
            type: 'batch',
            seq,
            rowStart: start,
            ...(seq === 0 ? { columns: selected } : {}),
            rows,
          });
          const done = await channel.expect('batchDone');
          addFlags(done.flags);
          rowsDone += done.rowsDone;
          emitProgress('validating', rowsDone);
          if (signal?.aborted === true) {
            aborted = true;
            break;
          }
        }
      } catch (err) {
        if (signal?.aborted === true) {
          aborted = true;
        } else {
          throw err;
        }
      }
      // An abort can leave the overlapped prefetch in flight; it rejects with
      // the abort error once the bridge cancels it — swallow, never surface.
      void pending.catch(() => undefined);
      post({ type: aborted ? 'abort' : 'flush' });
      const done = await channel.expect('done');
      return done.summary;
    })();

    // ---- Dataset-level SQL checks (§D.6, aggregating) ----
    emitProgress('aggregating', rowsTotal, true);
    if (!summary.aborted) {
      const flags: QCFlag[] = [];
      if (rootJson.uniqueItems === true) {
        const dataCols = plan.columns.map((c) => quoteIdentifier(c.column)).join(', ');
        const groups = await runner.query<{ rows: string }>(
          `SELECT string_agg(CAST(__row__ AS VARCHAR), ',' ORDER BY __row__) AS rows ` +
            `FROM ${st} GROUP BY ${dataCols} HAVING count(*) > 1 ORDER BY min(__row__)`,
          signal,
        );
        for (const group of groups) {
          const ids = group.rows.split(',').map(Number);
          const first = ids[0];
          if (first === undefined) continue;
          for (const other of ids.slice(1)) {
            flags.push(
              datasetFlag(
                SCHEMA_DATASET_RULE_IDS.duplicateRecords,
                'error',
                duplicateRecordsMessage(first, other),
              ),
            );
          }
        }
      }
      if (minItems !== undefined && rowsTotal < minItems) {
        flags.push(
          datasetFlag(
            SCHEMA_DATASET_RULE_IDS.minItems,
            'error',
            minItemsMessage(rowsTotal, minItems),
          ),
        );
      }
      addFlags(flags);
    }
    emitProgress('aggregating', rowsTotal, true);

    return { ...summary, rowsTotal };
  } finally {
    worker.terminate();
  }
}
