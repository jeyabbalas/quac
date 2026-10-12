/**
 * The findings builder (core/report/findings.ts) over synthetic runs: the
 * shape of every rule outcome, the schema checks worded from the schema and
 * placed by file and pointer, the overview's record counts, the notes, and
 * the scrubbing of what an engine or a URL could otherwise carry.
 *
 * The end-to-end proof that no value reaches the findings is
 * findingsNoData.test.ts; this pins the parts.
 */
import { describe, expect, it } from 'vitest';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import {
  FINDINGS_SCHEMA_VERSION,
  brokenRuleReason,
  buildFindings,
  findingsFilename,
  shareableUrl,
} from '../../../src/core/report/findings';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { entry } from '../schema/helpers';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { FindingsInput, FindingsRuleFile } from '../../../src/core/report/findings';
import type { QCRule, RuleFileLintResult, RuleRunStat } from '../../../src/core/rules/types';
import type { SchemaCheckTally, ValidationSummary } from '../../../src/core/schema/worker-protocol';

const AT = new Date('2026-10-12T14:03:00.000Z');

function rule(over: Partial<QCRule> & Pick<QCRule, 'ruleId' | 'rowNumber'>): QCRule {
  return {
    ruleType: 'validate',
    ruleScope: 'row',
    targetVariables: ['a'],
    condition: 'a > 1',
    updateLanguage: 'sql',
    updateExpression: '',
    severity: 'error',
    comment: `Rule ${over.ruleId}.`,
    enabled: true,
    sourceFile: 'rules',
    extras: {},
    ...over,
  };
}

function ruleFile(
  name: string,
  rules: QCRule[],
  lint: RuleFileLintResult | null = null,
): FindingsRuleFile {
  return { file: { name, group: 'rules', rules, extraColumns: [] }, lint, source: null };
}

function stat(ruleId: string, over: Partial<RuleRunStat> = {}): RuleRunStat {
  return {
    ruleId,
    status: 'ok',
    violationCount: 0,
    flagsEmitted: 0,
    truncated: false,
    durationMs: 1,
    ...over,
  };
}

function flag(over: Partial<QCFlag> & Pick<QCFlag, 'ruleId'>): QCFlag {
  return {
    source: 'rules',
    scope: 'cell',
    severity: 'error',
    message: 'secret value 42',
    column: 'a',
    ...over,
  };
}

function input(
  over: Partial<FindingsInput> = {},
  run: Partial<FindingsInput['run']> = {},
): FindingsInput {
  return {
    generatedAt: AT,
    quacVersion: '9.9.9',
    dataset: {
      name: 'data.csv',
      format: 'csv',
      sheet: null,
      columns: ['a', 'b', 'c'],
      records: 10,
    },
    schema: null,
    ruleFiles: [],
    correctionsApplied: true,
    ...over,
    run: {
      cancelled: false,
      rules: { perRule: [], correctedCells: 0, aborted: false },
      schema: null,
      stageErrors: [],
      rows: createFlagStore(),
      ...run,
    },
  };
}

describe('the envelope', () => {
  it('says it holds no data, and which version of the document it is', () => {
    const f = buildFindings(input());
    expect(f.findingsSchemaVersion).toBe(FINDINGS_SCHEMA_VERSION);
    expect(f.findingsSchemaVersion).toBe(1);
    expect(f.containsData).toBe(false);
    expect(f.generator).toEqual({
      name: 'QuaC',
      version: '9.9.9',
      homepage: 'https://jeyabbalas.github.io/quac/',
    });
    expect(f.generatedAt).toBe('2026-10-12T14:03:00.000Z');
    expect(f.dataset).toEqual({
      name: 'data.csv',
      format: 'csv',
      sheet: null,
      records: 10,
      variables: 3,
    });
  });

  it('names its files after the QC report’s pattern', () => {
    const local = new Date(2026, 9, 12, 9, 5);
    expect(findingsFilename('hesp dirty.csv', local, 'markdown')).toBe(
      'quac-findings_hesp_dirty_20261012-0905.md',
    );
    expect(findingsFilename('x.parquet', local, 'json')).toBe('quac-findings_x_20261012-0905.json');
    expect(findingsFilename('x', local, 'xlsx')).toBe('quac-findings_x_20261012-0905.xlsx');
  });

  it('notes what the run was not handed', () => {
    const kinds = buildFindings(input()).notes.map((n) => n.kind);
    expect(kinds).toEqual(['no-schema', 'no-rules']);
  });
});

