/**
 * Dataset format detection (ingestion.md §2 notes). A known extension wins,
 * except that binary magics always override text extensions — a file
 * starting with PAR1 or a zip header can never be valid CSV/TSV/JSON, and
 * spoofed extensions ("renamed .xlsx to .csv") are common.
 */

export type IngestFormat = 'csv' | 'tsv' | 'json' | 'xlsx' | 'parquet';

const EXTENSION_MAP: Record<string, IngestFormat> = {
  csv: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  json: 'json',
  xlsx: 'xlsx',
  parquet: 'parquet',
  pq: 'parquet',
};

const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31]; // 'PAR1'
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // 'PK\x03\x04' (xlsx container)

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, i) => bytes[i] === byte);
}

function sniffBinary(bytes: Uint8Array): IngestFormat | null {
  if (startsWith(bytes, PARQUET_MAGIC)) return 'parquet';
  if (startsWith(bytes, ZIP_MAGIC)) return 'xlsx';
  return null;
}

/** Detect the format from filename extension + leading bytes. */
export function sniffFormat(name: string, bytes: Uint8Array): IngestFormat {
  const binary = sniffBinary(bytes);
  if (binary) return binary;

  const extension = /\.([^.]+)$/.exec(name.toLowerCase())?.[1];
  const byExtension = extension ? EXTENSION_MAP[extension] : undefined;
  if (byExtension) return byExtension;

  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096));
  const trimmed = head.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';

  // Tab-count heuristic on the first line: any tab in a header line that
  // out-tabs its commas reads as TSV.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  if (tabs > 0 && tabs >= commas) return 'tsv';

  return 'csv';
}
