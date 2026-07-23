import { describe, expect, test } from 'vitest';
import { sniffFormat } from '../../../../src/core/ingest/sniff';

const enc = new TextEncoder();
const PARQUET = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0x00]);
const XLSX_ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]);
const CSV = enc.encode('a,b,c\n1,2,3\n');
const TSV = enc.encode('a\tb\tc\n1\t2\t3\n');
const JSON_ARR = enc.encode('[{"a": 1}]');

describe('extension mapping', () => {
  test.each([
    ['data.csv', CSV, 'csv'],
    ['data.CSV', CSV, 'csv'],
    ['data.tsv', TSV, 'tsv'],
    ['data.tab', TSV, 'tsv'],
    ['data.json', JSON_ARR, 'json'],
    ['data.xlsx', XLSX_ZIP, 'xlsx'],
    ['data.parquet', PARQUET, 'parquet'],
    ['data.pq', PARQUET, 'parquet'],
  ] as const)('%s → %s', (name, bytes, expected) => {
    expect(sniffFormat(name, bytes)).toBe(expected);
  });
});

describe('binary magic overrides spoofed text extensions', () => {
  test('parquet bytes named .csv', () => {
    expect(sniffFormat('renamed.csv', PARQUET)).toBe('parquet');
  });
  test('xlsx zip bytes named .csv', () => {
    expect(sniffFormat('renamed.csv', XLSX_ZIP)).toBe('xlsx');
  });
  test('xlsx zip bytes named .txt', () => {
    expect(sniffFormat('renamed.txt', XLSX_ZIP)).toBe('xlsx');
  });
});

describe('content sniff for unknown extensions', () => {
  test('PAR1 magic', () => {
    expect(sniffFormat('blob.bin', PARQUET)).toBe('parquet');
  });
  test('zip magic', () => {
    expect(sniffFormat('blob', XLSX_ZIP)).toBe('xlsx');
  });
  test('leading [ is json', () => {
    expect(sniffFormat('data.txt', JSON_ARR)).toBe('json');
  });
  test('leading { is json', () => {
    expect(sniffFormat('data.txt', enc.encode('  {"a": 1}'))).toBe('json');
  });
  test('BOM before [ still json', () => {
    expect(sniffFormat('data.dat', enc.encode('\uFEFF[{"a":1}]'))).toBe('json');
  });
  test('tab-heavy first line is tsv', () => {
    expect(sniffFormat('data.txt', TSV)).toBe('tsv');
  });
  test('comma line falls back to csv', () => {
    expect(sniffFormat('data.txt', CSV)).toBe('csv');
  });
  test('mixed tabs and more commas prefers csv', () => {
    expect(sniffFormat('x.dat', enc.encode('a,b,c\td\n'))).toBe('csv');
  });
  test('empty file defaults to csv', () => {
    expect(sniffFormat('mystery', new Uint8Array())).toBe('csv');
  });
});
