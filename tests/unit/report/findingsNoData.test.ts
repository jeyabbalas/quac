/**
 * The findings without data hold no data — proved, not assumed.
 *
 * Every value in this dataset that a check can fail on carries a marker
 * (`zq7k…`, and the number 987654321), and the checks are chosen to put those
 * values everywhere a QC run puts data: schema messages that quote the value
 * (pattern, maxLength, enum, a cast, a maximum, a conditional's "Found …"),
 * a list's items, a rules flag's value, a dataset rule's result rows, a
 * correction's before and after, an engine error that quotes a cell
 * (`Could not convert string 'ZQ7K…' to INT32`) and a JavaScript correction
 * that throws with the value in its message.
 *
 * Two halves, both required: the run's own flags and the full QC report DO
 * carry the markers — so the test can see a leak — and the findings, in all
 * three formats, carry none of them while still reporting every one of those
 * checks.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { renderFindingsMarkdown } from '../../../src/core/report/findingsMarkdown';
import { writeFindingsWorkbook } from '../../../src/core/report/findingsWorkbook';
import { runQuac } from '../../../src/headless/run';
import type { QcFindings } from '../../../src/core/report/findings';
import type { RunQuacResult } from '../../../src/headless/run';

const SLOW = 120_000;

/** Every marker a leak would carry, case aside (a correction upper-cases one). */
const LEAK = /zq7k|987654321/i;

const CSV = [
  'id,name,age,code,tags,note,extra',
  'ID1,zq7kNameAlpha,987654321,zq7kCodeAlpha,"[""zq7ktag"",""zq7ktag""]",zq7kNoteAlpha,zq7kExtraAlpha',
  'ID2,Ann,zq7kAgeBravo,A,"[""ok""]",zq7kNoteBravo,zq7kExtraBravo',
  'ID3,zq7kNameCharlie,30,A,"[""zq7k Space""]",zq7kNoteCharlie,zq7kExtraCharlie',
  'ID3,zq7kNameCharlie,30,A,"[""zq7k Space""]",zq7kNoteCharlie,zq7kExtraCharlie',
  'zq7kIdEcho,Bo,40,B,"[]",,',
].join('\n');

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Canary table',
  type: 'array',
  uniqueItems: true,
  items: {
    type: 'object',
    required: ['id', 'name', 'age', 'code', 'tags'],
    properties: {
      id: { type: 'string', pattern: '^ID[0-9]+$', description: 'ID followed by digits' },
      name: { type: 'string', maxLength: 20 },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      code: { enum: ['A', 'B'] },
      tags: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-z]+$' } },
      note: { type: ['string', 'null'] },
    },
    allOf: [
      {
        if: { properties: { code: { const: 'A' } }, required: ['code'] },
        then: { properties: { name: { maxLength: 4 } } },
      },
    ],
    additionalProperties: false,
  },
};

const RULES = [
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled',
  'C001,correct,row,note,note IS NOT NULL,sql,upper(__value__),info,Notes are upper-cased.,true',
  'C002,correct,row,name,name IS NOT NULL,js,"(value) => { throw new Error(\'cannot fix \' + value); }",info,A correction that throws.,true',
  'V001,validate,row,age,age > 100,,,error,Age above 100.,true',
  "V002,validate,column,code,\"in_enum('A', 'B')\",,,error,Code must be A or B.,true",
  // The rules' own text is shared as written, so none of it may hold a marker:
  // a leak must come from the data to count.
  'V003,validate,dataset,name,"SELECT name, note FROM data WHERE length(name) > 10",,,warning,Names that look too long.,true',
  'V004,validate,row,note,CAST(note AS INTEGER) > 0,,,error,A rule that cannot read text as a number.,true',
  'V005,validate,row,missing_column,missing_column > 0,,,error,A rule about a column the dataset lacks.,true',
  'V006,external,row,code,Checked against the registry.,,,warning,Needs the external registry.,true',
  'V007,validate,row,age,age < 0,,,error,Disabled on purpose.,false',
  'V008,validate,row,age,age >>> 5,,,error,A rule whose SQL does not parse.,true',
].join('\n');

let dir: string;
let result: RunQuacResult;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quac-findings-nodata-'));
  await writeFile(join(dir, 'canary.csv'), CSV);
  await writeFile(join(dir, 'canary.schema.json'), JSON.stringify(SCHEMA, null, 2));
  await writeFile(join(dir, 'canary.quac.csv'), RULES);
  result = await runQuac({
    dataset: join(dir, 'canary.csv'),
    schema: [join(dir, 'canary.schema.json')],
    rules: [join(dir, 'canary.quac.csv')],
    out: join(dir, 'report.xlsx'),
  });
}, SLOW);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every string a workbook holds: sheet names and every cell, read back. */
async function workbookText(blob: Blob): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await blob.arrayBuffer());
  const parts: string[] = [];
  for (const sheet of workbook.worksheets) {
    parts.push(sheet.name);
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        parts.push(
          typeof cell.value === 'object' ? JSON.stringify(cell.value) : String(cell.value),
        );
      });
    });
  }
  return parts.join('\n');
}

