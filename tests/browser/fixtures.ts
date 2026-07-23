/**
 * Fixture access for the browser tier: Vite serves any asset through
 * `?url` imports, so tests fetch the real committed bytes (proven in the
 * P05 spike). Not a test file.
 */
import hespCsvUrl from '../fixtures/hesp/data/hesp_dirty_100.csv?url';
import hespTsvUrl from '../fixtures/hesp/data/hesp_dirty_100.tsv?url';
import hespJsonUrl from '../fixtures/hesp/data/hesp_dirty_100.json?url';
import hespXlsxUrl from '../fixtures/hesp/data/hesp_dirty_100.xlsx?url';
import hespParquetUrl from '../fixtures/hesp/data/hesp_dirty_100.parquet?url';
import seededViolationsUrl from '../fixtures/hesp/data/seeded-violations.json?url';
import peopleCsvUrl from '../fixtures/tiny/people.csv?url';
import type { IngestFormat } from '../../src/core/ingest/sniff';

export const HESP_DIRTY_URLS: Record<IngestFormat, string> = {
  csv: hespCsvUrl,
  tsv: hespTsvUrl,
  json: hespJsonUrl,
  xlsx: hespXlsxUrl,
  parquet: hespParquetUrl,
};

export { peopleCsvUrl };

export async function fetchFixtureBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture fetch failed: ${String(res.status)} ${url}`);
  return res.arrayBuffer();
}

export interface SeededViolationsManifest {
  baseRows: number;
  dirtyRows: number;
  columns: number;
}

export async function fetchSeededManifest(): Promise<SeededViolationsManifest> {
  const res = await fetch(seededViolationsUrl);
  if (!res.ok) throw new Error(`manifest fetch failed: ${String(res.status)}`);
  return (await res.json()) as SeededViolationsManifest;
}
