/**
 * QC validation engine (json-schema-subsystem.md §F): owns the Ajv compile,
 * the per-row loop (§C.3 shape → validate → §D translate), the dataset-wide
 * checks that need every record (§D.6: duplicates, `contains`, a closed
 * record list), and the flag cap. The DuckDB worker does the SQL; the main
 * thread (validation-run.ts) orchestrates and never touches Ajv.
 *
 * This module is the engine ITSELF, free of any worker scope — extracted from
 * `validation.worker.ts` in P20 (headless.md §3) so the Node runtime can drive
 * the same code in-process instead of reimplementing it. Two consumers, one
 * source of truth:
 *   browser  validation.worker.ts   — the `self` shell around it
 *   node     headless/validationWorker.ts — a duck-typed Worker around it
 * Each `createValidationEngine` call owns its own state, so two engines can run
 * concurrently without interfering (the browser gets that for free from process
 * isolation; the in-process worker does not).
 *
 * Abort granularity: batch boundaries. The single-slot pipeline keeps at
 * most one batch queued, so an abort posted mid-batch is handled right after
 * the current batch (worst case ≈ one 5,000-row batch) — architecture §6's
 * "cancellable between chunks"; §F's "between rows" wording is noted in the
 * phase deferred notes.
 */
import { buildAjv, collectMetaErrors, prepareSchemaForAjv, registerSchemaFiles } from './ajv-engine';
import { pointerSegments, renderNestedPath } from './nested-values';
import { createRowShaper } from './row-shaping';
import { SCHEMA_DATASET_RULE_IDS } from './rule-ids';
import { createSchemaProbe } from './schema-probe';
import { createTranslateCtx, duplicateRecordsMessage, translateRowErrors } from './translator';
import { deserializeColumnMeta } from './worker-protocol';
import type { ValidateFunction } from 'ajv';
import type AjvCore from 'ajv/dist/core';
import type { QCFlag } from '../flags/flag';
import type { RowShaper } from './row-shaping';
import type { SchemaProbe } from './schema-probe';
import type { AjvErrorLike, TranslateCtx } from './translator';
import type {
  DatasetChecks,
  MainToWorker,
  PresentedColumn,
  ValidationSummary,
  WorkerToMain,
} from './worker-protocol';

interface EngineState {
  /** Leading records' own schemas (`prefixItems`), then the schema of every other record. */
  prefix: ValidateFunction[];
  /** null: records past the prefix are not checked; false: none may exist. */
  record: ValidateFunction | false | null;
  contains: { validate: ValidateFunction; min: number; max?: number; matched: number } | null;
  /** Record fingerprint → first row, when the schema wants unique records. */
  seen: Map<string, number> | null;
  /** Re-validation for the translator's exact applicator blocks (schema-probe.ts). */
  probe: SchemaProbe;
  ctx: TranslateCtx;
  /** The live Set inside ctx — shaping-discovered castKeys are added here. */
  liveCastFailures: Set<string>;
  ordinalByName: ReadonlyMap<string, number>;
  columnByKey: ReadonlyMap<string, PresentedColumn>;
  shaper: RowShaper;
  checks: DatasetChecks;
  flagCap: number;
  counts: Map<string, number>;
  /** Columns already reported as not allowed (one column flag each, §D.6). */
  rejected: Set<string>;
  /** Rows past `items: false` (or past the prefix with no record schema allowed). */
  extraRecords: number;
  /** `records` mode: the union of every record's top-level keys. */
  keysSeen: Set<string> | null;
  datasetFlags: QCFlag[];
  emitted: number;
  rowsDone: number;
  rowsWithErrors: number;
  truncated: boolean;
  startedAt: number;
  aborted: boolean;
  finished: boolean;
}

export interface ValidationEngine {
  /** Feed one protocol message; replies go to the `post` given at construction. */
  handle: (msg: MainToWorker) => void;
}

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

/** Compile a schema by its `ajv.getSchema` id (`schemaRefUri`). */
function compileId(ajv: AjvCore, id: string): ValidateFunction {
  const validate = ajv.getSchema(id);
  if (validate === undefined) throw new Error(`schema engine: '${id}' failed to compile`);
  return validate;
}

/** JSON text of a value with every object's keys sorted — equal JSON values, equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * A 64-bit fingerprint of a record's canonical JSON (two 32-bit FNV-style
 * lanes, plus the length) — `uniqueItems` compares records by JSON equality
 * (§4.2.2: key order and `1` vs `1.0` do not matter) without holding every
 * record in memory.
 */
function fingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  }
  return `${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}:${text.length.toString(36)}`;
}

const datasetFlag = (ruleId: string, message: string): QCFlag => ({
  source: 'schema',
  ruleId,
  scope: 'dataset',
  severity: 'error',
  message,
});

const plural = (n: number, noun: string): string => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Build one engine. `post` receives every reply the §F protocol defines; the
 * caller decides how it reaches the main side (`postMessage` in a real worker,
 * a queued microtask in-process).
 */
export function createValidationEngine(post: (msg: WorkerToMain) => void): ValidationEngine {
  let state: EngineState | null = null;

  function handleInit(msg: Extract<MainToWorker, { type: 'init' }>): void {
    const t0 = performance.now();
    const ajv = buildAjv(msg.draft);
    const metaErrors = collectMetaErrors(ajv, msg.files, msg.draft);
    if (metaErrors.length > 0) {
      const detail = metaErrors.map((e) => `${e.uri}: ${e.message}`).join('; ');
      post({ type: 'fatal', message: `schema meta-validation failed — ${detail}` });
      return;
    }
    // The documents exactly as Ajv holds them (ajv-engine.ts may rewrite a
    // copy: a `__proto__` property, draft-07 `$ref` siblings, an empty enum) —
    // the probe below must locate the very objects Ajv's errors point at.
    const files = msg.files.map((f) => ({ uri: f.uri, json: prepareSchemaForAjv(f.json, msg.draft) }));
    registerSchemaFiles(ajv, files, msg.draft);
    const { checks } = msg;
    const prefix = checks.prefix.map((id) => compileId(ajv, id));
    const record = checks.record === null || checks.record === false ? checks.record : compileId(ajv, checks.record);
    const contains =
      checks.contains === undefined
        ? null
        : {
            validate: compileId(ajv, checks.contains.schema),
            min: checks.contains.min,
            ...(checks.contains.max === undefined ? {} : { max: checks.contains.max }),
            matched: 0,
          };
    // The translator sizes each failed applicator's block of errors by
    // re-validating its branches (error-tree.ts); the record schema tells the
    // probe which subschemas apply only under a dependentSchemas key.
    const rowSchema = typeof checks.record === 'string' ? checks.record : checks.prefix[0];
    const probe = createSchemaProbe(ajv, files, rowSchema === undefined ? {} : { rowSchema });
    const compileMs = Math.round(performance.now() - t0);

    const meta = deserializeColumnMeta(msg.columnMeta);
    const ctx = createTranslateCtx(meta, msg.conditionals, { missingRequired: msg.missingRequired });
    state = {
      prefix,
      record,
      contains,
      seen: checks.uniqueItems ? new Map() : null,
      probe,
      ctx,
      liveCastFailures: ctx.castFailures as Set<string>,
      ordinalByName: ctx.ordinalByName,
      columnByKey: new Map(msg.columns.map((c) => [c.key, c])),
      shaper: createRowShaper(msg.columns, msg.mode),
      checks,
      flagCap: msg.config.flagCap,
      counts: new Map(),
      rejected: new Set(),
      extraRecords: 0,
      keysSeen: msg.mode === 'records' ? new Set() : null,
      datasetFlags: [],
      emitted: 0,
      rowsDone: 0,
      rowsWithErrors: 0,
      truncated: false,
      startedAt: performance.now(),
      aborted: false,
      finished: false,
    };
    post({ type: 'ready', compileMs });
  }

  function handleBatch(msg: Extract<MainToWorker, { type: 'batch' }>): void {
    const s = state;
    if (s === null) throw new Error('batch before init');
    if (s.aborted || s.finished) return;
    const t0 = performance.now();

    const ordinal = (column: string | undefined): number =>
      column === undefined
        ? Number.MAX_SAFE_INTEGER
        : (s.ordinalByName.get(column) ?? Number.MAX_SAFE_INTEGER);

    const out: QCFlag[] = [];
    let rowsWithErrors = 0;
    const count = msg.records?.length ?? msg.rows?.length ?? 0;
    for (let i = 0; i < count; i += 1) {
      const row = msg.rowStart + i;
      const shaped = s.shaper.shapeRow(
        {
          ...(msg.rows === undefined ? {} : { values: msg.rows[i] ?? [] }),
          ...(msg.records === undefined ? {} : { record: msg.records[i] ?? 'null' }),
          ...(msg.fixes === undefined ? {} : { fixes: msg.fixes[i] ?? [] }),
        },
        row,
      );
      const { obj, flags: shapeFlags, castKeys, suppressPaths } = shaped;
      for (const key of castKeys) s.liveCastFailures.add(key);
      if (s.keysSeen !== null && obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const key of Object.keys(obj)) s.keysSeen.add(key);
      }

      if (s.seen !== null) {
        const print = fingerprint(obj);
        const first = s.seen.get(print);
        if (first === undefined) s.seen.set(print, row);
        else s.datasetFlags.push(datasetFlag(SCHEMA_DATASET_RULE_IDS.duplicateRecords, duplicateRecordsMessage(first, row)));
      }
      if (s.contains?.validate(obj)) s.contains.matched += 1;

      const validate = row < s.prefix.length ? s.prefix[row] : s.record;
      let errors: AjvErrorLike[] = [];
      if (validate === false) {
        s.extraRecords += 1;
      } else if (validate !== null && validate !== undefined && !validate(obj)) {
        errors = (validate.errors ?? []) as AjvErrorLike[];
      }
      if (suppressPaths.length > 0) {
        // A NaN inside a value was read as null and already reported.
        errors = errors.filter(
          (e) => !suppressPaths.some((p) => e.instancePath === p || e.instancePath.startsWith(`${p}/`)),
        );
      }
      // Where inside a nested value an error is, numbered as the value inspector shows it.
      const record = obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {};
      const locate = (instancePath: string): string => {
        const [key, ...rest] = pointerSegments(instancePath);
        if (key === undefined) return '';
        return renderNestedPath(key, rest, record[key], s.columnByKey.get(key)?.numbering);
      };
      const translated = translateRowErrors(errors, row, s.ctx, { locate, probe: s.probe });
      const rowFlags: QCFlag[] = [];
      for (const flag of [...shapeFlags, ...translated]) {
        // Flags name the dataset column; the record knew it by the source's name.
        const column = flag.column === undefined ? undefined : (s.columnByKey.get(flag.column)?.column ?? flag.column);
        const named = column === flag.column ? flag : { ...flag, column };
        if (named.scope === 'column') {
          // A column the schema does not allow is one finding, not one per record.
          const key = named.column ?? '';
          if (s.rejected.has(key)) continue;
          s.rejected.add(key);
        }
        rowFlags.push(named);
      }
      rowFlags.sort(
        (a, b) =>
          ordinal(a.column) - ordinal(b.column) ||
          (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
      );
      if (rowFlags.some((f) => f.severity === 'error' && f.scope !== 'column')) rowsWithErrors += 1;
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
    }
    s.rowsWithErrors += rowsWithErrors;

    post({
      type: 'batchDone',
      seq: msg.seq,
      flags: out,
      rowsDone: count,
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
    const datasetFlags = s.aborted ? [] : [...s.datasetFlags];
    if (!s.aborted) {
      if (s.extraRecords > 0) {
        datasetFlags.push(
          datasetFlag(
            SCHEMA_DATASET_RULE_IDS.items,
            `The dataset has ${plural(s.rowsDone, 'record')}; the schema allows at most ${plural(s.prefix.length, 'record')}.`,
          ),
        );
      }
      const c = s.contains;
      if (c !== null) {
        const tooFew = c.matched < c.min;
        const tooMany = c.max !== undefined && c.matched > c.max;
        if (tooFew || tooMany) {
          const wanted =
            c.max === undefined
              ? `at least ${plural(c.min, 'record')}`
              : c.min === c.max
                ? `exactly ${plural(c.min, 'record')}`
                : c.min === 0
                  ? `at most ${plural(c.max, 'record')}`
                  : `between ${c.min.toLocaleString('en-US')} and ${plural(c.max, 'record')}`;
          datasetFlags.push(
            datasetFlag(
              SCHEMA_DATASET_RULE_IDS.contains,
              `${plural(c.matched, 'record')} match${c.matched === 1 ? 'es' : ''} the schema's 'contains' condition; it requires ${wanted} to.`,
            ),
          );
        }
      }
    }
    for (const flag of datasetFlags) s.counts.set(flag.ruleId, (s.counts.get(flag.ruleId) ?? 0) + 1);
    post({
      type: 'done',
      summary: summarize(s),
      datasetFlags,
      rejectedColumns: [...s.rejected],
      ...(s.keysSeen === null ? {} : { keysSeen: [...s.keysSeen] }),
    });
  }

  return {
    handle(msg: MainToWorker): void {
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
        post({
          type: 'fatal',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
