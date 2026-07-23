// P02 fixture-generator gates (phase-02 task 7):
//   1. two runs are byte-identical (the determinism contract behind fixtures:check)
//   2. the violation log matches the injections actually mandated by testing-strategy §3.1
//   3. the generated column list equals the schema property list (265, in order)
//   4. the committed valid file carries zero seeded violations
// plus re-read spot checks of the binary formats (xlsx via exceljs, parquet via duckdb).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  BASE_ROWS,
  EXTRA_COLUMN,
  SEED,
  checkRows,
  deriveColumns,
  deriveConditionals,
  loadSchemaSet,
  parquetFilesEqual,
  parseDelimited,
  typeCsvRows,
} from '../../../scripts/generate-fixtures.mjs';

const require = createRequire(import.meta.url);

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'generate-fixtures.mjs');
const SCHEMA_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'hesp', 'json_schema');
const DATA_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'hesp', 'data');

/** The §3.1 seeded-violation inventory (compound items expanded). */
const EXPECTED_KINDS = [
  'pattern-break',
  'range-break',
  'sentinel-in-numeric-branch',
  'ifthen-const-break',
  'ifthen-notconst-break',
  'cast-non-numeric',
  'cast-non-integral',
  'empty-cell',
  'empty-cell-key',
  'record-id-decomposition',
  'age-regression',
  'roster-arithmetic',
  'income-sum-tolerance',
  'legacy-sentinel-777',
  'legacy-sentinel-888',
  'legacy-sentinel-999',
  'cents-scaled-rent',
  'negative-debt',
  'malformed-household-id',
  'invalid-calendar-date',
  'duplicate-household-wave',
  'duplicate-full-row',
  'extra-column',
];

interface Injection {
  kind: string;
  rows: number[];
  column: string | null;
  expectedRuleIds: string[];
}

interface ViolationLog {
  seed: number;
  rowIndexBase: number;
  baseRows: number;
  dirtyRows: number;
  columns: number;
  kinds: string[];
  injections: Injection[];
}

function readLog(): ViolationLog {
  return JSON.parse(readFileSync(join(DATA_DIR, 'seeded-violations.json'), 'utf8')) as ViolationLog;
}

