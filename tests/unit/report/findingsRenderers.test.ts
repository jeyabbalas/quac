/**
 * The findings' two renderers (findingsMarkdown.ts, findingsWorkbook.ts) over
 * a hand-built `QcFindings`: what each section says, that schema text cannot
 * break the Markdown (a pipe in a pattern, a backtick, an underscore), that
 * the same findings render the same text, and that the workbook's four sheets
 * carry the document cell for cell.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { code, prose, renderFindingsMarkdown } from '../../../src/core/report/findingsMarkdown';
import { writeFindingsWorkbook } from '../../../src/core/report/findingsWorkbook';
import type {
  QcFindings,
  RuleFinding,
  SchemaCheckFinding,
} from '../../../src/core/report/findings';

function check(over: Partial<SchemaCheckFinding> = {}): SchemaCheckFinding {
  return {
    level: 'value',
    variable: 'record_id',
    variableTitle: 'Record ID',
    path: null,
    requirement: 'must match `^HH[0-9]{8}_W(0[1-9]|1[0-9])$` (Household id)',
    keyword: 'pattern',
    schemaValue: '^HH[0-9]{8}_W(0[1-9]|1[0-9])$',
    location: { file: 'common/defs.json', pointer: '/$defs/record_id/pattern' },
    severity: 'error',
    records: 3,
    failures: 3,
    percentOfRecords: 3,
    ruleId: 'schema:prop:record_id:value',
    ...over,
  };
}

function rule(over: Partial<RuleFinding> = {}): RuleFinding {
  return {
    ruleId: 'Q002',
    file: 'keys.quac.csv',
    row: 2,
    type: 'validate',
    scope: 'row',
    severity: 'error',
    variables: ['household_id', 'wave'],
    description: 'Duplicate household_id + wave combination.',
    condition: 'COUNT(*) OVER (PARTITION BY household_id, wave) > 1',
    outcome: 'failed',
    reason: null,
    records: 4,
    percentOfRecords: 4,
    recordsExact: true,
    resultRows: null,
    valuesChanged: null,
    byVariable: null,
    ...over,
  };
}

function findings(over: Partial<QcFindings> = {}): QcFindings {
  return {
    findingsSchemaVersion: 1,
    containsData: false,
    generator: { name: 'QuaC', version: '1.2.0', homepage: 'https://jeyabbalas.github.io/quac/' },
    generatedAt: '2026-10-12T14:03:27.511Z',
    dataset: { name: 'hesp.csv', format: 'csv', sheet: null, records: 100, variables: 266 },
    inputs: {
      schema: {
        root: 'core/core.schema.json',
        files: ['common/defs.json', 'core/core.schema.json'],
        baseUrl: null,
        setId: 'abc123',
        title: 'HESP',
        id: null,
      },
      rules: [{ file: 'keys.quac.csv', rules: 3, source: null }],
      correctionsApplied: true,
    },
    overview: {
      records: 100,
      recordsWithErrors: 7,
      recordsWithWarnings: 1,
      recordsExact: true,
      schemaChecksFailed: 2,
      rules: { total: 3, failed: 1, passed: 1, corrected: 0, errored: 0, notRun: 1 },
      valuesCorrected: 0,
      missingVariables: { required: 1, optional: 0 },
      columnsNotInSchema: 0,
    },
    schemaChecks: [
      check({
        level: 'variable',
        variable: 'interview_date',
        variableTitle: null,
        requirement:
          'must be in the dataset — the schema requires it, and the dataset has no such column',
        keyword: 'required',
        schemaValue: undefined,
        location: { file: 'core/core.schema.json', pointer: '/items/properties/interview_date' },
        records: null,
        failures: 1,
        percentOfRecords: null,
        ruleId: 'schema:column:interview_date:missing',
      }),
      check(),
    ],
    rules: [
      rule(),
      rule({ ruleId: 'Q007', row: 3, outcome: 'passed', records: 0, percentOfRecords: 0 }),
      rule({
        ruleId: 'Q044',
        row: 4,
        type: 'external',
        outcome: 'not-evaluated',
        reason: 'needs external reference data',
        records: null,
      }),
    ],
    notes: [
      { kind: 'schema-comment', text: 'core/core.schema.json: Soft check: a_b should equal c.' },
    ],
    ...over,
  };
}

describe('Markdown: pieces that cannot break', () => {
  it('fences code with more backticks than it holds', () => {
    expect(code('a')).toBe('`a`');
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`edge')).toBe('`` `edge ``');
  });

  it('escapes only what Markdown would misread, keeping code spans as code', () => {
    expect(prose('household_id stays, _W gets escaped')).toBe(
      'household_id stays, \\_W gets escaped',
    );
    expect(prose('a*b and <b>tag</b> and [x](y)')).toBe('a\\*b and \\<b>tag\\</b> and \\[x](y)');
    expect(prose('must match `^[a-z]*_$` exactly')).toBe('must match `^[a-z]*_$` exactly');
    expect(prose('# not a heading')).toBe('\\# not a heading');
    expect(prose('x <= y')).toBe('x <= y');
  });
});

describe('Markdown: the document', () => {
  const md = renderFindingsMarkdown(findings());

  it('opens by saying what it holds and that it holds no data', () => {
    expect(md.startsWith('# QC findings: hesp.csv\n\n')).toBe(true);
    expect(md).toContain('**They contain no data:** no value from any record appears here');
    expect(md).toContain(
      '| JSON Schema | HESP: `core/core.schema.json` and 1 more file (set `abc123`) |',
    );
  });

  it('puts a pipe inside a pattern behind a backslash, so the table holds', () => {
    expect(md).toContain(
      '| `record_id` | Must match `^HH[0-9]{8}_W(0[1-9]\\|1[0-9])$` (Household id) | 3 (3.0%) | `common/defs.json#/$defs/record_id/pattern` |',
    );
  });

  it('lists a missing variable with its severity and declaration', () => {
    expect(md).toContain(
      '| `interview_date` | error | Must be in the dataset — the schema requires it, and the dataset has no such column | `core/core.schema.json#/items/properties/interview_date` |',
    );
  });

  it('gives a failed rule a row, then its definition with the SQL fenced', () => {
    // An underscore inside a word is no emphasis: it stays as written.
    expect(md).toContain(
      '| `Q002` | error | 4 records (4.0%) | Duplicate household_id + wave combination. |',
    );
    expect(md).toContain('##### `Q002` · error · 4 records (4.0%)');
    expect(md).toContain(
      '`keys.quac.csv`, row 2 · validate, row scope · variables `household_id`, `wave`',
    );
    expect(md).toContain('```sql\nCOUNT(*) OVER (PARTITION BY household_id, wave) > 1\n```');
  });

  it('lists rules that did not run with why, and those that passed by id', () => {
    expect(md).toContain(
      '| `Q044` | not evaluated | Needs external reference data | `keys.quac.csv`, row 4 |',
    );
    expect(md).toContain('### Rules that passed\n\n`Q007`');
  });

  it('keeps the schema files’ own notes apart', () => {
    expect(md).toContain(
      'Notes the schema files carry:\n\n- core/core.schema.json: Soft check: a_b should equal c.',
    );
  });

  it('renders the same findings to the same text', () => {
    expect(renderFindingsMarkdown(findings())).toBe(md);
    expect(md.endsWith('\n')).toBe(true);
  });

  it('says so when no schema or rules took part, or nothing failed', () => {
    const none = renderFindingsMarkdown(
      findings({
        inputs: { schema: null, rules: [], correctionsApplied: true },
        schemaChecks: [],
        rules: [],
        notes: [],
      }),
    );
    expect(none).toContain('No JSON Schema was loaded for this run.');
    expect(none).toContain('No QC rules were loaded for this run.');
    const clean = renderFindingsMarkdown(findings({ schemaChecks: [] }));
    expect(clean).toContain('None — the dataset passed every check the schema makes.');
  });

  it('marks record counts a cap cut short', () => {
    const capped = renderFindingsMarkdown(
      findings({
        overview: { ...findings().overview, recordsExact: false },
        rules: [rule({ records: 10_000, recordsExact: false, percentOfRecords: 10 })],
      }),
    );
    expect(capped).toContain('| Records failing an error-level check | 7 or more (7.0%) |');
    expect(capped).toContain('10,000 records or more (10.0%)');
  });
});

describe('Excel: the same document, four sheets', () => {
  it('writes Summary, Schema checks, QC rules and Notes, cell for cell', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await (await writeFindingsWorkbook(findings())).arrayBuffer());
    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'Schema checks',
      'QC rules',
      'Notes',
    ]);

    const checks = workbook.getWorksheet('Schema checks');
    expect(checks?.getRow(1).values).toEqual([
      undefined,
      'Level',
      'Variable',
      'Title',
      'Path',
      'Check',
      'Keyword',
      'Schema value',
      'Severity',
      'Records',
      '% of records',
      'Failures',
      'Schema file',
      'JSON Pointer',
      'Rule ID',
    ]);
    const row = checks?.getRow(3);
    expect(row?.getCell(2).value).toBe('record_id');
    expect(row?.getCell(9).value).toBe(3);
    expect(row?.getCell(10).value).toBe(0.03); // 3 of 100 records, an exact ratio
    expect(checks?.getColumn(10).numFmt).toBe('0.0%');
    expect(checks?.getRow(3).getCell(8).fill).toMatchObject({ fgColor: { argb: 'FFFFC7CE' } });
    expect(checks?.autoFilter).toBe('A1:N3');

    const rules = workbook.getWorksheet('QC rules');
    expect(rules?.rowCount).toBe(4);
    expect(rules?.getRow(2).getCell(7).value).toBe('found problems');
    // A passing error-level rule is not tinted as an error.
    expect(rules?.getRow(3).getCell(6).fill).toBeUndefined();

    const summary = JSON.stringify(workbook.getWorksheet('Summary')?.getSheetValues());
    expect(summary).toContain('Contains no data');
    expect(summary).toContain('Records failing an error-level check');
  });
});
