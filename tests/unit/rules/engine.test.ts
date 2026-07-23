// Engine validations battery — the P11 named scenarios (phase-11 §Verification,
// testing-strategy.md §3.2) executed on @duckdb/node-api through the SQLRunner
// seam. Catalog rules come from the committed HESP fixtures; inline rules cover
// cases the fixture files deliberately do not contain.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import type { QCFlag } from '../../../src/core/flags/flag';
import { createBridgeRunner, runValidations } from '../../../src/core/rules/engine';
import { parseRuleFile } from '../../../src/core/rules/parse';
import type { QCRule, RuleFile } from '../../../src/core/rules/types';
import { openDuckDb, openQcFixture, type QcFixtureDb } from './support';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');

const loadRules = (rel: string): RuleFile => {
  const name = rel.split('/').pop() ?? rel;
  return parseRuleFile(readFileSync(resolve(FIXTURES, rel), 'utf8'), name).file;
};

const KEYS = loadRules('hesp/rules/hesp_keys_and_structure.quac.csv');
const CONSISTENCY = loadRules('hesp/rules/hesp_consistency.quac.csv');

/** One RuleFile holding the named catalog rules, in the given order. */
const pick = (...ruleIds: string[]): RuleFile[] => {
  const all = [...KEYS.rules, ...CONSISTENCY.rules];
  const rules = ruleIds.map((id) => {
    const rule = all.find((r) => r.ruleId === id);
    if (rule === undefined) throw new Error(`fixture rule ${id} not found`);
    return rule;
  });
  return [{ name: 'picked.quac.csv', group: 'picked', rules, extraColumns: [] }];
};

const makeRule = (overrides: Partial<QCRule>): QCRule => ({
  ruleId: 'T001',
  ruleType: 'validate',
  ruleScope: 'row',
  targetVariables: ['wave'],
  condition: 'TRUE',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'error',
  comment: 'Test rule.',
  enabled: true,
  sourceFile: 'inline.quac.csv',
  rowNumber: 1,
  extras: {},
  ...overrides,
});

const inline = (...rules: QCRule[]): RuleFile[] => [
  { name: 'inline.quac.csv', group: 'inline', rules, extraColumns: [] },
];

const cellRows = (flags: QCFlag[], ruleId: string, column?: string): number[] =>
  flags
    .filter(
      (f) =>
        f.ruleId === ruleId &&
        f.scope === 'cell' &&
        (column === undefined || f.column === column),
    )
    .map((f) => f.row ?? -1);

