/**
 * Wrapped-JSON builder — the raw-fidelity route into DuckDB.
 *
 * The v0.5.1 WorkerBridge exposes no registerFileBuffer and its CSV loader is
 * read_csv_auto (type inference kills leading zeros), so delimited text is
 * parsed in the main thread and re-emitted as JSON (Verified facts V17).
 *
 * Plain one-key-per-column JSON fails twice at HESP scale (V18):
 * read_json_auto date-detects ISO-looking strings ('2020-01-01' → DATE), and
 * ≥ ~200 uniformly-typed fields trip its MAP inference, collapsing the whole
 * record into one MAP(VARCHAR, VARCHAR) column — and the loadData RPC
 * whitelist makes both knobs unreachable. So every row is wrapped as
 * {"j": "<row json>"}: a single VARCHAR field can never hit the MAP
 * threshold, and json_extract_string() in the CTAS always returns VARCHAR.
 * Cell keys inside the wrapped payload are positional (c0..cN) — the CTAS
 * aliases them to the sanitized column names, so no JSON-path escaping is
 * ever needed.
 *
 * The output is a top-level JSON ARRAY (one record per line), not NDJSON:
 * the worker's ndjson-vs-array sniffer needs ≥ 2 lines to pick ndjson, so a
 * single-row dataset would misroute — a leading '[' is deterministic for
 * every row count.
 */

const encoder = new TextEncoder();

/**
 * Serialize rows to a wrapped JSON-array byte buffer. Cells hold strings;
 * `null` and `''` become JSON null (read_csv all_varchar NULL parity).
 * Encoded record-by-record into one buffer so no intermediate string
 * approaches the engine's string-length cap. `width` cells are emitted per
 * row (short rows padded with null, extras ignored).
 */
export function buildWrappedJsonBytes(
  width: number,
  rows: readonly (readonly (string | null)[])[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (text: string): void => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    total += bytes.length;
  };

  push('[');
  rows.forEach((row, r) => {
    const record: Record<string, string | null> = {};
    for (let c = 0; c < width; c += 1) {
      const value = row[c];
      record[`c${String(c)}`] = value === undefined || value === '' ? null : value;
    }
    const separator = r === 0 ? '\n' : ',\n';
    push(`${separator}${JSON.stringify({ j: JSON.stringify(record) })}`);
  });
  push('\n]\n');

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
