/**
 * Which records the validator judges, per dataset format (§C.0) — see
 * worker-protocol.ts `RowSourceKind`. Main-thread safe: no Ajv, no DuckDB.
 */
import type { RowSourceKind } from './worker-protocol';

export interface RowSourceSpec {
  kind: RowSourceKind;
  /** A JSON dataset's bytes, read once per run — its records are validated as written. */
  bytes?: () => Promise<ArrayBuffer>;
  /**
   * Column-name hygiene at ingest (`from` the source's name `to` the dataset
   * column): a Parquet or JSON record is validated under its own names.
   */
  renames?: readonly { from: string; to: string }[];
}

/** The row source for a dataset of `format`, as ingest loaded it. */
export function rowSourceFor(
  format: string,
  renames: readonly { from: string; to: string }[],
  bytes?: () => Promise<ArrayBuffer>,
): RowSourceSpec {
  if (format === 'json') return { kind: 'records', renames, ...(bytes === undefined ? {} : { bytes }) };
  if (format === 'parquet') return { kind: 'typed', renames };
  return { kind: 'text', renames };
}