describe('what an engine or a URL could carry is scrubbed', () => {
  it('keeps a broken rule’s DuckDB error class, never its message', () => {
    expect(
      brokenRuleReason("Conversion Error: Could not convert string 'Ada Lovelace' to INT32"),
    ).toBe(
      'failed to execute — DuckDB reported a Conversion Error; the full QC report has its message',
    );
    expect(brokenRuleReason('Out of Range Error: value 31415926 is out of range')).toContain(
      'Out of Range Error',
    );
    expect(brokenRuleReason('Out of Range Error: value 31415926 is out of range')).not.toContain(
      '31415926',
    );
  });

  it('keeps QuaC’s own fixed sentences, minus the first error a JS function threw', () => {
    expect(brokenRuleReason('JS correction exceeded the 30000 ms per-rule sandbox budget')).toBe(
      'failed to execute — the JavaScript correction ran past its 30,000 ms budget',
    );
    const rate = brokenRuleReason(
      'JS correction failed on 5 of 100 rows (over the 1% limit); first error: Error: bad value Ada Lovelace',
    );
    expect(rate).toBe(
      'failed to execute — the JavaScript correction threw on 5 of 100 rows, over the 1% limit',
    );
    expect(
      brokenRuleReason('JS corrections require the QuickJS sandbox; rule not executed'),
    ).toContain('QuickJS');
  });

  it('says nothing of a message it does not recognise', () => {
    for (const message of ['TypeError: Ada Lovelace', 'Ada Lovelace', '', undefined]) {
      expect(brokenRuleReason(message)).toBe(
        'failed to execute — the full QC report has the engine’s message',
      );
    }
  });

  it('prints a URL without credentials, query or fragment', () => {
    expect(
      shareableUrl(
        'https://bucket.s3.amazonaws.com/s/core.json?X-Amz-Signature=abc&X-Amz-Expires=60',
      ),
    ).toBe('https://bucket.s3.amazonaws.com/s/core.json');
    expect(shareableUrl('https://user:pass@host.example/a/b.quac.csv#frag')).toBe(
      'https://host.example/a/b.quac.csv',
    );
    expect(shareableUrl('core/categories/income.json')).toBe('core/categories/income.json');
  });

  it('scrubs a rules file’s source URL', () => {
    const file = {
      ...ruleFile('r.quac.csv', [rule({ ruleId: 'R1', rowNumber: 1 })]),
      source: 'https://x.example/r.quac.csv?sig=s3cr3t',
    };
    const f = buildFindings(input({ ruleFiles: [file] }));
    expect(f.inputs.rules).toEqual([
      { file: 'r.quac.csv', rules: 1, source: 'https://x.example/r.quac.csv' },
    ]);
    expect(JSON.stringify(f)).not.toContain('s3cr3t');
  });
});

