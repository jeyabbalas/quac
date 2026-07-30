/**
 * The §7 summary (`src/cli/summary.ts`), field by field, from a synthetic
 * `RunQuacResult` — no DuckDB, no fixtures, so every value asserted here is
 * one this file put in.
 *
 * Two things are worth more than the field list: the six places where §7's
 * JSON name differs from the source type's field name (a silent rename is a
 * silent breakage for anyone reading this with `jq`), and that the result
 * survives `JSON.stringify` — the source types carry two `ReadonlyMap`s, a
 * `Date` and an arbitrary thrown `cause`, none of which may reach the output.
 */
import { describe, expect, it } from 'vitest';
import { buildSummary } from '../../../src/cli/summary';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import type { SummaryContext } from '../../../src/cli/summary';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { RunArtifacts } from '../../../src/core/pipeline';
import type { ReportModel } from '../../../src/core/report/reportModel';
import type { RuleFileLintResult } from '../../../src/core/rules/types';
import type { RunQuacResult } from '../../../src/headless/run';
import type { SchemaSet } from '../../../src/core/schema/types';

const CTX: SummaryContext = {
  quacVersion: '1.2.3',
  exitCode: 6,
  generatedAt: '2026-07-30T12:00:00.000Z',
};

function cell(row: number, column: string, ruleId: string, over: Partial<QCFlag> = {}): QCFlag {
  return { source: 'rules', ruleId, scope: 'cell', row, column, severity: 'error', message: 'x', ...over };
}

/** A result with something in every field §7 reads. */
function result(over: { rules?: RuleFileLintResult[]; schemaSet?: SchemaSet | null } = {}): RunQuacResult {
  const flagStore = createFlagStore();
  flagStore.add([
    cell(0, 'age', 'R001'),
    cell(0, 'score', 'R002', { severity: 'warning' }),
    cell(4, 'age', 'R001'),
    { source: 'rules', ruleId: 'R003', scope: 'dataset', severity: 'info', message: 'note' },
  ]);

  const artifacts: RunArtifacts = {
    flagStore,
    rules: {
      perRule: [
        {
          ruleId: 'R001',
          status: 'ok',
          violationCount: 2,
          flagsEmitted: 2,
          truncated: false,
          durationMs: 12.5,
          changedCells: 3,
        },
        {
          ruleId: 'R009',
          status: 'broken',
          violationCount: 0,
          flagsEmitted: 0,
          truncated: false,
          durationMs: 1,
          error: 'Binder Error: nope',
        },
      ],
      correctedCells: 7,
      aborted: false,
    },
    schema: {
      rowsTotal: 12,
      rowsWithErrors: 2,
      flagsEmitted: 3,
      flagsTruncated: false,
      countsByRuleId: { 'schema:prop:age:value': 3 },
      elapsedMs: 44,
      aborted: false,
    },
    cancelled: false,
    stageErrors: [{ stage: 'annotate', message: 'grid failed', cause: new Error('boom') }],
    durations: { prepare: 1, schema: 2, rules: 3 },
    rowsTotal: 12,
    correctionsApplied: true,
    inputs: { schemaProvided: true, ruleFileCount: 1 },
  };

  const model = {
    data: { columns: [], decorations: [], rowLimit: 12, truncated: true },
    missingVariables: [
      { variable: 'tenure', title: 'Tenure', description: 'Housing tenure', group: 'housing', required: true },
    ],
    datasetFindings: [],
    repeatOffenders: [],
    runInfo: [],
    filename: 'quac-report_people_20260730-1200.xlsx',
  } as unknown as ReportModel;

  const schemaSet =
    over.schemaSet === undefined
      ? ({
          schemas: [{ relativePath: 'core/core.schema.json' }, { relativePath: 'common/defs.json' }],
          files: [{ fileId: 'core/core.schema.json', relativePath: 'core/core.schema.json' }],
          root: { rootFileId: 'core/core.schema.json', indexFileId: 'https://x/core.schema.json' },
          errors: [
            { code: 'E_PARSE', severity: 'fatal', message: 'never reaches the summary' },
            { code: 'W_INDEX_BASENAME', severity: 'warning', message: 'matched by file name only.' },
          ],
          // The two Maps that must not reach JSON.
          idIndex: new Map([['a', 'b']]),
          pathIndex: new Map([['c', 'd']]),
        } as unknown as SchemaSet)
      : over.schemaSet;

  return {
    outPath: '/abs/out/quac-report_people_20260730-1200.xlsx',
    artifacts,
    model,
    inputs: {
      dataset: {
        path: 'data/people.csv',
        name: 'people.csv',
        format: 'csv',
        sheet: null,
        rows: 12,
        columns: 5,
        sizeVerdict: 'ok',
      },
      schema: schemaSet === null ? null : { set: schemaSet, digest: { meta: [] } as never },
      rules: over.rules ?? [
        {
          file: 'people_rules.quac.csv',
          ok: false,
          ruleCount: 6,
          executable: 4,
          issues: [
            { severity: 'error', code: 'sql-error', file: 'f', ruleId: 'R003', rowNumber: 3, message: 'a' },
            { severity: 'error', code: 'sql-error', file: 'f', ruleId: 'R005', rowNumber: 5, message: 'b' },
            { severity: 'warning', code: 'pertinence', file: 'f', ruleId: 'R006', rowNumber: 6, message: 'c' },
          ],
        },
      ],
      applyCorrections: true,
      pertinence: { edges: [], verdict: 'ok', weakest: null, suspect: null },
    },
  };
}