describe('runValidations on qc_fixture', () => {
  let db: QcFixtureDb;
  beforeAll(async () => {
    db = await openQcFixture();
  });
  afterAll(() => {
    db.close();
  });

  it('T-KEY-UNIQUE — both members of the duplicated record_id pair, cell scope', async () => {
    const { flags, perRule } = await runValidations(db.runner, pick('Q001'));
    expect(cellRows(flags, 'Q001', 'record_id')).toEqual([3, 4]);
    expect(perRule).toEqual([
      expect.objectContaining({
        ruleId: 'Q001',
        status: 'ok',
        violationCount: 2,
        flagsEmitted: 2,
        truncated: false,
      }),
    ]);
    // Complete QCFlag shape regression: message is the comment verbatim
    // (EXCLUDES ruleId + column — renderFlag adds provenance), value snapshot set.
    expect(flags[0]).toEqual({
      source: 'rules',
      ruleId: 'Q001',
      scope: 'cell',
      row: 3,
      column: 'record_id',
      severity: 'error',
      message:
        'Duplicate record_id: household-wave record identifiers must be unique across the file.',
      value: 'HH00000002_W01',
    });
  });

  it('T-PARSE-KEY — only the mismatched row; NULL conditions never select (3VL)', async () => {
    const { flags, perRule } = await runValidations(db.runner, pick('Q003'));
    expect(cellRows(flags, 'Q003', 'record_id')).toEqual([5]);
    // one violating row × three targets
    expect(perRule[0]).toMatchObject({ status: 'ok', violationCount: 1, flagsEmitted: 3 });

    // Three-valued-logic regression: interview_date is NULL on __row__ 14, so
    // `<>` evaluates NULL there — the row must NOT be selected as violating.
    const nullCase = await runValidations(
      db.runner,
      inline(
        makeRule({
          ruleId: 'X_NULL',
          targetVariables: ['interview_date'],
          condition: "interview_date <> '2021-03-15'",
        }),
      ),
    );
    expect(cellRows(nullCase.flags, 'X_NULL')).not.toContain(14);
    // 16 rows − 1 equal (row 0) − 1 NULL (row 14)
    expect(nullCase.perRule[0]?.violationCount).toBe(14);
  });

  it('T-LAG-AGE — exactly the wave-3 row; wave-gap guard suppresses non-adjacent', async () => {
    const { flags, perRule } = await runValidations(db.runner, pick('Q008'));
    expect(cellRows(flags, 'Q008', 'reference_age')).toEqual([2]);
    // targets reference_age|household_id|wave → 3 cell flags for the one row
    expect(perRule[0]).toMatchObject({ status: 'ok', violationCount: 1, flagsEmitted: 3 });

    // Household observed in waves 1 and 3 only (gap): the adjacent-wave guard
    // (wave − LAG(wave) = 1) must suppress the implausible 10-year jump.
    const gap = await openDuckDb([
      `CREATE TABLE gap AS SELECT * FROM (VALUES
         (0, 'HH00000013', 1, 40),
         (1, 'HH00000013', 3, 50)
       ) AS t(__row__, household_id, wave, reference_age)`,
      'CREATE VIEW data AS SELECT * FROM gap',
    ]);
    try {
      const res = await runValidations(gap.runner, pick('Q008'));
      expect(res.perRule[0]).toMatchObject({ status: 'ok', violationCount: 0, flagsEmitted: 0 });
      expect(res.flags).toEqual([]);
    } finally {
      gap.close();
    }
  });

  it('T-PCTL — window quantile within wave partition flags only the cents row', async () => {
    const { flags, perRule } = await runValidations(db.runner, pick('Q038'));
    expect(cellRows(flags, 'Q038', 'monthly_rent')).toEqual([7]);
    expect(flags.find((f) => f.ruleId === 'Q038' && f.scope === 'cell')?.value).toBe(150000);
    expect(perRule[0]).toMatchObject({ status: 'ok', violationCount: 1, truncated: false });
  });

  it('T-BROKEN-RULE — runtime SQL failure marks the rule broken; the run continues', async () => {
    // EXPLAIN-clean but fails at runtime: every household_id is non-numeric
    // ('HH00000001', …), so the CAST dies on the first value it evaluates.
    const broken = makeRule({
      ruleId: 'X_BRK',
      targetVariables: ['household_id'],
      condition: 'CAST(household_id AS INTEGER) IS NOT NULL',
    });
    const after = makeRule({
      ruleId: 'X_OK',
      targetVariables: ['wave'],
      condition: 'wave > 2',
      severity: 'info',
    });
    const { flags, perRule } = await runValidations(db.runner, inline(broken, after));

    expect(perRule[0]).toMatchObject({
      ruleId: 'X_BRK',
      status: 'broken',
      violationCount: 0,
      flagsEmitted: 1,
      truncated: false,
    });
    expect(perRule[0]?.error).toContain('Could not convert');
    const brokenFlag = flags.find((f) => f.ruleId === 'X_BRK');
    expect(brokenFlag).toMatchObject({ scope: 'dataset', severity: 'error' });
    expect(brokenFlag?.message.startsWith('Rule failed to execute: ')).toBe(true);

    // The next rule still ran (wave 3 lives on __row__ 2 only)…
    expect(cellRows(flags, 'X_OK')).toEqual([2]);
    // …and the table is untouched (validations are read-only).
    const [count] = await db.runner.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM qc_fixture',
    );
    expect(count?.n).toBe(16);
  });

  it('column asserts — per-target expansion sums counts (H002 no_nulls over 4 columns)', async () => {
    const { flags, perRule } = await runValidations(db.runner, pick('H002'));
    // Only interview_date has a NULL (__row__ 14); the other 3 targets are clean.
    expect(perRule[0]).toMatchObject({ status: 'ok', violationCount: 1, flagsEmitted: 1 });
    expect(flags[0]).toMatchObject({
      scope: 'cell',
      row: 14,
      column: 'interview_date',
      value: null,
    });
  });

  it('count_distinct_in_range — in-range silent; violation is one column flag with the count', async () => {
    const inRange = await runValidations(db.runner, pick('H003'));
    expect(inRange.flags).toEqual([]);
    expect(inRange.perRule[0]).toMatchObject({ status: 'ok', violationCount: 0, flagsEmitted: 0 });

    const out = await runValidations(
      db.runner,
      inline(
        makeRule({
          ruleId: 'X_CDR',
          ruleScope: 'column',
          targetVariables: ['wave'],
          condition: 'count_distinct_in_range(5, 20)',
          severity: 'warning',
          comment: 'Too few distinct waves for a longitudinal extract.',
        }),
      ),
    );
    expect(out.perRule[0]).toMatchObject({ status: 'ok', violationCount: 1, flagsEmitted: 1 });
    expect(out.flags[0]).toEqual({
      source: 'rules',
      ruleId: 'X_CDR',
      scope: 'column',
      column: 'wave',
      severity: 'warning',
      message: 'Too few distinct waves for a longitudinal extract. Found 3 distinct values.',
    });
  });

  it('dataset SELECT — one flag per returned row with col=val rendering (H005)', async () => {
    const { flags, perRule } = await runValidations(db.runner, pick('H005'));
    // Only wave 1 contains duplicate household rows (the Q002 pair).
    expect(perRule[0]).toMatchObject({
      status: 'ok',
      violationCount: 1,
      flagsEmitted: 1,
      truncated: false,
    });
    expect(flags[0]).toEqual({
      source: 'rules',
      ruleId: 'H005',
      scope: 'dataset',
      severity: 'error',
      message:
        'Wave contains more rows than distinct households; per-wave duplicate household ' +
        'extractions listed. — wave=1; n_rows=13; n_households=12; n_duplicate_household_rows=1',
    });
  });

  it('dataset SELECT — cap + exact-count truncation flag', async () => {
    const rule = makeRule({
      ruleId: 'X_DS',
      ruleScope: 'dataset',
      targetVariables: [],
      condition: 'SELECT __row__, wave FROM data ORDER BY __row__;',
      severity: 'info',
      comment: 'Every row, for cap testing.',
    });
    const { flags, perRule } = await runValidations(db.runner, inline(rule), {
      datasetRowCap: 5,
    });
    expect(perRule[0]).toMatchObject({
      status: 'ok',
      violationCount: 16,
      flagsEmitted: 6,
      truncated: true,
    });
    const messages = flags.map((f) => f.message);
    expect(messages[0]).toBe('Every row, for cap testing. — __row__=0; wave=1');
    expect(messages[5]).toBe('…and 11 more result rows');
    expect(flags.filter((f) => f.scope === 'dataset')).toHaveLength(6);
  });

  it('skip statuses — external (even disabled), disabled, inapplicable; correct unstatted', async () => {
    const files = [
      // Q044 external; Q021 inapplicable on qc_fixture (7 income columns absent)
      ...pick('Q044', 'Q021'),
      ...inline(
        makeRule({ ruleId: 'X_OFF', enabled: false }),
        makeRule({
          ruleId: 'X_EXT_OFF',
          ruleType: 'external',
          enabled: false,
          condition: 'requires reference data',
        }),
        makeRule({ ruleId: 'X_CORR', ruleType: 'correct', updateExpression: '0' }),
      ),
    ];
    const { flags, perRule } = await runValidations(db.runner, files);
    expect(perRule.map((s) => [s.ruleId, s.status])).toEqual([
      ['Q044', 'skipped-external'],
      ['Q021', 'skipped-inapplicable'],
      ['X_OFF', 'skipped-disabled'],
      ['X_EXT_OFF', 'skipped-external'],
    ]);
    expect(flags).toEqual([]);
    // Skip stats are fully zeroed.
    expect(perRule[1]).toMatchObject({ violationCount: 0, flagsEmitted: 0, truncated: false, durationMs: 0 });
  });

  it('global flag cap — rules keep running and emit count-only summaries', async () => {
    // Rule 1 (13 wave-1 rows): cap 10 admits 10 cells, suppresses 3.
    // Rule 2 (all 16 rows): zero capacity left — count-only summary flag.
    const r1 = makeRule({ ruleId: 'X_G1', condition: 'wave = 1', severity: 'info', comment: 'First.' });
    const r2 = makeRule({ ruleId: 'X_G2', condition: 'wave >= 1', severity: 'info', comment: 'Second.' });
    const { flags, perRule } = await runValidations(db.runner, inline(r1, r2), {
      globalFlagCap: 10,
    });
    expect(perRule[0]).toMatchObject({
      ruleId: 'X_G1',
      status: 'ok',
      violationCount: 13,
      flagsEmitted: 11,
      truncated: true,
    });
    expect(perRule[1]).toMatchObject({
      ruleId: 'X_G2',
      status: 'ok',
      violationCount: 16,
      flagsEmitted: 1,
      truncated: true,
    });
    expect(flags.filter((f) => f.scope === 'cell')).toHaveLength(10);
    expect(flags.find((f) => f.ruleId === 'X_G1' && f.scope === 'dataset')?.message).toBe(
      '…and 3 more flags from this rule suppressed (global flag cap reached)',
    );
    expect(flags.at(-1)).toMatchObject({
      ruleId: 'X_G2',
      scope: 'dataset',
      message: '…and 16 more flags from this rule suppressed (global flag cap reached)',
    });
  });

  it('onProgress fires before each enabled validate rule (0-based); onFlags batches per rule', async () => {
    const progress: { ruleId: string; index: number; total: number; phase: string }[] = [];
    const batches: QCFlag[][] = [];
    const files = [
      ...pick('Q001', 'Q044', 'Q021', 'Q013'),
      ...inline(makeRule({ ruleId: 'X_OFF', enabled: false })),
    ];
    const { flags } = await runValidations(db.runner, files, {
      onProgress: (p) => progress.push({ ...p }),
      onFlags: (batch) => batches.push([...batch]),
    });
    // Enabled validate rules only — the inapplicable Q021 is still loop work;
    // external Q044 and disabled X_OFF never appear.
    expect(progress).toEqual([
      { ruleId: 'Q001', index: 0, total: 3, phase: 'validate' },
      { ruleId: 'Q021', index: 1, total: 3, phase: 'validate' },
      { ruleId: 'Q013', index: 2, total: 3, phase: 'validate' },
    ]);
    // One non-empty batch per rule (only Q001 flags anything here), and
    // RunResult.flags is exactly the concatenation of the batches.
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((f) => f.ruleId)).toEqual(['Q001', 'Q001']);
    expect(flags).toEqual(batches.flat());
  });

  it('manifest — the full fixture rule files produce the expected perRule table', async () => {
    const corrections = loadRules('hesp/rules/hesp_corrections.quac.csv');
    const { perRule } = await runValidations(db.runner, [KEYS, CONSISTENCY, corrections]);
    expect(perRule.map((s) => [s.ruleId, s.status, s.violationCount])).toEqual([
      ['Q001', 'ok', 2],
      ['Q002', 'ok', 2],
      ['Q003', 'ok', 1],
      ['Q007', 'ok', 0],
      ['H001', 'ok', 1],
      ['H002', 'ok', 1],
      ['H003', 'ok', 0],
      ['H004', 'ok', 2], // '2023-02-30' AND the whitespace date (support.ts knock-on)
      ['H005', 'ok', 1],
      ['Q044', 'skipped-external', 0],
      ['Q011', 'ok', 1],
      ['Q021', 'skipped-inapplicable', 0], // 7 income columns absent from qc_fixture
      ['Q013', 'ok', 0],
      ['Q008', 'ok', 1],
      ['Q038', 'ok', 1],
    ]);
    // The corrections file contributes NO stats in the validations phase (P12).
  });
});

