// P18 rule-test dispatch on the real qc_fixture DuckDB: the preview must run
// the engine's EXACT wrappers (counts exact, samples capped at 20) without
// ever mutating `data`. The −2500 → 2500 correction capture the phase file
// names is pinned HERE — the qc_fixture seed carries it (row 9); the e2e tier
// asserts the HESP example dataset's own seeded value instead (−1200).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRuleFile } from '../../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../../src/core/rules/sandbox';
import { PREVIEW_ROW_CAP, runRuleTest } from '../../../src/ui/views/studio/ruleTest';
import type { RuleTestDeps } from '../../../src/ui/views/studio/ruleTest';
import type { JSSandbox, QCRule } from '../../../src/core/rules/types';
import { openDuckDb, openQcFixture, type QcFixtureDb } from '../rules/support';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');

/** The committed H006 js source (multi-line arrow fn with inline comment). */
const H006_SOURCE = (() => {
  const file = parseRuleFile(
    readFileSync(resolve(FIXTURES, 'hesp', 'rules', 'hesp_corrections.quac.csv'), 'utf8'),
    'hesp_corrections.quac.csv',
  ).file;
  const rule = file.rules.find((r) => r.ruleId === 'H006');
  if (rule === undefined) throw new Error('fixture rule H006 not found');
  return rule.updateExpression;
})();

let db: QcFixtureDb;
let deps: RuleTestDeps;
let sandbox: JSSandbox | null = null;
const loadSandbox = (): Promise<JSSandbox> => {
  sandbox ??= createQuickJSSandbox();
  return Promise.resolve(sandbox);
};

beforeAll(async () => {
  db = await openQcFixture();
  const described = await db.runner.query<{ column_name: string }>('DESCRIBE data');
  deps = {
    runner: db.runner,
    datasetColumns: described.map((r) => r.column_name),
    loadSandbox,
  };
});

afterAll(() => {
  db.close();
});

const draft = (overrides: Partial<QCRule>): QCRule => ({
  ruleId: 'T1',
  ruleType: 'validate',
  ruleScope: 'row',
  targetVariables: ['record_id'],
  condition: 'record_id IS NULL',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'error',
  comment: 'test draft',
  enabled: true,
  sourceFile: '',
  rowNumber: 0,
  extras: {},
  ...overrides,
});

describe('runRuleTest — validate', () => {
  it('Q011 roster break: exact count + violating row with target columns', async () => {
    const result = await runRuleTest(
      draft({
        targetVariables: ['household_size', 'adult_count', 'child_count'],
        condition:
          'household_size >= 1 AND adult_count >= 0 AND child_count >= 0 ' +
          'AND adult_count + child_count <> household_size',
      }),
      deps,
    );
    expect(result).toEqual({
      kind: 'validate',
      count: 1,
      columns: ['__row__', 'household_size', 'adult_count', 'child_count'],
      rows: [{ __row__: 12, household_size: 4, adult_count: 2, child_count: 1 }],
      truncated: false,
    });
  });

  it('0 matches is a successful test: count 0, no rows', async () => {
    const result = await runRuleTest(draft({}), deps);
    expect(result).toEqual({
      kind: 'validate',
      count: 0,
      columns: ['__row__', 'record_id'],
      rows: [],
      truncated: false,
    });
  });

  it('truncation: 50 violating rows → exact count, 20 sample rows', async () => {
    const scratch = await openDuckDb([
      'CREATE TABLE scratch(__row__ BIGINT, v INTEGER)',
      `INSERT INTO scratch SELECT range, 1 FROM range(50)`,
      'CREATE VIEW data AS SELECT * FROM scratch',
    ]);
    try {
      const result = await runRuleTest(
        draft({ targetVariables: ['v'], condition: 'v >= 0' }),
        { runner: scratch.runner, datasetColumns: ['v'] },
      );
      if (result.kind !== 'validate') throw new Error(`unexpected kind ${result.kind}`);
      expect(result.count).toBe(50);
      expect(result.rows).toHaveLength(PREVIEW_ROW_CAP);
      expect(result.truncated).toBe(true);
    } finally {
      scratch.close();
    }
  });

  it('broken SQL → error with the binder text verbatim', async () => {
    const result = await runRuleTest(draft({ condition: 'recrd_id IS NULL' }), deps);
    if (result.kind !== 'error') throw new Error(`unexpected kind ${result.kind}`);
    expect(result.message).toContain('recrd_id');
  });
});

describe('runRuleTest — column asserts', () => {
  it('in_range expansion: per-target expanded SQL + count + sample', async () => {
    const result = await runRuleTest(
      draft({ ruleScope: 'column', targetVariables: ['reference_age'], condition: 'in_range(18, 50)' }),
      deps,
    );
    if (result.kind !== 'assert') throw new Error(`unexpected kind ${result.kind}`);
    expect(result.perTarget).toHaveLength(1);
    const target = result.perTarget[0];
    if (target === undefined || !('count' in target)) throw new Error('expected row-condition');
    expect(target.target).toBe('reference_age');
    expect(target.sql).toContain('"reference_age" < 18');
    expect(target.count).toBe(4); // ages 55, 51, 60, 61
    expect(target.rows.map((r) => r.__row__)).toEqual([6, 9, 10, 11]);
    expect(target.truncated).toBe(false);
  });

  it('count_distinct_in_range: aggregate verdict pass and fail', async () => {
    const pass = await runRuleTest(
      draft({ ruleScope: 'column', targetVariables: ['wave'], condition: 'count_distinct_in_range(1, 5)' }),
      deps,
    );
    if (pass.kind !== 'assert') throw new Error(`unexpected kind ${pass.kind}`);
    const passTarget = pass.perTarget[0];
    if (passTarget === undefined || !('aggregate' in passTarget)) throw new Error('expected aggregate');
    expect(passTarget.sql).toBe('SELECT COUNT(DISTINCT "wave") FROM data');
    expect(passTarget.aggregate).toEqual({ count: 3, lo: 1, hi: 5, pass: true });

    const fail = await runRuleTest(
      draft({ ruleScope: 'column', targetVariables: ['wave'], condition: 'count_distinct_in_range(4, 10)' }),
      deps,
    );
    if (fail.kind !== 'assert') throw new Error(`unexpected kind ${fail.kind}`);
    const failTarget = fail.perTarget[0];
    if (failTarget === undefined || !('aggregate' in failTarget)) throw new Error('expected aggregate');
    expect(failTarget.aggregate).toEqual({ count: 3, lo: 4, hi: 10, pass: false });
  });
});

