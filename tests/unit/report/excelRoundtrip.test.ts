// Excel round-trip (qc-report-spec.md §5): write a model through exceljs, then
// re-read the bytes with exceljs and pin the styling the writer applies —
// sheet order, review text incl. the corrected suffix, severity fills on the
// right cells, frozen pane, autofilter, clamped widths. exceljs runs in node.
import { describe, expect, it } from 'vitest';
import { buildReportModel } from '../../../src/core/report/reportModel';
import { writeReportWorkbook } from '../../../src/core/report/excelWriter';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import type { FillPattern } from 'exceljs';
import type { ReportRowSource } from '../../../src/core/report/excelWriter';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { ColumnMeta } from '../../../src/core/schema/column-meta';
import type { RuleRunStat } from '../../../src/core/rules/types';

const DATASET_COLUMNS = ['record_id', 'wage_income_annual', 'age'];

const colMeta = (o: Partial<ColumnMeta> & { name: string }): ColumnMeta => ({
  required: false,
  jsonTypes: new Set(['string']),
  storageType: 'VARCHAR',
  mixed: false,
  valueSpec: { kind: 'opaque' },
  conditionals: { asTarget: [], asCondition: [] },
  source: { fileId: 'f', pointer: '/items' },
  ...o,
});

function buildFixtureModel(): ReturnType<typeof buildReportModel> {
  const store = createFlagStore();
  const flags: QCFlag[] = [
    {
      source: 'schema',
      ruleId: 'schema:prop:record_id:value',
      scope: 'cell',
      row: 0,
      column: 'record_id',
      severity: 'error',
      message: "'HH1234_W01' does not match the expected format",
    },
    {
      source: 'rules',
      ruleId: 'Q047',
      scope: 'cell',
      row: 1,
      column: 'wage_income_annual',
      severity: 'info',
      message: 'Legacy positive sentinel recoded',
      correction: { before: 999, after: -999 },
    },
  ];
  store.add(flags);
  return buildReportModel({
    flagStore: store,
    datasetColumns: DATASET_COLUMNS,
    rowCount: 3,
    columnMeta: [
      ...DATASET_COLUMNS.map((name) => colMeta({ name })),
      colMeta({ name: 'household_id', title: 'Household id', required: true }),
    ],
    ruleFiles: [],
    rules: {
      perRule: [
        { ruleId: 'Q099', status: 'broken', violationCount: 0, flagsEmitted: 0, truncated: false, durationMs: 0, error: 'boom' },
      ] as RuleRunStat[],
      correctedCells: 1,
      aborted: false,
    },
    schema: null,
    runInfo: {
      appVersion: '9.9.9',
      runAt: new Date('2026-07-24T09:05:00Z'),
      datasetName: 'hesp_dirty_100.csv',
      datasetFormat: 'csv',
      schemaFiles: ['core.schema.json'],
      ruleFileSummaries: [{ name: 'r.quac.csv', ruleCount: 1 }],
      durations: [{ stage: 'prepare', ms: 12 }],
      correctionsApplied: true,
      caps: [],
      stageErrors: [],
    },
  });
}

const rowSource: ReportRowSource = () =>
  (async function* () {
    await Promise.resolve();
    yield [
      { row: 0, values: { record_id: 'HH1234_W01', wage_income_annual: 43948, age: 40 } },
      { row: 1, values: { record_id: 'HH10000200_W01', wage_income_annual: -999, age: 41 } },
      { row: 2, values: { record_id: 'HH10000300_W01', wage_income_annual: 5000, age: 42 } },
    ];
  })();

async function writeAndReread(): Promise<import('exceljs').Workbook> {
  const model = buildFixtureModel();
  const blob = await writeReportWorkbook(model, rowSource);
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  return wb;
}

const argb = (fill: unknown): string | undefined => (fill as FillPattern | undefined)?.fgColor?.argb;

describe('writeReportWorkbook round-trip', () => {
  it('emits the five sheets in spec order', async () => {
    const wb = await writeAndReread();
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Data',
      'Missing Variables',
      'Dataset Findings',
      'Repeat Offenders',
      'Run Info',
    ]);
  });

  it('places sister review columns and writes merged review text with the corrected suffix', async () => {
    const wb = await writeAndReread();
    const ws = wb.getWorksheet('Data');
    if (ws === undefined) throw new Error('missing Data sheet');
    // Header order: source + sister interleaved, no __row_review (no row flags).
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual([
      'record_id',
      'record_id__review',
      'wage_income_annual',
      'wage_income_annual__review',
      'age',
    ]);
    // __row__ 0 → Excel row 2: record_id review text (col B).
    expect(ws.getCell('B2').text).toContain('schema:prop:record_id:value');
    // __row__ 1 → Excel row 3: wage review text (col D) carries the corrected suffix.
    expect(ws.getCell('D3').text).toContain('Q047:');
    expect(ws.getCell('D3').text).toContain('(corrected: 999 → -999)');
  });

  it('fills flagged source cells by severity / corrected on the right cells', async () => {
    const wb = await writeAndReread();
    const ws = wb.getWorksheet('Data');
    if (ws === undefined) throw new Error('missing Data sheet');
    expect(argb(ws.getCell('A2').fill)).toBe('FFFFC7CE'); // record_id error
    expect(argb(ws.getCell('C3').fill)).toBe('FFC6EFCE'); // wage corrected (source cell)
    // A clean cell carries no solid fill.
    expect(argb(ws.getCell('E2').fill)).toBeUndefined();
  });

  it('freezes row 1, sets an autofilter, and clamps widths to 10–40', async () => {
    const wb = await writeAndReread();
    const ws = wb.getWorksheet('Data');
    if (ws === undefined) throw new Error('missing Data sheet');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    for (let c = 1; c <= 5; c++) {
      const width = ws.getColumn(c).width ?? 0;
      expect(width).toBeGreaterThanOrEqual(10);
      expect(width).toBeLessThanOrEqual(40);
    }
  });

  it('carries Sheet 2–5 header rows and a broken-rule finding', async () => {
    const wb = await writeAndReread();
    const missing = wb.getWorksheet('Missing Variables');
    expect((missing?.getRow(1).values as unknown[]).slice(1)).toEqual([
      'Variable',
      'Title',
      'Description',
      'Variable group',
      'Required?',
    ]);
    expect(missing?.getCell('A2').text).toBe('household_id');

    const findings = wb.getWorksheet('Dataset Findings');
    const findingText = JSON.stringify(findings?.getSheetValues());
    expect(findingText).toContain('Rule failed to execute: boom');

    const runInfo = wb.getWorksheet('Run Info');
    const runText = JSON.stringify(runInfo?.getSheetValues());
    expect(runText).toContain('9.9.9');
  });
});