describe('rules: one finding per rule, in file order, each with its outcome', () => {
  it('words every outcome and counts in each scope’s own units', () => {
    const rows = createFlagStore();
    rows.add([
      flag({ ruleId: 'ROW', row: 1 }),
      flag({ ruleId: 'ROW', row: 2 }),
      flag({ ruleId: 'COL', row: 3, column: 'a' }),
      flag({ ruleId: 'COL', row: 3, column: 'b' }),
      flag({ ruleId: 'COL', row: 4, column: 'b' }),
      flag({ ruleId: 'FIX', row: 5, severity: 'info', correction: { before: 'x', after: 'y' } }),
      flag({
        ruleId: 'FIX',
        row: 5,
        column: 'b',
        severity: 'info',
        correction: { before: 'x', after: 'y' },
      }),
    ]);
    const files = [
      ruleFile('one.quac.csv', [
        rule({ ruleId: 'ROW', rowNumber: 1 }),
        rule({
          ruleId: 'COL',
          rowNumber: 2,
          ruleScope: 'column',
          targetVariables: ['a', 'b'],
          condition: 'no_nulls',
        }),
        rule({
          ruleId: 'DIST',
          rowNumber: 3,
          ruleScope: 'column',
          condition: 'count_distinct_in_range(1, 2)',
        }),
        rule({
          ruleId: 'SEL',
          rowNumber: 4,
          ruleScope: 'dataset',
          targetVariables: [],
          condition: 'SELECT 1',
        }),
        rule({
          ruleId: 'FIX',
          rowNumber: 5,
          ruleType: 'correct',
          updateExpression: 'upper(__value__)',
          severity: 'info',
        }),
        rule({ ruleId: 'PASS', rowNumber: 6 }),
      ]),
      ruleFile(
        'two.quac.csv',
        [
          rule({ ruleId: 'BAD', rowNumber: 1 }),
          rule({ ruleId: 'EXT', rowNumber: 2, ruleType: 'external' }),
          rule({ ruleId: 'OFF', rowNumber: 3, enabled: false }),
          rule({ ruleId: 'GONE', rowNumber: 4, targetVariables: ['zzz', 'a'] }),
          rule({ ruleId: 'LINT', rowNumber: 5 }),
        ],
        {
          file: 'two.quac.csv',
          ok: false,
          ruleCount: 5,
          executable: 4,
          issues: [
            {
              severity: 'error',
              code: 'sql-error',
              file: 'two.quac.csv',
              ruleId: 'LINT',
              rowNumber: 5,
              message: 'condition failed the SQL dry-run: a syntax error.',
            },
          ],
        },
      ),
    ];
    const perRule = [
      stat('FIX', { violationCount: 2, changedCells: 2 }),
      stat('ROW', { violationCount: 2 }),
      stat('COL', {
        violationCount: 3,
        byTarget: [
          { column: 'a', violations: 1 },
          { column: 'b', violations: 2 },
        ],
      }),
      stat('DIST', { violationCount: 1, byTarget: [{ column: 'a', violations: 1, distinct: 7 }] }),
      stat('SEL', { violationCount: 4 }),
      stat('PASS'),
      stat('BAD', {
        status: 'broken',
        error: "Conversion Error: Could not convert string 'Ada' to INT32",
      }),
      stat('EXT', { status: 'skipped-external' }),
      stat('OFF', { status: 'skipped-disabled' }),
      stat('GONE', { status: 'skipped-inapplicable' }),
    ];
    const f = buildFindings(
      input({ ruleFiles: files }, { rows, rules: { perRule, correctedCells: 2, aborted: false } }),
    );
    const by = new Map(f.rules.map((r) => [r.ruleId, r]));

    expect(f.rules.map((r) => r.ruleId)).toEqual([
      'ROW',
      'COL',
      'DIST',
      'SEL',
      'FIX',
      'PASS',
      'BAD',
      'EXT',
      'OFF',
      'GONE',
      'LINT',
    ]);
    expect(by.get('ROW')).toMatchObject({
      outcome: 'failed',
      records: 2,
      percentOfRecords: 20,
      resultRows: null,
    });
    // Three failures over a and b, but row 3 failed on both: two records.
    expect(by.get('COL')).toMatchObject({ outcome: 'failed', records: 2 });
    expect(by.get('COL')?.byVariable).toEqual([
      { variable: 'a', records: 1, failed: true },
      { variable: 'b', records: 2, failed: true },
    ]);
    expect(by.get('DIST')).toMatchObject({ outcome: 'failed', records: null });
    expect(by.get('DIST')?.byVariable).toEqual([
      { variable: 'a', records: null, distinctValues: 7, failed: true },
    ]);
    expect(by.get('SEL')).toMatchObject({ outcome: 'failed', records: null, resultRows: 4 });
    expect(by.get('FIX')).toMatchObject({ outcome: 'corrected', valuesChanged: 2, records: 1 });
    expect(by.get('PASS')).toMatchObject({ outcome: 'passed', records: 0 });
    expect(by.get('BAD')).toMatchObject({ outcome: 'error' });
    expect(by.get('BAD')?.reason).not.toContain('Ada');
    expect(by.get('EXT')).toMatchObject({
      outcome: 'not-evaluated',
      reason: 'needs external reference data',
    });
    expect(by.get('OFF')).toMatchObject({ outcome: 'disabled' });
    expect(by.get('GONE')).toMatchObject({ outcome: 'skipped', reason: 'not in the dataset: zzz' });
    expect(by.get('LINT')).toMatchObject({
      outcome: 'excluded',
      reason: 'excluded before the run: condition failed the SQL dry-run: a syntax error',
    });

    expect(f.overview.rules).toEqual({
      total: 11,
      failed: 4,
      passed: 1,
      corrected: 1,
      errored: 1,
      notRun: 4,
    });
    expect(f.overview.valuesCorrected).toBe(2);
    // ROW 1, 2 · COL 3, 4 at error level; FIX's row 5 is info.
    expect(f.overview.recordsWithErrors).toBe(4);
    expect(f.overview.recordsExact).toBe(true);
  });

  it('excludes a whole file a structural lint error kept out, and says so in a note', () => {
    const lint: RuleFileLintResult = {
      file: 'broken.quac.csv',
      ok: false,
      ruleCount: 2,
      executable: 0,
      issues: [
        {
          severity: 'error',
          code: 'missing-header',
          file: 'broken.quac.csv',
          message: 'The header has no condition column.',
        },
      ],
    };
    const f = buildFindings(
      input({
        ruleFiles: [
          ruleFile(
            'broken.quac.csv',
            [rule({ ruleId: 'X', rowNumber: 1 }), rule({ ruleId: 'Y', rowNumber: 2 })],
            lint,
          ),
        ],
      }),
    );
    expect(f.rules.map((r) => r.outcome)).toEqual(['excluded', 'excluded']);
    expect(f.notes).toContainEqual({
      kind: 'rules-file',
      text: 'broken.quac.csv did not run: The header has no condition column.',
    });
  });

  it('reads a correction the assess-only run skipped as not applied, and notes the mode', () => {
    const f = buildFindings(
      input(
        {
          correctionsApplied: false,
          ruleFiles: [
            ruleFile('r.quac.csv', [rule({ ruleId: 'FIX', rowNumber: 1, ruleType: 'correct' })]),
          ],
        },
        { rules: { perRule: [], correctedCells: 0, aborted: false } },
      ),
    );
    expect(f.rules[0]).toMatchObject({
      outcome: 'not-applied',
      reason: 'corrections were not applied in this run',
    });
    expect(f.notes.map((n) => n.kind)).toContain('assess-only');
  });

  it('says a cancelled run never reached a rule, and that its counts are partial', () => {
    const f = buildFindings(
      input(
        {
          ruleFiles: [
            ruleFile('r.quac.csv', [
              rule({ ruleId: 'R1', rowNumber: 1 }),
              rule({ ruleId: 'R2', rowNumber: 2 }),
            ]),
          ],
        },
        { cancelled: true, rules: { perRule: [stat('R1')], correctedCells: 0, aborted: true } },
      ),
    );
    expect(f.rules.map((r) => r.outcome)).toEqual(['passed', 'not-run']);
    expect(f.rules[1]?.reason).toBe('the run was cancelled before this rule');
    expect(f.notes[0]?.kind).toBe('cancelled');
  });

  it('gives two files that reuse an id each their own result', () => {
    const f = buildFindings(
      input(
        {
          ruleFiles: [
            ruleFile('a.quac.csv', [rule({ ruleId: 'R1', rowNumber: 1 })]),
            ruleFile('b.quac.csv', [rule({ ruleId: 'R1', rowNumber: 1 })]),
          ],
        },
        {
          rules: {
            perRule: [stat('R1', { violationCount: 3 }), stat('R1')],
            correctedCells: 0,
            aborted: false,
          },
        },
      ),
    );
    expect(f.rules.map((r) => [r.file, r.outcome, r.records])).toEqual([
      ['a.quac.csv', 'failed', 3],
      ['b.quac.csv', 'passed', 0],
    ]);
  });

  it('marks record counts a cap cut short as lower bounds', () => {
    const f = buildFindings(
      input(
        {
          ruleFiles: [
            ruleFile('r.quac.csv', [rule({ ruleId: 'C', rowNumber: 1, ruleScope: 'column' })]),
          ],
        },
        {
          rules: {
            perRule: [
              stat('C', {
                violationCount: 5,
                truncated: true,
                byTarget: [{ column: 'a', violations: 5 }],
              }),
            ],
            correctedCells: 0,
            aborted: false,
          },
        },
      ),
    );
    expect(f.rules[0]?.recordsExact).toBe(false);
    expect(f.overview.recordsExact).toBe(false);
    expect(f.notes.map((n) => n.kind)).toContain('records-lower-bound');
  });
});

