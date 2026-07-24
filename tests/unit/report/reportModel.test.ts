// Report model (qc-report-spec.md §5–§6): pure workbook layout — sister-column
// placement + collision escalation, merged review text, fills, truncation, and
// the content of sheets 2–5. No exceljs here (excelRoundtrip.test.ts pins that).
import { describe, expect, it } from 'vitest';
import {
  CELL_FLAG_CAP,
  EXCEL_MAX_CELL_CHARS,
  buildReportModel,
  reportFilename,
} from '../../../src/core/report/reportModel';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import { EXCEL_MAX_ROWS } from '../../../src/core/ingest/guardrails';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { FlagStore } from '../../../src/core/flags/flagStore';
import type { ColumnMeta } from '../../../src/core/schema/column-meta';
import type { ReportModelInput, RunInfoInput } from '../../../src/core/report/reportModel';
import type { RuleFile, RuleRunStat } from '../../../src/core/rules/types';
import type { ValidationSummary } from '../../../src/core/schema/worker-protocol';

const flag = (o: Partial<QCFlag>): QCFlag => ({
  source: 'rules',
  ruleId: 'R1',
  scope: 'cell',
  row: 0,
  column: 'a',
  severity: 'error',
  message: 'bad value',
  ...o,
});

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

const runInfo = (o: Partial<RunInfoInput> = {}): RunInfoInput => ({
  appVersion: '1.2.3',
  runAt: new Date('2026-07-24T09:05:00Z'),
  datasetName: 'hesp_dirty_100.csv',
  datasetFormat: 'csv',
  schemaFiles: [],
  ruleFileSummaries: [],
  durations: [{ stage: 'prepare', ms: 12 }],
  correctionsApplied: true,
  caps: [],
  stageErrors: [],
  ...o,
});

const input = (o: Partial<ReportModelInput> & { flagStore: FlagStore }): ReportModelInput => ({
  datasetColumns: ['a', 'b'],
  rowCount: 3,
  columnMeta: null,
  ruleFiles: [],
  rules: null,
  schema: null,
  runInfo: runInfo(),
  ...o,
});

const headers = (model: ReturnType<typeof buildReportModel>): string[] =>
  model.data.columns.map((c) => c.header);

describe('buildReportModel — Sheet 1 layout', () => {
  it('inserts a sister right of each flagged column; clean columns get none', () => {
    const store = createFlagStore();
    store.add([flag({ column: 'a', row: 0 })]);
    const model = buildReportModel(input({ flagStore: store, datasetColumns: ['a', 'b'] }));
    expect(headers(model)).toEqual(['a', 'a__review', 'b']);
    expect(model.data.columns[1]).toMatchObject({ kind: 'review', source: 'a' });
  });

  it('escalates the sister name when <col>__review already exists as a source column', () => {
    const store = createFlagStore();
    store.add([flag({ column: 'age', row: 0 })]);
    const model = buildReportModel(
      input({ flagStore: store, datasetColumns: ['age', 'age__review', 'name'] }),
    );
    // 'age__review' is a real column → the sister for 'age' escalates to _2.
    expect(headers(model)).toEqual(['age', 'age__review_2', 'age__review', 'name']);
  });

  it('places __row_review as column A only when a row-scope flag exists', () => {
    const noRow = createFlagStore();
    noRow.add([flag({ column: 'a', row: 0 })]);
    expect(headers(buildReportModel(input({ flagStore: noRow })))[0]).toBe('a');

    const withRow = createFlagStore();
    withRow.add([flag({ scope: 'row', row: 1, column: undefined, ruleId: 'ROWR' })]);
    const model = buildReportModel(input({ flagStore: withRow }));
    expect(model.data.columns[0]).toMatchObject({ header: '__row_review', kind: 'row-review' });
  });

  it('column-scope flags tint the source header and create no sister', () => {
    const store = createFlagStore();
    store.add([
      flag({ scope: 'column', column: 'b', row: undefined, severity: 'warning', ruleId: 'COL' }),
    ]);
    const model = buildReportModel(input({ flagStore: store, datasetColumns: ['a', 'b'] }));
    expect(headers(model)).toEqual(['a', 'b']); // no b__review
    expect(model.data.columns[1]).toMatchObject({ header: 'b', headerFill: 'warning' });
  });
});