describe('runValidations on scratch tables', () => {
  it('T-TOLERANCE — $200-on-$10k flagged, $60 not, sentinel row excluded', async () => {
    const db = await openDuckDb([
      `CREATE TABLE tol AS SELECT * FROM (VALUES
         (0, 10000, 9800, 0),
         (1, 10000, 9940, 0),
         (2, 10000, -888, 0)
       ) AS t(__row__, total_household_income_annual, wage_income_annual, selfemp_income_annual)`,
      'CREATE VIEW data AS SELECT * FROM tol',
    ]);
    const rule = makeRule({
      ruleId: 'T021',
      severity: 'warning',
      targetVariables: [
        'total_household_income_annual',
        'wage_income_annual',
        'selfemp_income_annual',
      ],
      condition:
        'total_household_income_annual >= 0 AND wage_income_annual >= 0\n' +
        'AND selfemp_income_annual >= 0\n' +
        'AND ABS((wage_income_annual + selfemp_income_annual) - total_household_income_annual)\n' +
        '  > GREATEST(50, 0.01 * total_household_income_annual)',
      comment: 'Income components do not sum to the total within tolerance (larger of $50 or 1%).',
    });
    try {
      const { flags, perRule } = await runValidations(db.runner, inline(rule));
      // $200 off on $10k exceeds GREATEST(50, 100); $60 does not; the -888
      // sentinel row is excluded by the >= 0 guard (not flagged, not an error).
      expect(cellRows(flags, 'T021', 'wage_income_annual')).toEqual([0]);
      expect(perRule[0]).toMatchObject({ status: 'ok', violationCount: 1, flagsEmitted: 3 });
    } finally {
      db.close();
    }
  });

  it('T-CAPS — 25k violations, cap 10k: cap×targets cells + per-target summaries + exact count', async () => {
    const db = await openDuckDb([
      'CREATE TABLE big AS SELECT range AS __row__, range % 100 AS a, range % 7 AS b FROM range(25000)',
      'CREATE VIEW data AS SELECT * FROM big',
    ]);
    const rule = makeRule({
      ruleId: 'X_CAP',
      targetVariables: ['a', 'b'],
      condition: 'a >= 0',
      severity: 'warning',
      comment: 'Cap test.',
    });
    try {
      const { flags, perRule } = await runValidations(db.runner, inline(rule));
      expect(perRule[0]).toMatchObject({
        status: 'ok',
        violationCount: 25_000, // EXACT, from COUNT(*), never truncated
        flagsEmitted: 20_002,
        truncated: true,
      });
      const cells = flags.filter((f) => f.scope === 'cell');
      expect(cells).toHaveLength(20_000);
      expect(cells[0]).toMatchObject({ row: 0, column: 'a', value: 0 });
      expect(cells[1]).toMatchObject({ row: 0, column: 'b', value: 0 });
      expect(cells[19_999]).toMatchObject({ row: 9_999, column: 'b' });
      const summaries = flags.filter((f) => f.scope === 'column');
      expect(summaries.map((f) => f.column)).toEqual(['a', 'b']);
      expect(summaries[0]?.message).toBe('…and 15,000 more rows flagged by this rule');
    } finally {
      db.close();
    }
  });
});

describe('createBridgeRunner', () => {
  it('forwards query to bridge.query and clearCache to bridge.clearQueryCache', async () => {
    const calls: string[] = [];
    let cleared = 0;
    const stub = {
      query: <T>(sql: string): Promise<T[]> => {
        calls.push(sql);
        return Promise.resolve([{ ok: 1 }] as T[]);
      },
      clearQueryCache: (): void => {
        cleared += 1;
      },
    } as unknown as WorkerBridge;

    const runner = createBridgeRunner(stub);
    await expect(runner.query('SELECT 1')).resolves.toEqual([{ ok: 1 }]);
    expect(calls).toEqual(['SELECT 1']);
    runner.clearCache();
    expect(cleared).toBe(1);
  });
});
