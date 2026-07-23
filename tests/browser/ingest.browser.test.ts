/**
 * Ingest spike + regression tier (phase-05). The spike block gates the whole
 * P05 design (Verified facts V17/V18): wrapped JSON through
 * bridge.loadData(format:'json') + json_extract_string CTAS must land every
 * column as VARCHAR with exact text fidelity, and __rowid__ must convert to
 * a contiguous __row__. The evidence block pins the two upstream behaviors
 * that killed plain one-key-per-column JSON.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { createBridge } from '../../src/core/bridge/bridge';
import { DATA_VIEW, DISPLAY_EXPORT_SQL, QUAC_RAW, copyToParquetBytes } from '../../src/core/bridge/tables';
import { buildWrappedJsonBytes } from '../../src/core/ingest/wrappedJson';
import { ingestDataset, loadWrappedJsonAsRaw } from '../../src/core/ingest/ingest';
import { openWorkbook } from '../../src/core/ingest/excel';
import { PARQUET_MAGIC } from './support';
import { HESP_DIRTY_URLS, fetchFixtureBytes, fetchSeededManifest, peopleCsvUrl } from './fixtures';
import type { IngestFormat } from '../../src/core/ingest/sniff';

let bridge: WorkerBridge | undefined;

function b(): WorkerBridge {
  if (!bridge) throw new Error('bridge not initialized');
  return bridge;
}

beforeAll(async () => {
  bridge = await createBridge();
});

afterAll(() => {
  bridge?.terminate();
});

async function describeTypes(table: string): Promise<Record<string, string>> {
  const rows = await b().query<{ column_name: string; column_type: string }>(
    `DESCRIBE ${table}`,
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r.column_type]));
}

test('V18 evidence: plain per-column JSON gets date-detected (ISO strings → DATE)', async () => {
  await b().loadData('{"d":"2020-01-01"}\n{"d":"2020-01-02"}\n', {
    format: 'json',
    tableName: 'v18_dates',
  });
  b().clearQueryCache();
  // JSON *strings* are not enough — read_json_auto date-detects them, and
  // the loadData RPC whitelist makes the detection knobs unreachable.
  expect((await describeTypes('v18_dates')).d).toBe('DATE');
  await b().dropTable('v18_dates');
  b().clearQueryCache();
});

test('V18 evidence: ≥ ~200 uniform fields collapse into MAP(VARCHAR, VARCHAR)', async () => {
  const record: Record<string, string> = {};
  for (let i = 0; i < 266; i += 1) record[`c${String(i)}`] = `v${String(i)}`;
  const line = JSON.stringify(record);
  await b().loadData(`${line}\n${line}\n`, { format: 'json', tableName: 'v18_map' });
  b().clearQueryCache();
  const types = await describeTypes('v18_map');
  // One MAP column instead of 266 VARCHAR columns — the second reason the
  // wrapped-JSON route exists (map_inference_threshold is unreachable).
  expect(Object.values(types)).toContain('MAP(VARCHAR, VARCHAR)');
  expect(Object.keys(types).length).toBeLessThan(266);
  await b().dropTable('v18_map');
  b().clearQueryCache();
});

test('V17/V18: wrapped JSON lands every column as VARCHAR with exact fidelity', async () => {
  const headers = ['id', 'big_id', 'birth_date', 'seen_at', 'note'];
  const rows: (string | null)[][] = [
    ['007', '0012345678901234567', '2020-01-01', '2020-01-01T05:00:00Z', 'plain'],
    ['008', '9007199254740993', '1999-12-31', '2021-06-30T23:59:59Z', ''],
    ['009', '42', '2001-02-03', '2022-01-01T00:00:00Z', null],
  ];
  const bytes = buildWrappedJsonBytes(headers.length, rows);
  const result = await loadWrappedJsonAsRaw(b(), bytes, headers);

  expect(result.rowCount).toBe(3);
  expect(result.columns).toEqual(headers);

  const types = await describeTypes(QUAC_RAW);
  expect(types.__row__).toBe('BIGINT');
  for (const h of headers) {
    expect(types[h], `column ${h} must stay VARCHAR`).toBe('VARCHAR');
  }

  const data = await b().query(
    `SELECT * FROM ${QUAC_RAW} ORDER BY __row__`,
  );
  expect(data.map((r) => Number(r.__row__))).toEqual([0, 1, 2]);
  expect(data[0]?.id).toBe('007');
  expect(data[0]?.big_id).toBe('0012345678901234567');
  expect(data[0]?.birth_date).toBe('2020-01-01');
  expect(data[0]?.seen_at).toBe('2020-01-01T05:00:00Z');
  // '' and null both normalize to SQL NULL (read_csv all_varchar parity).
  expect(data[1]?.note).toBeNull();
  expect(data[2]?.note).toBeNull();
});

test('fixture serving: ?url import of tiny/people.csv fetches real bytes', async () => {
  const res = await fetch(peopleCsvUrl);
  expect(res.ok).toBe(true);
  const text = await res.text();
  const lines = text.trim().split('\n');
  expect(lines[0]).toBe('person_id,name,age,city,score');
  expect(lines).toHaveLength(13); // header + 12 data rows
});

// ---------------------------------------------------------------------------
// Format matrix: every hesp_dirty_100.* fixture lands in quac_raw with the
// manifest's dimensions and a contiguous __row__ (phase-05 verification).
// ---------------------------------------------------------------------------

const FORMATS: IngestFormat[] = ['csv', 'tsv', 'json', 'xlsx', 'parquet'];

for (const format of FORMATS) {
  test(`matrix: hesp_dirty_100.${format} ingests to manifest dimensions`, async () => {
    const manifest = await fetchSeededManifest();
    const bytes = await fetchFixtureBytes(HESP_DIRTY_URLS[format]);
    const result = await ingestDataset(b(), { name: `hesp_dirty_100.${format}`, bytes, format });

    expect(result.rowCount).toBe(manifest.dirtyRows);
    expect(result.columnCount).toBe(manifest.columns);
    expect(result.renames).toEqual([]);

    const types = await describeTypes(QUAC_RAW);
    expect(Object.keys(types)).toHaveLength(manifest.columns + 1); // + __row__
    expect(types.__row__).toBe('BIGINT');
    if (format === 'csv' || format === 'tsv' || format === 'xlsx') {
      // Delimited routes are raw-fidelity: every dataset column is VARCHAR.
      for (const [col, type] of Object.entries(types)) {
        if (col !== '__row__') expect(type, `${col} must be VARCHAR`).toBe('VARCHAR');
      }
    }

    const [rowStats] = await b().query<{ n: number; lo: number; hi: number }>(
      `SELECT count(*)::INT AS n, min(__row__)::INT AS lo, max(__row__)::INT AS hi FROM ${QUAC_RAW}`,
    );
    expect(rowStats).toEqual({ n: manifest.dirtyRows, lo: 0, hi: manifest.dirtyRows - 1 });

    // The post-ingest chain must leave the data view queryable and exportable.
    const [viewCount] = await b().query<{ n: number }>(
      `SELECT count(*)::INT AS n FROM ${DATA_VIEW}`,
    );
    expect(viewCount?.n).toBe(manifest.dirtyRows);
  });
}

test('matrix: json/parquet routes keep typed values (not all-VARCHAR)', async () => {
  const manifest = await fetchSeededManifest();
  for (const format of ['json', 'parquet'] as const) {
    const bytes = await fetchFixtureBytes(HESP_DIRTY_URLS[format]);
    await ingestDataset(b(), { name: `hesp.${format}`, bytes, format });
    const types = await describeTypes(QUAC_RAW);
    const nonVarchar = Object.entries(types).filter(
      ([col, type]) => col !== '__row__' && type !== 'VARCHAR',
    );
    expect(nonVarchar.length, `${format} should keep some typed columns`).toBeGreaterThan(0);
    expect(Object.keys(types)).toHaveLength(manifest.columns + 1);
  }
});

test('display export: DISPLAY_EXPORT_SQL yields parquet bytes without __row__', async () => {
  const bytes = await fetchFixtureBytes(HESP_DIRTY_URLS.csv);
  await ingestDataset(b(), { name: 'hesp.csv', bytes, format: 'csv' });
  const exported = await copyToParquetBytes(b(), DISPLAY_EXPORT_SQL);
  expect([...exported.slice(0, 4)]).toEqual(PARQUET_MAGIC);
});

test('leading zeros survive the delimited route end-to-end (tiny csv + injected value)', async () => {
  const csv = await (await fetch(peopleCsvUrl)).text();
  const doctored = csv.replace('P001', '007'); // person_id cell becomes zero-led
  const bytes = new TextEncoder().encode(doctored).buffer;
  await ingestDataset(b(), { name: 'people.csv', bytes, format: 'csv' });
  const rows = await b().query<{ person_id: string }>(
    `SELECT person_id FROM ${QUAC_RAW} WHERE __row__ = 0`,
  );
  expect(rows[0]?.person_id).toBe('007');
});

test('hygiene integration: reserved/dup/empty headers are renamed in quac_raw', async () => {
  const csv = '__row__,id,ID,,note\n1,a,b,c,d\n';
  const bytes = new TextEncoder().encode(csv).buffer;
  const result = await ingestDataset(b(), { name: 'weird.csv', bytes, format: 'csv' });

  expect(result.columns).toEqual(['row__', 'id', 'ID_2', 'column_4', 'note']);
  expect(result.renames).toEqual([
    { from: '__row__', to: 'row__', reason: 'reserved' },
    { from: 'ID', to: 'ID_2', reason: 'duplicate' },
    { from: '', to: 'column_4', reason: 'empty' },
  ]);
  const types = await describeTypes(QUAC_RAW);
  expect(Object.keys(types).sort()).toEqual(
    ['__row__', 'row__', 'id', 'ID_2', 'column_4', 'note'].sort(),
  );
});

test('two-sheet workbook: names reported, chosen sheet is the one ingested', async () => {
  // Build a two-sheet xlsx in-memory with SheetJS (the committed fixture is
  // single-sheet; the on-disk two_sheets.xlsx fixture serves the e2e tier).
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['a', 'b'],
      ['s1_r1_a', 's1_r1_b'],
    ]),
    'First',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['x', 'y', 'z'],
      ['s2_r1_x', 's2_r1_y', 's2_r1_z'],
      ['s2_r2_x', 's2_r2_y', 's2_r2_z'],
    ]),
    'Second',
  );
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const workbook = await openWorkbook(bytes);
  expect(workbook.sheetNames).toEqual(['First', 'Second']);

  const result = await ingestDataset(b(), {
    name: 'two.xlsx',
    bytes,
    format: 'xlsx',
    sheetName: 'Second',
  });
  expect(result.columns).toEqual(['x', 'y', 'z']);
  expect(result.rowCount).toBe(2);
  const rows = await b().query<{ x: string }>(`SELECT x FROM ${QUAC_RAW} ORDER BY __row__`);
  expect(rows.map((r) => r.x)).toEqual(['s2_r1_x', 's2_r2_x']);
});