describe('buildReportModel — merged review text + fills', () => {
  it('joins with "; " in pipeline order and caps at 8 flags with (+N more)', () => {
    const store = createFlagStore();
    for (let i = 1; i <= 10; i++) {
      store.add([flag({ ruleId: `R${String(i).padStart(2, '0')}`, row: 0, column: 'a', message: 'm' })]);
    }
    const text = buildReportModel(input({ flagStore: store })).data.decorations.get(0)?.reviews.get('a');
    expect(text).toBe(
      'R01: m; R02: m; R03: m; R04: m; R05: m; R06: m; R07: m; R08: m (+2 more)',
    );
    expect(text?.split('; ').length).toBe(CELL_FLAG_CAP);
  });

  it('guards the 32,767-char cell limit with a truncated marker', () => {
    const store = createFlagStore();
    store.add([flag({ ruleId: 'R1', row: 0, column: 'a', message: 'x'.repeat(40_000) })]);
    const text = buildReportModel(input({ flagStore: store })).data.decorations.get(0)?.reviews.get('a') ?? '';
    expect(text.length).toBe(EXCEL_MAX_CELL_CHARS);
    expect(text.endsWith('… (truncated)')).toBe(true);
  });

  it('fills corrected-only cells green and mixed cells by max severity', () => {
    const store = createFlagStore();
    store.add([
      flag({ ruleId: 'Q1', row: 0, column: 'a', severity: 'info', correction: { before: 999, after: -999 } }),
      flag({ ruleId: 'Q1', row: 1, column: 'a', severity: 'info', correction: { before: 1, after: 2 } }),
      flag({ ruleId: 'E1', row: 1, column: 'a', severity: 'error' }),
    ]);
    const decorations = buildReportModel(input({ flagStore: store })).data.decorations;
    expect(decorations.get(0)?.fills.get('a')).toBe('corrected');
    expect(decorations.get(1)?.fills.get('a')).toBe('error');
  });

  it('merges row-scope flags into the __row_review decoration', () => {
    const store = createFlagStore();
    store.add([
      flag({ scope: 'row', row: 2, column: undefined, ruleId: 'H005', message: 'duplicate key' }),
    ]);
    const dec = buildReportModel(input({ flagStore: store })).data.decorations.get(2);
    expect(dec?.rowReview).toBe('H005: duplicate key');
  });
});

describe('buildReportModel — truncation', () => {
  it('caps rows at EXCEL_MAX_ROWS and emits a note when the dataset is larger', () => {
    const store = createFlagStore();
    const model = buildReportModel(input({ flagStore: store, rowCount: EXCEL_MAX_ROWS + 5 }));
    expect(model.data.rowLimit).toBe(EXCEL_MAX_ROWS);
    expect(model.data.truncated).toBe(true);
    expect(model.data.truncationNote).toContain('more rows not shown');
  });

  it('does not truncate at or below the limit', () => {
    const model = buildReportModel(input({ flagStore: createFlagStore(), rowCount: EXCEL_MAX_ROWS }));
    expect(model.data.truncated).toBe(false);
    expect(model.data.truncationNote).toBeUndefined();
  });
});

describe('buildReportModel — Sheet 2 missing variables', () => {
  it('lists schema variables absent from the data, required first', () => {
    const model = buildReportModel(
      input({
        flagStore: createFlagStore(),
        datasetColumns: ['a'],
        columnMeta: [
          colMeta({ name: 'a' }),
          colMeta({ name: 'income', title: 'Income', required: true, group: 'money' }),
          colMeta({ name: 'note', description: 'a note' }),
        ],
      }),
    );
    expect(model.missingVariables.map((m) => m.variable)).toEqual(['income', 'note']);
    expect(model.missingVariables[0]).toMatchObject({ title: 'Income', group: 'money', required: true });
  });

  it('is empty when no schema is loaded', () => {
    expect(buildReportModel(input({ flagStore: createFlagStore() })).missingVariables).toEqual([]);
  });
});