describe('generate-fixtures.mjs', () => {
  it('produces byte-identical output across two runs', { timeout: 240_000 }, async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'quac-fixtures-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'quac-fixtures-b-'));
    try {
      execFileSync(process.execPath, [SCRIPT, '--out', dirA], { stdio: 'pipe' });
      execFileSync(process.execPath, [SCRIPT, '--out', dirB], { stdio: 'pipe' });
      const filesA = readdirSync(dirA).sort();
      const filesB = readdirSync(dirB).sort();
      expect(filesA).toEqual(filesB);
      expect(filesA.length).toBe(7);
      for (const name of filesA) {
        const a = readFileSync(join(dirA, name));
        const b = readFileSync(join(dirB, name));
        expect(a.equals(b), `${name} differs between runs`).toBe(true);
      }
      // The committed fixtures are themselves a third run of the same code.
      // Parquet is compared by content, not bytes: DuckDB's native writer
      // emits platform-dependent bytes for identical data (V16), and the
      // generator deliberately keeps the committed file when content matches.
      for (const name of filesA) {
        if (name.endsWith('.parquet')) {
          expect(
            await parquetFilesEqual(join(dirA, name), join(DATA_DIR, name)),
            `${name} content differs from committed fixture`,
          ).toBe(true);
          continue;
        }
        const fresh = readFileSync(join(dirA, name));
        const committed = readFileSync(join(DATA_DIR, name));
        expect(fresh.equals(committed), `${name} differs from committed fixture`).toBe(true);
      }
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('logs exactly the mandated violation inventory', () => {
    const log = readLog();
    expect(log.seed).toBe(SEED);
    expect(log.rowIndexBase).toBe(0);
    expect(log.baseRows).toBe(BASE_ROWS);
    expect(log.kinds).toEqual(EXPECTED_KINDS);
    expect(log.injections.length).toBe(EXPECTED_KINDS.length);
    expect(log.injections.map((i) => i.kind)).toEqual(EXPECTED_KINDS);
    for (const inj of log.injections) {
      expect(inj.expectedRuleIds.length, `${inj.kind} has expected rule ids`).toBeGreaterThan(0);
      for (const row of inj.rows) {
        expect(row).toBeGreaterThanOrEqual(0);
        expect(row).toBeLessThan(log.dirtyRows);
      }
    }
    // Dirty CSV dimensions match the log.
    const dirty = parseDelimited(readFileSync(join(DATA_DIR, 'hesp_dirty_100.csv'), 'utf8'));
    expect(dirty.rows.length).toBe(log.dirtyRows);
    expect(dirty.header.length).toBe(log.columns);
    expect(dirty.header.at(-1)).toBe(EXTRA_COLUMN);
  });

  it('derives the 265-column layout from the schema itself', () => {
    const set = loadSchemaSet(SCHEMA_DIR);
    const columns = deriveColumns(set);
    expect(columns.length).toBe(265);

    // Independent minimal walk: category refs in allOf order, property keys in order.
    const core = JSON.parse(readFileSync(join(SCHEMA_DIR, 'core', 'core.schema.json'), 'utf8')) as {
      items: { allOf: ({ $ref?: string } & Record<string, unknown>)[] };
    };
    const expected: string[] = [];
    for (const entry of core.items.allOf) {
      if (typeof entry.$ref !== 'string') continue;
      const rel = entry.$ref.replace(/^categories\//, '');
      const category = JSON.parse(readFileSync(join(SCHEMA_DIR, 'core', 'categories', rel), 'utf8')) as {
        properties: Record<string, unknown>;
      };
      expected.push(...Object.keys(category.properties));
    }
    expect(columns.map((c) => c.name)).toEqual(expected);

    // Committed CSV headers mirror the derived order (valid lacks the extra column).
    const valid = parseDelimited(readFileSync(join(DATA_DIR, 'hesp_valid_100.csv'), 'utf8'));
    expect(valid.header).toEqual(expected);
  });

  it('committed valid file has zero seeded violations', () => {
    const set = loadSchemaSet(SCHEMA_DIR);
    const columns = deriveColumns(set);
    const conditionals = deriveConditionals(set);
    expect(conditionals.length).toBe(171);
    const parsed = parseDelimited(readFileSync(join(DATA_DIR, 'hesp_valid_100.csv'), 'utf8'));
    expect(parsed.rows.length).toBe(BASE_ROWS);
    const findings = checkRows(typeCsvRows(parsed, columns), columns, conditionals);
    expect([...findings]).toEqual([]);
  });

  it('dirty checker findings equal the logged schema-level expectations', () => {
    const set = loadSchemaSet(SCHEMA_DIR);
    const columns = deriveColumns(set);
    const conditionals = deriveConditionals(set);
    const parsed = parseDelimited(readFileSync(join(DATA_DIR, 'hesp_dirty_100.csv'), 'utf8'));
    const dataHeader = parsed.header.filter((h) => h !== EXTRA_COLUMN);
    expect(dataHeader.length).toBe(265);
    const rows = typeCsvRows(parsed, columns);
    const log = readLog();
    const expected = new Set<string>();
    for (const inj of log.injections) {
      for (const id of inj.expectedRuleIds) {
        if (!id.startsWith('schema:')) continue;
        if (id.startsWith('schema:column:') || id.startsWith('schema:dataset:')) expected.add(`${id}@-`);
        else for (const row of inj.rows) expected.add(`${id}@${String(row)}`);
      }
    }
    const actual = checkRows(rows, columns, conditionals, [EXTRA_COLUMN]);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('xlsx re-reads with the right shape and injected values', { timeout: 60_000 }, async () => {
    const ExcelJS = require('exceljs') as typeof import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(DATA_DIR, 'hesp_dirty_100.xlsx'));
    const sheet = workbook.getWorksheet('hesp_dirty_100');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    const log = readLog();
    expect(sheet.rowCount).toBe(log.dirtyRows + 1); // + header
    expect(sheet.columnCount).toBe(log.columns);
    expect(sheet.getRow(1).getCell(1).value).toBe('record_id');
    const castInj = log.injections.find((i) => i.kind === 'cast-non-numeric');
    expect(castInj).toBeDefined();
    if (castInj?.column == null) return;
    let colIdx = -1;
    sheet.getRow(1).eachCell((cell, i) => {
      if (cell.value === castInj.column) colIdx = i;
    });
    expect(colIdx).toBeGreaterThan(0);
    expect(sheet.getRow(2 + (castInj.rows[0] ?? 0)).getCell(colIdx).value).toBe('twelve hundred');
  });

  it('parquet re-reads with the right shape', { timeout: 60_000 }, async () => {
    const duckdb = require('@duckdb/node-api') as typeof import('@duckdb/node-api');
    const instance = await duckdb.DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    const file = join(DATA_DIR, 'hesp_dirty_100.parquet').replace(/\\/g, '/');
    const count = await conn.runAndReadAll(`SELECT COUNT(*) FROM read_parquet('${file}')`);
    const log = readLog();
    expect(Number(count.getRows()[0]?.[0])).toBe(log.dirtyRows);
    const cols = await conn.runAndReadAll(`SELECT * FROM read_parquet('${file}') LIMIT 1`);
    expect(cols.columnNames().length).toBe(log.columns);
    conn.closeSync();
    instance.closeSync();
  });
});
