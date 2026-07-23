/**
 * Validation-worker message protocol (json-schema-subsystem.md §F, verbatim
 * shapes). Rows cross as `unknown[][]` + a one-time `columns` list — arrays
 * structured-clone several times faster than 5,000 objects × 265 keys; the
 * worker zips them into row objects during §C.3 shaping. `__row__` itself is
 * NOT a batch column: batches are dense by construction (`__row__` is
 * `row_number() − 1` at ingest), so `rowStart + index` reconstructs it.
 */
import type { QCFlag } from '../flags/flag';
import type { ColumnMeta } from './column-meta';
import type { ConditionalRule } from './conditionals';
import type { SchemaDraft } from './types';
import type { JsonTypeName } from './value-spec';

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
      rootBase: string;
      draft: SchemaDraft;
      columnMeta: SerializedColumnMeta[];
      conditionals: ConditionalRule[];
      missingColumns: string[];
      castFailures: string[];
      config: { flagCap: number };
    }
  | { type: 'batch'; seq: number; rowStart: number; columns?: string[]; rows: unknown[][] }
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
  | { type: 'done'; summary: ValidationSummary }
  | { type: 'fatal'; message: string };

export interface ValidationSummary {
  rowsTotal: number;
  rowsWithErrors: number;
  /** Materialized (posted) flags — capped. */
  flagsEmitted: number;
  flagsTruncated: boolean;
  /** ALWAYS exact, even past the cap → Sheet 4 unaffected (§F). */
  countsByRuleId: Record<string, number>;
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
