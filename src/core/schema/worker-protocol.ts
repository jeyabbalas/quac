/**
 * Validation-worker message protocol (json-schema-subsystem.md §F). Rows
 * cross as `unknown[][]` in the order of the init message's `columns` —
 * arrays structured-clone several times faster than 5,000 objects × 265
 * keys; the worker builds each record during §C.3 shaping. A JSON dataset's
 * rows cross as the records' own text instead (`records`). `__row__` itself
 * is NOT a batch column: batches are dense by construction (`__row__` is
 * `row_number() − 1` at ingest), so `rowStart + index` reconstructs it.
 */
import type { QCFlag } from '../flags/flag';
import type { ColumnMeta } from './column-meta';
import type { ConditionalRule } from './conditionals';
import type { NestedPlan } from './nested-values';
import type { SchemaDraft } from './types';
import type { JsonTypeName } from './value-spec';

/**
 * Where the records the validator judges come from (§C.0):
 * - `text` — a CSV, TSV or Excel dataset: each cell's own text, read as the
 *   JSON value it spells where the schema allows that type (text-cells.ts);
 * - `typed` — a Parquet dataset: each value as JSON writes it, the types JSON
 *   lacks in standard text (canonical.ts);
 * - `records` — a JSON dataset: the file's own records, exactly.
 * Corrected cells (a correction rule changed them) are read from the
 * corrected data instead, in every mode.
 */
export type RowSourceKind = 'text' | 'typed' | 'records';

/** How one column's cells cross to the worker. */
export type CellTransport =
  /** The engine's own JS value: VARCHAR, BOOLEAN, integers up to 32 bits, DOUBLE. */
  | { kind: 'native' }
  /** `CAST(c AS VARCHAR)` of a 64/128-bit integer, DECIMAL or FLOAT — every digit (`exact`: integers past 2^53 earn the precision warning). */
  | { kind: 'number'; exact: boolean }
  /** `to_json` text, read back with the column's plan (nested values, dates, intervals, blobs …). */
  | { kind: 'json'; plan: NestedPlan; wideIntegers: boolean }
  /** A text dataset's raw cell, read by the schema (text-cells.ts). */
  | { kind: 'text' };

/** One dataset column as the worker presents it to the validator. */
export interface PresentedColumn {
  /** The dataset column (after ingest hygiene): what flags name. */
  column: string;
  /** The record key the validator sees: the source's own name for it. */
  key: string;
  /** What the schema allows here — how text is read, whether NULL is null. Empty: anything. */
  jsonTypes: JsonTypeName[];
  /** SQL NULL presents as JSON null (else the key is absent). */
  nullAllowed: boolean;
  transport: CellTransport;
  /** How positions inside the value are numbered in messages (`people[2]`): the column's plan as the grid holds it. */
  numbering?: NestedPlan;
  /** Reads a corrected value — `to_json` of the corrected column. */
  fix?: { plan: NestedPlan; wideIntegers: boolean };
}

/**
 * What the dataset as a whole must satisfy, beyond each record's schema
 * (§D.6, dataset-shape.ts). Schemas are named by their `ajv.getSchema` id
 * (`schemaRefUri`).
 */
export interface DatasetChecks {
  /** Records past the prefix: their schema, `false` (no more records allowed) or null (anything). */
  record: string | false | null;
  /** 2020-12 `prefixItems` / draft-07 tuple `items`: one schema per leading record. */
  prefix: string[];
  contains?: { schema: string; min: number; max?: number };
  uniqueItems: boolean;
}

/** Default materialized-schema-flag cap (§F; exact counts continue past it). */
export const DEFAULT_FLAG_CAP = 100_000;
/** Default rows per batch (§B.4). */
export const DEFAULT_BATCH_ROWS = 5_000;

/** ColumnMeta with `jsonTypes` as a sorted array — JSON-printable across the wire. */
export interface SerializedColumnMeta extends Omit<ColumnMeta, 'jsonTypes'> {
  jsonTypes: JsonTypeName[];
}