describe('buildSummary — §7 field by field', () => {
  it('stamps the envelope from its context, never from a clock', () => {
    const s = buildSummary(result(), CTX);
    expect(s.summarySchemaVersion).toBe(1);
    expect(s.quacVersion).toBe('1.2.3');
    expect(s.generatedAt).toBe('2026-07-30T12:00:00.000Z');
    expect(s.exitCode).toBe(6);
  });

  it('reports the dataset as ingested', () => {
    expect(buildSummary(result(), CTX).dataset).toEqual({
      path: 'data/people.csv',
      name: 'people.csv',
      format: 'csv',
      sheet: null,
      rows: 12,
      columns: 5,
    });
  });

  it('reports the schema set, keeping warnings and dropping fatals', () => {
    // Fatals already threw before a report existed; what is left is advice.
    expect(buildSummary(result(), CTX).inputs.schema).toEqual({
      files: ['core/core.schema.json', 'common/defs.json'],
      root: 'core/core.schema.json',
      index: 'https://x/core.schema.json',
      loadWarnings: ['matched by file name only.'],
    });
  });

  it('is null under inputs.schema when no schema was loaded', () => {
    const s = buildSummary(result({ schemaSet: null }), CTX);
    expect(s.inputs.schema).toBeNull();
  });

  it('renames the four lint fields §7 does not share with RuleFileLintResult', () => {
    // name ← file, rules ← ruleCount, lintErrors ← error-severity issues,
    // excludedRuleIds ← the rules those errors took out of the run.
    expect(buildSummary(result(), CTX).inputs.rules).toEqual([
      {
        name: 'people_rules.quac.csv',
        rules: 6,
        lintErrors: 2,
        excludedRuleIds: ['R003', 'R005'],
      },
    ]);
  });

  it('excludes no rule id for a file-level structural error', () => {
    // executableRuleFile drops the WHOLE file when an error carries no
    // rowNumber, which no list of ids can express — so the list stays empty
    // while lintErrors still counts it.
    const s = buildSummary(
      result({
        rules: [
          {
            file: 'broken.quac.csv',
            ok: false,
            ruleCount: 3,
            executable: 0,
            issues: [{ severity: 'error', code: 'missing-header', file: 'broken.quac.csv', message: 'no header' }],
          },
        ],
      }),
      CTX,
    );
    expect(s.inputs.rules[0]).toEqual({
      name: 'broken.quac.csv',
      rules: 3,
      lintErrors: 1,
      excludedRuleIds: [],
    });
  });

  it('renames truncated → flagsTruncated and carries the exact rowsAffected', () => {
    const s = buildSummary(result(), CTX);
    expect(s.severityTotals).toEqual({ error: 2, warning: 1, info: 1 });
    expect(s.flagsTruncated).toBe(false);
    // Rows 0 and 4 carry flags; row 0 twice. The dataset-scope flag has no row.
    expect(s.rowsAffected).toBe(2);
    expect(s.correctedCells).toBe(7);
  });

  it('keeps per-rule stats exact and drops the fields §7 does not name', () => {
    const s = buildSummary(result(), CTX);
    expect(s.perRule).toEqual([
      { ruleId: 'R001', status: 'ok', violationCount: 2, flagsEmitted: 2, truncated: false, durationMs: 12.5 },
      { ruleId: 'R009', status: 'broken', violationCount: 0, flagsEmitted: 0, truncated: false, durationMs: 1 },
    ]);
    // changedCells and error are engine detail, not summary fields.
    expect(Object.keys(s.perRule[0] ?? {})).not.toContain('changedCells');
    expect(Object.keys(s.perRule[1] ?? {})).not.toContain('error');
  });

  it('copies the schema leg whole, countsByRuleId included', () => {
    expect(buildSummary(result(), CTX).schema).toEqual({
      rowsTotal: 12,
      rowsWithErrors: 2,
      flagsEmitted: 3,
      flagsTruncated: false,
      countsByRuleId: { 'schema:prop:age:value': 3 },
      elapsedMs: 44,
      aborted: false,
    });
  });

  it('renames MissingVarRow.variable → name and keeps the description', () => {
    expect(buildSummary(result(), CTX).missingVariables).toEqual([
      { name: 'tenure', description: 'Housing tenure' },
    ]);
  });

  it('reports stage errors without their thrown cause, and the durations', () => {
    const s = buildSummary(result(), CTX);
    expect(s.stageErrors).toEqual([{ stage: 'annotate', message: 'grid failed' }]);
    expect(s.durations).toEqual({ prepare: 1, schema: 2, rules: 3 });
  });

  it('reports the absolute report path and whether Sheet 1 truncated', () => {
    expect(buildSummary(result(), CTX).report).toEqual({
      path: '/abs/out/quac-report_people_20260730-1200.xlsx',
      dataRowsTruncated: true,
    });
  });
});

describe('buildSummary — it has to survive JSON', () => {
  it('round-trips through stringify unchanged', () => {
    // The source types carry two ReadonlyMaps (countsByRuleId/countsByColumn),
    // two Maps on SchemaSet, and StageError.cause — an arbitrary thrown value
    // that may be an Error or circular. None may reach the output.
    const s = buildSummary(result(), CTX);
    const round: unknown = JSON.parse(JSON.stringify(s));
    expect(round).toEqual(s);
    const text = JSON.stringify(s);
    expect(text).not.toContain('idIndex');
    expect(text).not.toContain('cause');
    expect(text).not.toContain('boom');
  });

  it('emits every §7 key, and only those', () => {
    expect(Object.keys(buildSummary(result(), CTX)).sort()).toEqual([
      'correctedCells',
      'dataset',
      'durations',
      'exitCode',
      'flagsTruncated',
      'generatedAt',
      'inputs',
      'missingVariables',
      'perRule',
      'quacVersion',
      'report',
      'rowsAffected',
      'schema',
      'severityTotals',
      'stageErrors',
      'summarySchemaVersion',
    ]);
  });
});