describe('runRuleTest — corrections (never mutate)', () => {
  const Q052_CONDITION = '__value__ < 0 AND __value__ NOT IN (-666, -777, -888, -999)';

  it('Q052 sql correction: capture pins −2500 → 2500, data untouched', async () => {
    const result = await runRuleTest(
      draft({
        ruleType: 'correct',
        targetVariables: ['credit_card_balance'],
        condition: Q052_CONDITION,
        updateExpression: 'ABS(__value__)',
        severity: 'info',
      }),
      deps,
    );
    expect(result).toEqual({
      kind: 'correction',
      count: 1,
      captures: [{ target: 'credit_card_balance', row: 9, before: -2500, after: 2500 }],
      sampleOnly: false,
      sampledRows: 0,
      sampleErrors: 0,
    });
    // Preview never mutates: the seeded value is still there.
    const [row] = await db.runner.query(
      'SELECT credit_card_balance FROM data WHERE __row__ = 9',
    );
    expect(row?.credit_card_balance).toBe(-2500);
  });

  it('H006 js correction: sandboxed sample capture hh-42 → HH00000042', async () => {
    const result = await runRuleTest(
      draft({
        ruleType: 'correct',
        targetVariables: ['household_id'],
        condition: "household_id IS NOT NULL AND NOT regexp_full_match(household_id, 'HH[0-9]{8}')",
        updateLanguage: 'js',
        updateExpression: H006_SOURCE,
        severity: 'info',
      }),
      deps,
    );
    expect(result).toEqual({
      kind: 'correction',
      count: 1,
      captures: [{ target: 'household_id', row: 13, before: 'hh-42', after: 'HH00000042' }],
      sampleOnly: true,
      sampledRows: 1,
      sampleErrors: 0,
    });
    const [row] = await db.runner.query("SELECT household_id FROM data WHERE __row__ = 13");
    expect(row?.household_id).toBe('hh-42'); // untouched
  });

  it('js partial sample errors pass with the count surfaced', async () => {
    const result = await runRuleTest(
      draft({
        ruleType: 'correct',
        targetVariables: ['reference_age'],
        condition: 'wave IN (1, 2)',
        updateLanguage: 'js',
        updateExpression:
          "(value, row) => { if (row.wave === 2) throw new Error('boom'); return value; }",
        severity: 'info',
      }),
      deps,
    );
    if (result.kind !== 'correction') throw new Error(`unexpected kind ${result.kind}`);
    expect(result.count).toBe(15); // waves 1+2 match rows
    expect(result.sampleOnly).toBe(true);
    expect(result.sampledRows).toBe(15); // all matches fit the 20-row sample
    expect(result.sampleErrors).toBe(2); // sampled rows 1 and 11 are wave 2
    const errored = result.captures.filter((c) => c.error !== undefined);
    expect(errored.map((c) => c.row)).toEqual([1, 11]);
    expect(errored[0]?.error).toContain('boom');
  });

  it('js all-sampled-rows-errored → error result', async () => {
    const result = await runRuleTest(
      draft({
        ruleType: 'correct',
        targetVariables: ['household_id'],
        condition: "household_id = 'hh-42'",
        updateLanguage: 'js',
        updateExpression: "() => { throw new Error('always broken'); }",
        severity: 'info',
      }),
      deps,
    );
    if (result.kind !== 'error') throw new Error(`unexpected kind ${result.kind}`);
    expect(result.message).toContain('all 1 sampled rows');
    expect(result.message).toContain('always broken');
  });
});

describe('runRuleTest — dataset scope', () => {
  it('runs the SELECT with the cap+1 idiom: exact count, result columns', async () => {
    const result = await runRuleTest(
      draft({
        ruleScope: 'dataset',
        targetVariables: [],
        condition: 'SELECT wave, COUNT(*) AS n_rows FROM data GROUP BY wave ORDER BY wave',
      }),
      deps,
    );
    expect(result).toEqual({
      kind: 'dataset',
      count: 3,
      columns: ['wave', 'n_rows'],
      rows: [
        { wave: 1, n_rows: 13 },
        { wave: 2, n_rows: 2 },
        { wave: 3, n_rows: 1 },
      ],
      truncated: false,
    });
  });
});

describe('runRuleTest — not testable', () => {
  it('missing target → not-testable naming the column', async () => {
    const result = await runRuleTest(
      draft({ targetVariables: ['no_such_col'], condition: 'no_such_col IS NULL' }),
      deps,
    );
    if (result.kind !== 'not-testable') throw new Error(`unexpected kind ${result.kind}`);
    expect(result.reason).toContain('no_such_col');
  });

  it('external → not-testable', async () => {
    const result = await runRuleTest(
      draft({ ruleType: 'external', targetVariables: [], condition: 'checked out of band' }),
      deps,
    );
    expect(result.kind).toBe('not-testable');
  });
});