export function serializeColumnMeta(meta: readonly ColumnMeta[]): SerializedColumnMeta[] {
  return meta.map((m) => ({ ...m, jsonTypes: [...m.jsonTypes].sort() }));
}

export function deserializeColumnMeta(meta: readonly SerializedColumnMeta[]): ColumnMeta[] {
  return meta.map((m) => ({ ...m, jsonTypes: new Set(m.jsonTypes) }));
}

export type MainToWorker =
  | {
      type: 'init';
      files: { uri: string; json: unknown }[];
      draft: SchemaDraft;
      columnMeta: SerializedColumnMeta[];
      conditionals: ConditionalRule[];
      /** Required variables absent from the dataset: their column flag stands for every record's. */
      missingRequired: string[];
      mode: RowSourceKind;
      /** Every dataset column, in order — the record is all of them (§C.3). */
      columns: PresentedColumn[];
      checks: DatasetChecks;
      config: { flagCap: number };
    }
  | {
      type: 'batch';
      seq: number;
      rowStart: number;
      /** `text` / `typed`: one value per column, in `columns` order. */
      rows?: unknown[][];
      /** `records`: each record's text. */
      records?: string[];
      /** Corrected cells: `to_json` of the corrected value, `''` for NULL, null where unchanged. */
      fixes?: (string | null)[][];
    }
  | { type: 'flush' }
  | { type: 'abort' };

export type WorkerToMain =
  | { type: 'ready'; compileMs: number }
  | {
      type: 'batchDone';
      seq: number;
      flags: QCFlag[];
      /** Rows processed in THIS batch (the main thread aggregates). */
      rowsDone: number;
      rowsWithErrors: number;
      /** True once the flag cap has been reached (sticky). */
      truncated: boolean;
      elapsedMs: number;
    }
  | {
      type: 'done';
      summary: ValidationSummary;
      /** Dataset-scope findings the worker reached over all records (duplicates, `contains`, `items: false`). */
      datasetFlags: QCFlag[];
      /** Columns the schema rejected in some record (additional / unevaluated properties). */
      rejectedColumns: string[];
      /** `records`: every top-level key any record has — the dataset's real columns. */
      keysSeen?: string[];
    }
  | { type: 'fatal'; message: string };

/**
 * One schema check that failed, counted exactly — past the flag cap, like
 * `countsByRuleId` — and finer than it: a ruleId such as
 * `schema:prop:age:value` covers every keyword on the variable, while a check
 * is one keyword at one place in the schema. Built from a flag's identifying
 * fields alone, never its message or value: the findings report
 * (core/report/findings.ts) shares these without sharing the data.
 */
export interface SchemaCheckTally {
  ruleId: string;
  scope: QCFlag['scope'];
  column?: string;
  severity: QCFlag['severity'];
  keyword?: string;
  schemaPath?: string;
  /** `<retrievalUri>#<pointer>` of the keyword (QCFlag meta.location). */
  location?: string;
  conditionalIndex?: number;
  /** Flags the check raised: exact. A record fails a check once per place in it. */
  count: number;
  /** Distinct records among them; 0 for column- and dataset-scope checks. */
  records: number;
}

export interface ValidationSummary {
  rowsTotal: number;
  /** Records with at least one error-severity finding. */
  rowsWithErrors: number;
  /** Materialized (posted) flags — capped. */
  flagsEmitted: number;
  flagsTruncated: boolean;
  /** ALWAYS exact, even past the cap → Sheet 4 unaffected (§F). */
  countsByRuleId: Record<string, number>;
  /**
   * Every schema check that failed, exact past the cap: the worker's
   * per-record ones and the run's column- and dataset-level ones
   * (validation-run.ts), in the order each first failed.
   */
  checks: SchemaCheckTally[];
  elapsedMs: number;
  aborted: boolean;
}

export type ValidationPhase = 'casting' | 'compiling' | 'validating' | 'aggregating';

/** Progress events to the duck UI, throttled ≤10 Hz (§F). */
export interface ValidationProgress {
  phase: ValidationPhase;
  rowsDone: number;
  rowsTotal: number;
  flagCount: number;
  rowsPerSec: number;
  etaMs: number;
}