// ---- schema checks over a real (small) schema set ----

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $comment: 'Soft check: b should exceed a.',
  type: 'array',
  uniqueItems: true,
  minItems: 50,
  items: {
    type: 'object',
    required: ['a', 'b', 'want'],
    properties: {
      a: { type: 'integer', title: 'Count of a', maximum: 9 },
      b: { $ref: 'defs.json#/$defs/code' },
      Mixed: { type: 'string' },
      opt: { type: 'string' },
      want: { type: 'string' },
      list: {
        type: 'array',
        items: { type: 'object', properties: { age: { type: 'integer', maximum: 120 } } },
      },
    },
    allOf: [
      {
        if: { properties: { a: { const: 1 } }, required: ['a'] },
        then: { properties: { b: { const: 'X' } } },
      },
    ],
    additionalProperties: false,
  },
};
const DEFS = {
  $defs: { code: { type: 'string', pattern: '^[A-Z]$', description: 'One capital letter.' } },
};

async function schemaInput() {
  const set = await buildSchemaSet([entry('root.json', SCHEMA), entry('defs.json', DEFS)], {
    origin: 'upload',
  });
  const digest = columnDigest(set);
  if (digest === null) throw new Error('no digest');
  return { set, digest };
}

const tally = (
  over: Partial<SchemaCheckTally> & Pick<SchemaCheckTally, 'ruleId'>,
): SchemaCheckTally => ({
  scope: 'cell',
  severity: 'error',
  count: 1,
  records: 1,
  ...over,
});

