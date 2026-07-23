/**
 * All-string NDJSON builder — the raw-fidelity route into DuckDB.
 *
 * The v0.5.1 WorkerBridge exposes no registerFileBuffer and its CSV loader is
 * read_csv_auto (type inference kills leading zeros), so delimited text is
 * parsed in the main thread and re-emitted as NDJSON whose values are all
 * JSON strings: read_json_auto maps JSON strings to VARCHAR, preserving
 * '007' and 19-digit ids exactly (Verified facts V17).
 */

export interface NdjsonOptions {
  /**
   * Prepend a row of non-date strings ("z" per column) to defeat
   * read_json_auto's DATE/TIMESTAMP detection on ISO-looking string columns.
   * The CTAS in ingest.ts must then skip __rowid__ 0 and shift __row__.
   */
  sentinelRow?: boolean;
}

const encoder = new TextEncoder();

/**
 * Serialize rows to NDJSON bytes with `headers` as the key set of every
 * object. Cells hold strings; `null` (and `''`, normalized by the caller's
 * parser contract) become JSON null. Encoded line-by-line into one buffer so
 * no intermediate string approaches the engine's string-length cap.
 */
export function buildNdjsonBytes(
  headers: readonly string[],
  rows: readonly (readonly (string | null)[])[],
  options: NdjsonOptions = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (line: string): void => {
    const bytes = encoder.encode(line);
    chunks.push(bytes);
    total += bytes.length;
  };

  if (options.sentinelRow) {
    push(`${serializeRow(headers, headers.map(() => 'z'))}\n`);
  }
  for (const row of rows) {
    push(`${serializeRow(headers, row)}\n`);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function serializeRow(
  headers: readonly string[],
  row: readonly (string | null)[],
): string {
  const record: Record<string, string | null> = {};
  headers.forEach((header, i) => {
    const value = row[i];
    record[header] = value === undefined || value === '' ? null : value;
  });
  return JSON.stringify(record);
}
