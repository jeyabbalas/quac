/**
 * Delimited-text parsing for the raw-fidelity route (Verified facts V17):
 * PapaParse in the main thread, strings only, headers = row 0. PapaParse is
 * a lazy import — ingest is user-triggered and the parser never belongs in
 * the entry chunk.
 */

export interface ParsedDelimited {
  headers: string[];
  /** Data rows; short rows padded with null, long rows truncated. */
  rows: (string | null)[][];
  parseWarnings: string[];
}

export type Delimiter = ',' | '\t';

export async function parseDelimited(text: string, delimiter: Delimiter): Promise<ParsedDelimited> {
  const Papa = (await import('papaparse')).default;
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    header: false,
    dynamicTyping: false,
    skipEmptyLines: 'greedy',
  });

  const grid = parsed.data;
  const headers = grid[0] ?? [];
  const width = headers.length;
  const warnings = new Map<string, number>();
  const note = (msg: string): void => {
    warnings.set(msg, (warnings.get(msg) ?? 0) + 1);
  };

  for (const err of parsed.errors) {
    // Field-count issues are handled below with pad/truncate; report the rest.
    if (err.code !== 'TooFewFields' && err.code !== 'TooManyFields') {
      note(`${err.code}: ${err.message}`);
    }
  }

  const rows: (string | null)[][] = [];
  for (let i = 1; i < grid.length; i += 1) {
    const raw = grid[i] ?? [];
    if (raw.length > width) note(`row has more fields than the header (extra fields dropped)`);
    else if (raw.length < width) note(`row has fewer fields than the header (padded with nulls)`);
    const row: (string | null)[] = new Array<string | null>(width);
    for (let c = 0; c < width; c += 1) {
      const value = raw[c];
      row[c] = value === undefined || value === '' ? null : value;
    }
    rows.push(row);
  }

  return {
    headers,
    rows,
    parseWarnings: [...warnings.entries()].map(([msg, count]) =>
      count > 1 ? `${msg} ×${String(count)}` : msg,
    ),
  };
}