function summary(checks: SchemaCheckTally[]): ValidationSummary {
  return {
    rowsTotal: 10,
    rowsWithErrors: 1,
    flagsEmitted: 1,
    flagsTruncated: false,
    countsByRuleId: {},
    checks,
    elapsedMs: 1,
    aborted: false,
  };
}

describe('schema checks: worded from the schema, placed by file and pointer', () => {
  it('words each kind of check and orders dataset, then variables, then values', async () => {
    const schema = await schemaInput();
    const checks: SchemaCheckTally[] = [
      tally({
        ruleId: 'schema:prop:a:value',
        column: 'a',
        keyword: 'maximum',
        schemaPath: '#/properties/a/maximum',
        location: 'quac-set:/root.json#/items/properties/a/maximum',
        count: 3,
        records: 3,
      }),
      tally({
        ruleId: 'schema:prop:b:value',
        column: 'b',
        keyword: 'pattern',
        schemaPath: 'defs.json#/$defs/code/pattern',
        location: 'quac-set:/defs.json#/$defs/code/pattern',
      }),
      tally({
        ruleId: 'schema:cond:0:b',
        column: 'b',
        keyword: 'const',
        schemaPath: '#/allOf/0/then/properties/b/const',
        location: 'quac-set:/root.json#/items/allOf/0/then/properties/b/const',
        conditionalIndex: 0,
      }),
      tally({
        ruleId: 'schema:prop:list:value',
        column: 'list',
        keyword: 'maximum',
        schemaPath: '#/properties/list/items/properties/age/maximum',
        location: 'quac-set:/root.json#/items/properties/list/items/properties/age/maximum',
        count: 4,
        records: 2,
      }),
      tally({ ruleId: 'schema:prop:a:cast', column: 'a', count: 2, records: 2 }),
      tally({
        ruleId: 'schema:prop:b:required',
        column: 'b',
        keyword: 'required',
        schemaPath: '#/required',
        location: 'quac-set:/root.json#/items/required',
      }),
      tally({ ruleId: 'schema:column:want:missing', scope: 'column', column: 'want', records: 0 }),
      tally({
        ruleId: 'schema:column:opt:missing',
        scope: 'column',
        column: 'opt',
        severity: 'info',
        records: 0,
      }),
      tally({
        ruleId: 'schema:column:Mixed:case-mismatch',
        scope: 'column',
        column: 'Mixed',
        severity: 'warning',
        records: 0,
      }),
      tally({
        ruleId: 'schema:column:extra:unexpected',
        scope: 'column',
        column: 'extra',
        keyword: 'additionalProperties',
        schemaPath: '#/additionalProperties',
        location: 'quac-set:/root.json#/items/additionalProperties',
        records: 0,
      }),
      tally({ ruleId: 'schema:dataset:duplicate-records', scope: 'dataset', count: 2, records: 0 }),
      tally({ ruleId: 'schema:dataset:min-items', scope: 'dataset', records: 0 }),
      tally({
        ruleId: 'schema:advisory:root.json',
        scope: 'dataset',
        severity: 'info',
        records: 0,
      }),
      tally({ ruleId: 'schema:prop:a:precision', column: 'a', severity: 'warning' }),
    ];
    const f = buildFindings(
      input(
        {
          schema,
          dataset: {
            name: 'd.csv',
            format: 'csv',
            sheet: null,
            columns: ['a', 'b', 'mixed', 'list', 'extra'],
            records: 10,
          },
        },
        { schema: summary(checks) },
      ),
    );
    const rows = f.schemaChecks.map((c) => [
      c.level,
      c.variable,
      c.path,
      c.requirement,
      c.location === null ? null : `${c.location.file}#${c.location.pointer}`,
      c.records,
      c.failures,
    ]);
    expect(rows).toEqual([
      [
        'dataset',
        null,
        null,
        'every record must be unique — no two records identical',
        'root.json#/uniqueItems',
        2,
        2,
      ],
      [
        'dataset',
        null,
        null,
        'the dataset must have at least 50 records',
        'root.json#/minItems',
        null,
        1,
      ],
      [
        'variable',
        'want',
        null,
        'must be in the dataset — the schema requires it, and the dataset has no such column',
        'root.json#/items/properties/want',
        null,
        1,
      ],
      [
        'variable',
        'extra',
        null,
        'must not be in the dataset — the schema allows no variables besides the ones it describes',
        'root.json#/items/additionalProperties',
        null,
        1,
      ],
      [
        'variable',
        'Mixed',
        null,
        "must be named exactly as the schema names it — the dataset’s column is 'mixed', so its values were not checked",
        'root.json#/items/properties/Mixed',
        null,
        1,
      ],
      [
        'variable',
        'opt',
        null,
        'is declared in the schema, and the dataset has no such column (the schema does not require it)',
        'root.json#/items/properties/opt',
        null,
        1,
      ],
      // Values: most records first, then most failures, then schema order, then keyword.
      ['value', 'a', null, 'must be at most 9', 'root.json#/items/properties/a/maximum', 3, 3],
      [
        'value',
        'list',
        'list[].age',
        'must be at most 120',
        'root.json#/items/properties/list/items/properties/age/maximum',
        2,
        4,
      ],
      ['value', 'a', null, 'must be written as an integer', 'root.json#/items/properties/a', 2, 2],
      [
        'value',
        'b',
        null,
        "when a = 1, must be 'X'",
        'root.json#/items/allOf/0/then/properties/b/const',
        1,
        1,
      ],
      [
        'value',
        'b',
        null,
        'must match `^[A-Z]$` (One capital letter)',
        'defs.json#/$defs/code/pattern',
        1,
        1,
      ],
      [
        'value',
        'b',
        null,
        'must not be missing — the schema requires it in every record',
        'root.json#/items/required',
        1,
        1,
      ],
    ]);
    const a = f.schemaChecks.find((c) => c.ruleId === 'schema:prop:a:value');
    expect(a).toMatchObject({
      variableTitle: 'Count of a',
      keyword: 'maximum',
      schemaValue: 9,
      percentOfRecords: 30,
    });
    // A `required` list belongs to the whole object; the requirement names the field.
    expect(f.schemaChecks.find((c) => c.ruleId === 'schema:prop:b:required')).not.toHaveProperty(
      'schemaValue',
    );
    expect(f.overview.schemaChecksFailed).toBe(11);
    expect(f.overview.missingVariables).toEqual({ required: 1, optional: 1 });
    expect(f.overview.columnsNotInSchema).toBe(1);
    expect(f.notes).toEqual(
      expect.arrayContaining([
        {
          kind: 'precision',
          text: expect.stringContaining('a holds integers beyond ±(2^53−1)') as unknown as string,
        },
        { kind: 'schema-comment', text: 'root.json: Soft check: b should exceed a.' },
      ]),
    );
    expect(f.inputs.schema).toMatchObject({ root: 'root.json', files: ['defs.json', 'root.json'] });
  });

  it('prints a URL-loaded set’s files below its common base, the base once, no query', async () => {
    // The root carries a signed query; its `$ref` resolves to the bare defs URL.
    const url = (
      path: string,
      query = '',
    ): { relativePath: string; raw: string; retrievalUri: string } => ({
      relativePath: `https://host.example/schemas/v2/${path}${query}`,
      retrievalUri: `https://host.example/schemas/v2/${path}${query}`,
      raw: JSON.stringify(path === 'root.json' ? SCHEMA : DEFS),
    });
    const set = await buildSchemaSet([url('root.json', '?token=s3cr3t'), url('defs.json')], {
      origin: 'url',
    });
    const digest = columnDigest(set);
    if (digest === null) throw new Error('no digest');
    const f = buildFindings(
      input(
        { schema: { set, digest } },
        {
          schema: summary([
            tally({
              ruleId: 'schema:prop:a:value',
              column: 'a',
              keyword: 'maximum',
              schemaPath: '#/properties/a/maximum',
              location: `${set.files.find((x) => x.relativePath.includes('root.json'))?.retrievalUri ?? ''}#/items/properties/a/maximum`,
            }),
          ]),
        },
      ),
    );
    expect(f.inputs.schema).toMatchObject({
      baseUrl: 'https://host.example/schemas/v2/',
      root: 'root.json',
    });
    expect(f.schemaChecks[0]?.location).toEqual({
      file: 'root.json',
      pointer: '/items/properties/a/maximum',
    });
    expect(JSON.stringify(f)).not.toContain('s3cr3t');
  });

  it('reports nothing for a run whose schema stage did not finish, and says why', async () => {
    const f = buildFindings(
      input(
        { schema: await schemaInput() },
        { schema: null, stageErrors: [{ stage: 'schema', message: "Ada's row failed" }] },
      ),
    );
    expect(f.schemaChecks).toEqual([]);
    expect(f.notes[0]).toEqual({
      kind: 'stage-error',
      text: 'The schema stage did not finish, so its checks are missing here; the full QC report has the error.',
    });
    expect(JSON.stringify(f)).not.toContain('Ada');
  });
});
