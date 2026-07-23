/**
 * Ingest spike + regression tier (phase-05). The spike block gates the whole
 * P05 design (Verified facts V17): all-string NDJSON through
 * bridge.loadData(format:'json') must land every column as VARCHAR with
 * exact text fidelity, and __rowid__ must convert to a contiguous __row__.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { createBridge } from '../../src/core/bridge/bridge';
import { QUAC_RAW } from '../../src/core/bridge/tables';
import { buildNdjsonBytes } from '../../src/core/ingest/ndjson';
import { loadNdjsonAsRaw } from '../../src/core/ingest/ingest';
import peopleCsvUrl from '../fixtures/tiny/people.csv?url';

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

test('V18 evidence: without the sentinel, read_json_auto turns ISO strings into DATE', async () => {
  const headers = ['d'];
  const bytes = buildNdjsonBytes(headers, [['2020-01-01'], ['2020-01-02']]);
  await loadNdjsonAsRaw(b(), bytes, headers);
  // Pins the upstream behavior that forced the sentinel-row contingency:
  // JSON *strings* are not enough — read_json_auto date-detects them.
  expect((await describeTypes(QUAC_RAW)).d).toBe('DATE');
});

test('V17/V18: sentinel-row NDJSON lands every column as VARCHAR with exact fidelity', async () => {
  const headers = ['id', 'big_id', 'birth_date', 'seen_at', 'note'];
  const rows: (string | null)[][] = [
    ['007', '0012345678901234567', '2020-01-01', '2020-01-01T05:00:00Z', 'plain'],
    ['008', '9007199254740993', '1999-12-31', '2021-06-30T23:59:59Z', ''],
    ['009', '42', '2001-02-03', '2022-01-01T00:00:00Z', null],
  ];
  const bytes = buildNdjsonBytes(headers, rows, { sentinelRow: true });
  const result = await loadNdjsonAsRaw(b(), bytes, headers, { sentinelRow: true });

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
