/**
 * Main-thread validation orchestrator (json-schema-subsystem.md §F): the
 * column- and dataset-scope findings, the single-slot batch pipeline into
 * the QC worker, progress and abort. Never imports Ajv — the worker chunk
 * owns it (entry-bundle budget).
 *
 * What the worker validates is the dataset's own records (§C.0), not
 * DuckDB's reading of them: a JSON file's records as written, a Parquet
 * file's values as JSON writes them, a CSV or Excel cell's text as the value
 * it spells. Every dataset column is part of every record — the schema, not
 * QuaC, decides whether an extra column is allowed. A cell a correction rule
 * changed is read from the corrected data instead (`corrected`).
 *
 * quac_typed — the schema's cast of quac_raw — still exists, for the rules:
 * it is what lets `age > 18` work on a CSV column. Validation never reads a
 * cast: DuckDB's casts are lenient (`yes` is true, `1_000` is 1000) and
 * would hide exactly what a schema check is for.
 */
import { QUAC_RAW, QUAC_TYPED } from '../bridge/tables';
import { duckTypeBase, mayHoldWideIntegers, parseDuckType, readsAsJson } from '../duckdb-type';
import { computePertinence } from '../pertinence';
import { quoteIdentifier } from '../sql-identifier';
import { applyCastPlan, buildCastPlan, describeColumns } from './casting';
import { undeclaredColumnMeta } from './column-meta';
import { datasetShape, schemaRefUri } from './dataset-shape';
import { createRefResolver } from './deref';
import { decodeJsonText, jsonArrayElements } from './json-records';
import { buildNestedPlan, propertySite } from './nested-values';
import {
  SCHEMA_DATASET_RULE_IDS,
  schemaAdvisoryRuleId,
  schemaColumnRuleId,
} from './rule-ids';
import { minItemsMessage, missingColumnMessage, noOverlapMessage } from './translator';
import { DEFAULT_BATCH_ROWS, DEFAULT_FLAG_CAP, serializeColumnMeta } from './worker-protocol';
import type { QCFlag } from '../flags/flag';
import type { FlagStore } from '../flags/flagStore';
import type { CastPlan, SqlRunner } from './casting';
import type { ColumnDigest, ColumnMeta } from './column-meta';
import type { RefResolver, SchemaSite } from './deref';
import type { RowSourceSpec } from './row-source';
import type { SchemaFile, SchemaSet } from './types';
import type { JsonTypeName } from './value-spec';
import type {
  CellTransport,
  DatasetChecks,
  MainToWorker,
  PresentedColumn,
  RowSourceKind,
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
  /** The corrected data (P14 points this at the `data` view); default quac_typed. */
  sourceTable?: string;
  /**
   * Pre-applied cast plan from the pipeline's prepare stage (P14): quac_typed
   * already holds this plan's CTAS (applied BEFORE corrections so rules see
   * typed columns), so describe/build/apply are skipped here.
   */
  castPlan?: CastPlan;
  /**
   * Which records to validate (row-source.ts). Absent: a table whose raw
   * columns are all text reads as `text`, any other as `typed`.
   */
  source?: RowSourceSpec;
  /** A correction rule may have changed cells: read those from `sourceTable`. */
  corrected?: boolean;
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

/** An extra column the schema leaves records open to: valid, and worth knowing about. */
function undescribedColumnMessage(name: string): string {
  return `Column '${name}' is not described in the schema; the schema allows it, so its values were not checked.`;
}

const plural = (n: number, noun: string): string => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

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

/** The engine's own JS value is exact for these (Arrow and node-api agree). */
const NATIVE_TYPES = new Set([
  'VARCHAR',
  'BOOLEAN',
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'DOUBLE',
]);
/** Read as their digits: both runtimes hand a 64-bit integer over as a rounded number. */
const NUMBER_TYPES = new Set(['BIGINT', 'UBIGINT', 'HUGEINT', 'UHUGEINT', 'DECIMAL', 'FLOAT', 'REAL']);

function transportFor(rawType: string, site: SchemaSite | null, resolver: RefResolver): CellTransport {
  const base = duckTypeBase(rawType);
  if (NATIVE_TYPES.has(base)) return { kind: 'native' };
  if (NUMBER_TYPES.has(base)) return { kind: 'number', exact: base !== 'FLOAT' && base !== 'REAL' };
  return {
    kind: 'json',
    plan: buildNestedPlan(rawType, site, resolver),
    wideIntegers: mayHoldWideIntegers(parseDuckType(rawType)),
  };
}

/** SQL for one column's cells as its transport carries them. */
function transportSql(ref: string, rawType: string, transport: CellTransport): string {
  switch (transport.kind) {
    case 'native':
    case 'text':
      return ref;
    case 'number':
      return `CAST(${ref} AS VARCHAR)`;
    case 'json':
      // A VARIANT's to_json is its text; its JSON cast is the value.
      return parseDuckType(rawType).kind === 'variant'
        ? `CAST(CAST(${ref} AS JSON) AS VARCHAR)`
        : `CAST(to_json(${ref}) AS VARCHAR)`;
  }
}

/**
 * End-to-end schema validation (§F): column-scope findings → the worker's
 * record loop (single-slot pipeline: the fetch of batch N+1 overlaps
 * validation of batch N) → dataset-scope findings. Flags land in the
 * FlagStore as they are produced; the returned summary is the worker's, with
 * `rowsTotal` patched to the authoritative dataset count. Cooperative abort
 * via `signal` (checked between batches; V12: per-call AbortSignal on the
 * bridge fetches).
 */
export async function runSchemaValidation(deps: ValidationRunDeps): Promise<ValidationSummary> {
  const { runner, set, digest, datasetColumns, flagStore, onProgress, signal } = deps;
  const sourceTable = deps.sourceTable ?? QUAC_TYPED;
  const batchRows = Math.max(1, deps.config?.batchRows ?? DEFAULT_BATCH_ROWS);
  const flagCap = deps.config?.flagCap ?? DEFAULT_FLAG_CAP;
  const corrected = deps.corrected === true;
  const root = rootFileOf(set);
  const meta = digest.meta;
  const metaByName = new Map(meta.map((m) => [m.name, m]));

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

  // ---- Which records: the mode, and each column's name in the source ----
  const rawTypes = await describeColumns(runner, QUAC_RAW);
  let mode: RowSourceKind =
    deps.source?.kind ?? ([...rawTypes.values()].every((t) => duckTypeBase(t) === 'VARCHAR') ? 'text' : 'typed');
  // A CSV header is trimmed at ingest and its schema names match the trimmed
  // text; a Parquet or JSON record keeps the names it was written with.
  const sourceName = new Map(mode === 'text' ? [] : (deps.source?.renames ?? []).map((r) => [r.to, r.from]));
  const keyOf = (column: string): string => sourceName.get(column) ?? column;
  const datasetKeys = datasetColumns.map(keyOf);
  const columnOfKey = new Map(datasetColumns.map((c) => [keyOf(c), c]));

  /**
   * Column-scope findings from the shared pertinence check (§E.3/§E.5),
   * against the dataset's columns by their source names. Extra columns are
   * not judged here: whether one is allowed is the schema's call, made record
   * by record in the worker.
   */
  const pertinenceOf = (
    keys: readonly string[],
  ): { flags: QCFlag[]; missingRequired: string[]; extras: string[] } => {
    const flags: QCFlag[] = [];
    const pertinence = computePertinence({
      schemaColumns: meta.map((m) => ({ name: m.name, required: m.required })),
      datasetColumns: keys,
    });
    if (pertinence === null) {
      flags.push(
        datasetFlag(
          SCHEMA_DATASET_RULE_IDS.pertinence,
          'info',
          'The schema defines no per-column properties, so data pertinence could not be assessed.',
        ),
      );
      return { flags, missingRequired: [], extras: [...keys] };
    }
    for (const name of pertinence.missingRequired) {
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
      flags.push(
        columnFlag(
          schemaColumnRuleId(name, 'missing'),
          name,
          'info',
          optionalMissingMessage(name, metaByName.get(name)?.title),
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
    if (pertinence.matched.length === 0 && meta.length > 0 && keys.length > 0) {
      flags.push(
        datasetFlag(SCHEMA_DATASET_RULE_IDS.noOverlap, 'error', noOverlapMessage(meta.length, keys.length)),
      );
    }
    const caseMismatched = new Set(pertinence.caseMismatches.map((c) => c.dataset));
    return {
      flags,
      missingRequired: pertinence.missingRequired,
      extras: pertinence.extra.filter((key) => !caseMismatched.has(key)),
    };
  };

  // Category/root-level `$comment` advisories (§D.6) — document-root
  // `$comment` of each schema file; constant per schema set.
  {
    const flags: QCFlag[] = [];
    for (const file of set.schemas) {
      const comment = (file.json as Record<string, unknown> | null)?.$comment;
      if (typeof comment === 'string' && comment.length > 0) {
        flags.push(
          datasetFlag(schemaAdvisoryRuleId(file.fileId), 'info', `Schema note (${file.relativePath}): ${comment}`),
        );
      }
    }
    addFlags(flags);
  }

  // ---- quac_typed: the schema's cast, for the rules (§C.1) ----
  emitProgress('casting', 0, true);
  if (deps.castPlan === undefined) {
    const plan = buildCastPlan(meta, datasetColumns, rawTypes, (name) => undeclaredColumnMeta(set, name));
    await applyCastPlan(runner, plan);
  }

  const st = quoteIdentifier(sourceTable);
  rowsTotal = num((await runner.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${st}`))[0]?.n);

  // ---- A JSON dataset's own records (§C.0) ----
  let records: readonly string[] | null = null;
  if (mode === 'records' && rowsTotal > 0) {
    let problem: string | null = null;
    try {
      const bytes = deps.source?.bytes;
      if (bytes === undefined) throw new Error('the file itself is not available to this run');
      const texts = jsonArrayElements(decodeJsonText(await bytes()));
      if (texts.length === rowsTotal) records = texts;
      else problem = `the file holds ${plural(texts.length, 'record')}, the loaded table ${plural(rowsTotal, 'row')}`;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    if (records === null) {
      mode = 'typed';
      addFlags([
        datasetFlag(
          SCHEMA_DATASET_RULE_IDS.source,
          'warning',
          `QuaC could not read this JSON file's records as written (${problem ?? 'unknown reason'}), so it validated ` +
            "DuckDB's reading of them: dates, times and UUIDs in DuckDB's text, and an explicit null read as a missing value.",
        ),
      ]);
    }
  }

  // The dataset's columns by name. A JSON file's real keys are known only once
  // its records are read: its findings wait for the worker's `keysSeen`.
  const columnScope = pertinenceOf(datasetKeys);
  const missingRequired = columnScope.missingRequired;
  let extras = columnScope.extras;
  if (records === null) addFlags(columnScope.flags);

  // ---- What the dataset as a whole must satisfy (dataset-shape.ts) ----
  const shape = datasetShape(set);
  const checks: DatasetChecks = {
    record:
      shape === null
        ? null
        : shape.record === null || shape.record === false
          ? shape.record
          : schemaRefUri(shape.record),
    prefix: shape?.prefix.map(schemaRefUri) ?? [],
    uniqueItems: shape?.uniqueItems === true,
    ...(shape?.contains === undefined
      ? {}
      : {
          contains: {
            schema: schemaRefUri(shape.contains.schema),
            min: shape.contains.min,
            ...(shape.contains.max === undefined ? {} : { max: shape.contains.max }),
          },
        }),
  };
  const minItems = shape?.minItems;
  const maxItems = shape?.maxItems;
  addFlags(
    (shape?.warnings ?? []).map((warning) => datasetFlag(SCHEMA_DATASET_RULE_IDS.unchecked, 'warning', warning)),
  );

  // ---- Empty dataset (§H edge 17): no worker run ----
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

  // ---- The columns as the worker presents them ----
  const resolver = createRefResolver(set);
  const dataTypes = corrected ? await describeColumns(runner, sourceTable) : new Map<string, string>();
  const undeclared = new Map<string, ColumnMeta | null>();
  const undeclaredOf = (key: string): ColumnMeta | null => {
    if (!undeclared.has(key)) undeclared.set(key, undeclaredColumnMeta(set, key));
    return undeclared.get(key) ?? null;
  };
  const columns: PresentedColumn[] = datasetColumns.map((column) => {
    const key = keyOf(column);
    // A column no property declares is read by the patternProperties or
    // additionalProperties schema that covers it — or as the text it is when
    // none does; the schema decides whether it may be there at all.
    const m = metaByName.get(key) ?? undeclaredOf(key) ?? undefined;
    const jsonTypes: JsonTypeName[] = m === undefined ? ['string'] : [...m.jsonTypes].sort();
    const site = m === undefined ? null : propertySite(resolver.fileById(m.source.fileId), m.source.pointer);
    const rawType = rawTypes.get(column) ?? 'VARCHAR';
    const transport: CellTransport =
      mode === 'text' ? { kind: 'text' } : mode === 'typed' ? transportFor(rawType, site, resolver) : { kind: 'native' };
    const numbering = readsAsJson(rawType) ? buildNestedPlan(rawType, site, resolver) : undefined;
    const fixType = dataTypes.get(column);
    const fix =
      fixType === undefined
        ? undefined
        : { plan: buildNestedPlan(fixType, site, resolver), wideIntegers: mayHoldWideIntegers(parseDuckType(fixType)) };
    return {
      column,
      key,
      jsonTypes,
      nullAllowed: jsonTypes.includes('null'),
      transport,
      ...(numbering === undefined ? {} : { numbering }),
      ...(fix === undefined ? {} : { fix }),
    };
  });

  /** §F: worker init, then the single-slot batch pipeline over every column. */
  const runRowLoop = async (): Promise<{
    summary: ValidationSummary;
    datasetFlags: QCFlag[];
    rejectedColumns: string[];
    keysSeen?: string[];
  }> => {
    // ---- Worker init (§F) ----
    emitProgress('compiling', 0, true);
    const worker = (deps.createWorker ?? defaultCreateWorker)();
    try {
      const channel = createChannel(worker);
      const post = (msg: MainToWorker): void => {
        worker.postMessage(msg);
      };
      post({
        type: 'init',
        files: set.schemas.map((f) => ({ uri: f.retrievalUri, json: f.json })),
        draft: root.draft,
        columnMeta: serializeColumnMeta(meta),
        conditionals: digest.conditionals,
        missingRequired,
        mode,
        columns,
        checks,
        config: { flagCap },
      });
      await channel.expect('ready');

      // ---- Single-slot batch pipeline (§B.4/§F) ----
      validateStartedAt = performance.now();
      emitProgress('validating', 0, true);
      const valueSelect =
        mode === 'records'
          ? []
          : columns.map(
              (c, i) =>
                `${transportSql(`r.${quoteIdentifier(c.column)}`, rawTypes.get(c.column) ?? 'VARCHAR', c.transport)} AS "v${String(i)}"`,
            );
      const fixSelect = columns.flatMap((c, i) => {
        if (c.fix === undefined) return [];
        const q = quoteIdentifier(c.column);
        return [
          `CASE WHEN d.${q} IS DISTINCT FROM t.${q} THEN COALESCE(CAST(to_json(d.${q}) AS VARCHAR), '') END AS "f${String(i)}"`,
        ];
      });
      const fixIndex = columns.map((c) => c.fix !== undefined);
      const fetchBatch = async (
        start: number,
      ): Promise<{ rows?: unknown[][]; records?: string[]; fixes?: (string | null)[][] }> => {
        const end = Math.min(start + batchRows, rowsTotal);
        const out: { rows?: unknown[][]; records?: string[]; fixes?: (string | null)[][] } = {};
        if (records !== null) out.records = records.slice(start, end);
        if (valueSelect.length + fixSelect.length === 0) return out;
        const key = valueSelect.length > 0 ? 'r' : 'd';
        const from =
          valueSelect.length === 0
            ? `${st} d JOIN ${quoteIdentifier(QUAC_TYPED)} t ON d.__row__ = t.__row__`
            : fixSelect.length === 0
              ? `${quoteIdentifier(QUAC_RAW)} r`
              : `${quoteIdentifier(QUAC_RAW)} r JOIN ${st} d ON d.__row__ = r.__row__ ` +
                `JOIN ${quoteIdentifier(QUAC_TYPED)} t ON t.__row__ = r.__row__`;
        const rows = await runner.query(
          `SELECT ${[...valueSelect, ...fixSelect].join(', ')} FROM ${from} ` +
            `WHERE ${key}.__row__ >= ${String(start)} AND ${key}.__row__ < ${String(end)} ORDER BY ${key}.__row__`,
          signal,
        );
        if (valueSelect.length > 0) out.rows = rows.map((r) => columns.map((_, i) => r[`v${String(i)}`]));
        if (fixSelect.length > 0) {
          out.fixes = rows.map((r) =>
            columns.map((_, i) => {
              if (fixIndex[i] !== true) return null;
              const v = r[`f${String(i)}`];
              return typeof v === 'string' ? v : null;
            }),
          );
        }
        return out;
      };

      let rowsDone = 0;
      let aborted = false;
      let pending: Promise<Awaited<ReturnType<typeof fetchBatch>>> = Promise.resolve({});
      try {
        pending = fetchBatch(0);
        for (let start = 0, seq = 0; start < rowsTotal; start += batchRows, seq += 1) {
          const batch = await pending;
          const nextStart = start + batchRows;
          pending = nextStart < rowsTotal ? fetchBatch(nextStart) : Promise.resolve({});
          post({ type: 'batch', seq, rowStart: start, ...batch });
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
      return {
        summary: done.summary,
        datasetFlags: done.datasetFlags,
        rejectedColumns: done.rejectedColumns,
        ...(done.keysSeen === undefined ? {} : { keysSeen: done.keysSeen }),
      };
    } finally {
      worker.terminate();
    }
  };

  const loop = await runRowLoop();
  const summary = loop.summary;
  if (records !== null) {
    const seen = pertinenceOf(loop.keysSeen ?? datasetKeys);
    addFlags(seen.flags);
    extras = seen.extras;
  }

  // ---- Dataset-scope findings (§D.6, aggregating) ----
  emitProgress('aggregating', rowsTotal, true);
  if (!summary.aborted) {
    const flags: QCFlag[] = [...loop.datasetFlags];
    if (minItems !== undefined && rowsTotal < minItems) {
      flags.push(datasetFlag(SCHEMA_DATASET_RULE_IDS.minItems, 'error', minItemsMessage(rowsTotal, minItems)));
    }
    if (maxItems !== undefined && rowsTotal > maxItems) {
      flags.push(
        datasetFlag(
          SCHEMA_DATASET_RULE_IDS.maxItems,
          'error',
          `The dataset has ${plural(rowsTotal, 'record')}; the schema allows at most ${plural(maxItems, 'record')}.`,
        ),
      );
    }
    // An extra column the schema rejected already has its error; one it let
    // through is valid — said once, as information.
    const rejected = new Set(loop.rejectedColumns);
    for (const key of extras) {
      const column = columnOfKey.get(key) ?? key;
      // Rejected: its error is in. Covered by a patternProperties or
      // additionalProperties schema: described, and its values were checked.
      if (rejected.has(column) || undeclaredOf(key) !== null) continue;
      flags.push(columnFlag(schemaColumnRuleId(column, 'undescribed'), column, 'info', undescribedColumnMessage(key)));
    }
    addFlags(flags);
  }
  emitProgress('aggregating', rowsTotal, true);

  return { ...summary, rowsTotal };
}