describe('the run carries the data — so a leak would show', () => {
  test('flags quote the marked values in messages, values and corrections', () => {
    const flags = result.artifacts.flagStore.all().map((e) => e.flag);
    const quoted = (ruleId: string): boolean =>
      flags.some(
        (f) =>
          f.ruleId === ruleId &&
          LEAK.test(
            `${f.message} ${JSON.stringify(f.value ?? null)} ${JSON.stringify(f.correction ?? null)}`,
          ),
      );
    for (const ruleId of [
      'schema:prop:id:value', // pattern: 'zq7kIdEcho' does not match …
      'schema:prop:code:value', // enum
      'schema:prop:age:value', // 987654321 exceeds the maximum
      'schema:prop:age:cast', // 'zq7kAgeBravo' is not a valid integer
      'schema:prop:tags:value', // an item's pattern
      'schema:cond:0:name', // when code = 'A' … Found 'zq7kNameCharlie'
      'V001', // the flagged value
      'V002',
      'V003', // a dataset rule's result rows
      'C001', // before → after
    ]) {
      expect(quoted(ruleId), ruleId).toBe(true);
    }
  });

  test('a broken rule’s engine message quotes a cell', () => {
    const v004 = result.artifacts.rules?.perRule.find((s) => s.ruleId === 'V004');
    expect(v004?.status).toBe('broken');
    expect(v004?.error).toMatch(LEAK);
    const c002 = result.artifacts.rules?.perRule.find((s) => s.ruleId === 'C002');
    expect(c002?.status).toBe('broken');
    expect(c002?.error).toMatch(LEAK);
  });

  test('the full QC report holds the data', async () => {
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(join(dir, 'report.xlsx'));
    expect(await workbookText(new Blob([bytes]))).toMatch(LEAK);
  });
});

describe('the findings carry none of it', () => {
  const findings = (): QcFindings => result.findings;

  test('JSON', () => {
    expect(findings().containsData).toBe(false);
    expect(JSON.stringify(findings())).not.toMatch(LEAK);
  });

  test('Markdown', () => {
    expect(renderFindingsMarkdown(findings())).not.toMatch(LEAK);
  });

  test(
    'Excel',
    async () => {
      expect(await workbookText(await writeFindingsWorkbook(findings()))).not.toMatch(LEAK);
    },
    SLOW,
  );
});

describe('…while still reporting every check that failed', () => {
  test('each schema check, by keyword and place', () => {
    const checks = result.findings.schemaChecks.map(
      (c) => `${c.variable ?? '-'} ${c.keyword ?? '-'} ${c.location?.pointer ?? '-'}`,
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        '- uniqueItems /uniqueItems',
        'extra additionalProperties /items/additionalProperties',
        'id pattern /items/properties/id/pattern',
        'code enum /items/properties/code/enum',
        'age maximum /items/properties/age/maximum',
        'age type /items/properties/age',
        'tags pattern /items/properties/tags/items/pattern',
        'tags uniqueItems /items/properties/tags/uniqueItems',
        'name maxLength /items/allOf/0/then/properties/name/maxLength',
      ]),
    );
    const byKey = new Map(
      result.findings.schemaChecks.map((c) => [`${c.variable ?? '-'} ${c.keyword ?? '-'}`, c]),
    );
    expect(byKey.get('id pattern')?.requirement).toBe(
      'must match `^ID[0-9]+$` (ID followed by digits)',
    );
    expect(byKey.get('age maximum')?.requirement).toBe('must be at most 150');
    expect(byKey.get('age maximum')?.records).toBe(1);
    expect(byKey.get('tags pattern')?.path).toBe('tags[]');
    expect(byKey.get('name maxLength')?.requirement).toBe(
      "when code = 'A', must have at most 4 characters",
    );
    expect(byKey.get('name maxLength')?.records).toBe(2);
  });

  test('each rule, with an outcome and no engine text', () => {
    const outcome = new Map(result.findings.rules.map((r) => [r.ruleId, r]));
    expect(outcome.get('C001')?.outcome).toBe('corrected');
    expect(outcome.get('C001')?.valuesChanged).toBe(4);
    expect(outcome.get('C002')?.outcome).toBe('error');
    expect(outcome.get('C002')?.reason).toMatch(
      /^failed to execute — the JavaScript correction threw on \d+ of \d+ rows/,
    );
    expect(outcome.get('V001')).toMatchObject({ outcome: 'failed', records: 1 });
    expect(outcome.get('V002')?.byVariable).toEqual([
      { variable: 'code', records: 1, failed: true },
    ]);
    expect(outcome.get('V003')).toMatchObject({ outcome: 'failed', resultRows: 3, records: null });
    expect(outcome.get('V004')?.outcome).toBe('error');
    expect(outcome.get('V004')?.reason).toBe(
      'failed to execute — DuckDB reported a Conversion Error; the full QC report has its message',
    );
    expect(outcome.get('V005')).toMatchObject({
      outcome: 'skipped',
      reason: 'not in the dataset: missing_column',
    });
    expect(outcome.get('V006')?.outcome).toBe('not-evaluated');
    expect(outcome.get('V007')?.outcome).toBe('disabled');
    expect(outcome.get('V008')?.outcome).toBe('excluded');
    expect(outcome.get('V008')?.reason).toMatch(/^excluded before the run: /);
  });
});