describe('buildReportModel — Sheet 3 dataset findings', () => {
  it('includes dataset/column flags and broken/skipped/external rule statuses, errors first', () => {
    const store = createFlagStore();
    store.add([
      flag({ source: 'schema', ruleId: 'schema:dataset:duplicate-records', scope: 'dataset', row: undefined, column: undefined, severity: 'error', message: 'identical records found' }),
      flag({ source: 'schema', ruleId: 'schema:column:notes:unexpected', scope: 'column', row: undefined, column: 'notes', severity: 'warning', message: "Column 'notes' is not in the schema" }),
    ]);
    const rules = {
      perRule: [
        { ruleId: 'Q044', status: 'skipped-external', violationCount: 0, flagsEmitted: 0, truncated: false, durationMs: 0 },
        { ruleId: 'Q099', status: 'broken', violationCount: 0, flagsEmitted: 0, truncated: false, durationMs: 0, error: 'boom' },
        { ruleId: 'Q003', status: 'ok', violationCount: 5, flagsEmitted: 5, truncated: false, durationMs: 1 },
      ] as RuleRunStat[],
      correctedCells: 0,
      aborted: false,
    };
    const findings = buildReportModel(input({ flagStore: store, rules })).datasetFindings;
    const byRule = new Map(findings.map((f) => [f.ruleId, f]));
    expect(byRule.get('schema:dataset:duplicate-records')?.scope).toBe('dataset');
    expect(byRule.get('schema:column:notes:unexpected')?.column).toBe('notes');
    expect(byRule.get('Q099')?.message).toBe('Rule failed to execute: boom');
    expect(byRule.get('Q044')?.message).toContain('external reference data');
    expect(byRule.has('Q003')).toBe(false); // ok rules are not findings
    // errors before warnings before info.
    expect(findings[0]?.severity).toBe('error');
    const severities = findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]));
  });
});

describe('buildReportModel — Sheet 4 repeat offenders', () => {
  it('ranks on EXACT counts (violationCount ∪ schema counts), count desc', () => {
    const store = createFlagStore();
    // Q003 spans 2 target columns → 2 flags/violation inflates its flag count,
    // but its exact violationCount is smaller than schema rule's exact count.
    store.add([
      flag({ ruleId: 'Q003', row: 0, column: 'a' }),
      flag({ ruleId: 'Q003', row: 0, column: 'b' }),
      flag({ source: 'schema', ruleId: 'schema:prop:x:value', row: 1, column: 'x' }),
    ]);
    const rules = {
      perRule: [{ ruleId: 'Q003', status: 'ok', violationCount: 3, flagsEmitted: 6, truncated: false, durationMs: 1 }] as RuleRunStat[],
      correctedCells: 0,
      aborted: false,
    };
    const schema: ValidationSummary = {
      rowsTotal: 10,
      rowsWithErrors: 9,
      flagsEmitted: 9,
      flagsTruncated: false,
      countsByRuleId: { 'schema:prop:x:value': 9 },
      elapsedMs: 1,
      aborted: false,
    };
    const ruleFiles: RuleFile[] = [
      {
        name: 'r.quac.csv',
        group: 'r',
        extraColumns: [],
        rules: [
          {
            ruleId: 'Q003', ruleType: 'validate', ruleScope: 'row', targetVariables: ['a', 'b'],
            condition: '', updateLanguage: 'sql', updateExpression: '', severity: 'error',
            comment: 'record_id must decompose', enabled: true, sourceFile: 'r', rowNumber: 1, extras: {},
          },
        ],
      },
    ];
    const offenders = buildReportModel(
      input({ flagStore: store, rowCount: 10, rules, schema, ruleFiles }),
    ).repeatOffenders;
    expect(offenders.map((o) => o.ruleId)).toEqual(['schema:prop:x:value', 'Q003']);
    expect(offenders[1]).toMatchObject({ count: 3, targets: 'a, b', comment: 'record_id must decompose' });
    expect(offenders[0]).toMatchObject({ count: 9, targets: 'x' });
  });
});

describe('buildReportModel — Sheet 5 run info + filename', () => {
  it('reports version, dataset, corrections and stage durations', () => {
    const model = buildReportModel(
      input({
        flagStore: createFlagStore(),
        rules: { perRule: [], correctedCells: 27, aborted: false },
        runInfo: runInfo({ schemaFiles: ['core.schema.json'], schemaRoot: 'core/core.schema.json' }),
      }),
    );
    const info = new Map(model.runInfo.filter((r) => r.label !== '').map((r) => [r.label, r.value]));
    expect(info.get('QuaC version')).toBe('1.2.3');
    expect(info.get('Cells corrected')).toBe('27');
    expect(model.runInfo.some((r) => r.label === '  root' && r.value === 'core/core.schema.json')).toBe(true);
  });

  it('formats the filename as quac-report_<stem>_<YYYYMMDD-HHmm>.xlsx', () => {
    const name = reportFilename('hesp dirty.csv', new Date(2026, 6, 24, 9, 5));
    expect(name).toBe('quac-report_hesp_dirty_20260724-0905.xlsx');
  });
});
