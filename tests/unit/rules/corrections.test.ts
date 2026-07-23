// Corrections battery — the P12 named scenarios (phase-12 §Verification,
// testing-strategy.md §3.2) executed on @duckdb/node-api through the SQLRunner
// seam. runQC tests seed `quac_typed` (no `data` view — the engine's prepare
// stage owns quac_work + data); catalog rules come from the committed HESP
// fixtures; inline rules cover cases the fixture files deliberately omit.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QCFlag } from '../../../src/core/flags/flag';
import { runQC } from '../../../src/core/rules/engine';
import { parseRuleFile } from '../../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../../src/core/rules/sandbox';
import type { QCRule, RuleFile } from '../../../src/core/rules/types';
import {
  PARITY_RULE_IDS,
  expectedParityResult,
  qcFixtureSetupSql,
} from '../../shared/qcFixtureSql';
import { openDuckDb, openQcTyped, type QcFixtureDb } from './support';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');

const loadRules = (rel: string): RuleFile => {
  const name = rel.split('/').pop() ?? rel;
  return parseRuleFile(readFileSync(resolve(FIXTURES, rel), 'utf8'), name).file;
};

const KEYS = loadRules('hesp/rules/hesp_keys_and_structure.quac.csv');
const CONSISTENCY = loadRules('hesp/rules/hesp_consistency.quac.csv');
const CORRECTIONS = loadRules('hesp/rules/hesp_corrections.quac.csv');
const ALL_RULES = [...KEYS.rules, ...CONSISTENCY.rules, ...CORRECTIONS.rules];

/** One RuleFile holding the named catalog rules, in the given order. */
const pick = (...ruleIds: string[]): RuleFile[] => {
  const rules = ruleIds.map((id) => {
    const rule = ALL_RULES.find((r) => r.ruleId === id);
    if (rule === undefined) throw new Error(`fixture rule ${id} not found`);
    return rule;
  });
  return [{ name: 'picked.quac.csv', group: 'picked', rules, extraColumns: [] }];
};

const makeRule = (overrides: Partial<QCRule>): QCRule => ({
  ruleId: 'T001',
  ruleType: 'correct',
  ruleScope: 'row',
  targetVariables: ['wave'],
  condition: 'TRUE',
  updateLanguage: 'sql',
  updateExpression: '0',
  severity: 'info',
  comment: 'Test correction.',
  enabled: true,
  sourceFile: 'inline.quac.csv',
  rowNumber: 1,
  extras: {},
  ...overrides,
});

const inline = (...rules: QCRule[]): RuleFile[] => [
  { name: 'inline.quac.csv', group: 'inline', rules, extraColumns: [] },
];

const correctionFlags = (flags: QCFlag[]): QCFlag[] =>
  flags.filter((f) => f.correction !== undefined);

const workRows = async (db: QcFixtureDb): Promise<Record<string, unknown>[]> =>
  db.runner.query('SELECT * FROM quac_work ORDER BY __row__');

const scalar = async (db: QcFixtureDb, sql: string): Promise<unknown> => {
  const rows = await db.runner.query(sql);
  return Object.values(rows[0] ?? {})[0];
};

describe('runQC corrections on qc_fixture (seeded as quac_typed)', () => {
  it('T-CORRECT-SENTINEL-IDEMPOTENT — before/after captured; determinism; second run on corrected data emits zero flags, table byte-identical', async () => {
    const db = await openQcTyped();
    try {
      // Run 1: the only positive sentinel is wage_income_annual=999 at row 8.
      const run1 = await runQC(db.runner, pick('Q047'));
      expect(correctionFlags(run1.flags)).toEqual([
        {
          source: 'rules',
          ruleId: 'Q047',
          scope: 'cell',
          row: 8,
          column: 'wage_income_annual',
          severity: 'info',
          message:
            "Legacy positive sentinel recoded to HESP negative sentinel convention (-777 refused, -888 don't know, -999 not collected).",
          value: 999,
          correction: { before: 999, after: -999 },
        },
      ]);
      expect(run1.perRule).toEqual([
        expect.objectContaining({
          ruleId: 'Q047',
          status: 'ok',
          violationCount: 1,
          changedCells: 1,
          flagsEmitted: 1,
          truncated: false,
        }),
      ]);
      expect(run1.correctedCells).toBe(1);
      expect(await scalar(db, 'SELECT wage_income_annual FROM quac_work WHERE __row__ = 8')).toBe(
        -999,
      );
      // Untargeted columns and untouched rows are unchanged.
      expect(
        await scalar(db, 'SELECT total_household_income_annual FROM quac_work WHERE __row__ = 8'),
      ).toBe(47000);
      expect(await scalar(db, 'SELECT wage_income_annual FROM quac_work WHERE __row__ = 0')).toBe(
        52000,
      );
      const afterRun1 = await workRows(db);

      // Determinism: a re-run from the same quac_typed reproduces run 1 exactly.
      const run1b = await runQC(db.runner, pick('Q047'));
      expect(run1b.flags).toEqual(run1.flags);
      expect(await workRows(db)).toEqual(afterRun1);

      // Idempotence (format §5 no-op suppression): promote the corrected data
      // to quac_typed, run again → zero correction flags, identical table.
      await db.runner.query('CREATE OR REPLACE TABLE quac_typed AS SELECT * FROM quac_work');
      const run2 = await runQC(db.runner, pick('Q047'));
      expect(correctionFlags(run2.flags)).toEqual([]);
      expect(run2.perRule).toEqual([
        expect.objectContaining({
          ruleId: 'Q047',
          status: 'ok',
          violationCount: 0,
          changedCells: 0,
          flagsEmitted: 0,
        }),
      ]);
      expect(run2.correctedCells).toBe(0);
      expect(await workRows(db)).toEqual(afterRun1);
    } finally {
      db.close();
    }
  });

  it('T-CORRECT-WINDOW — Q055 carry-forward fills from the previous wave on the fixture', async () => {
    const db = await openQcTyped();
    try {
      const { flags, correctedCells } = await runQC(db.runner, pick('Q055'));
      expect(correctionFlags(flags)).toEqual([
        expect.objectContaining({
          ruleId: 'Q055',
          row: 11,
          column: 'reference_education',
          correction: { before: -999, after: 4 },
        }),
      ]);
      expect(correctedCells).toBe(1);
      expect(await scalar(db, 'SELECT reference_education FROM quac_work WHERE __row__ = 11')).toBe(
        4,
      );
    } finally {
      db.close();
    }
  });

  it('js corrections without a sandbox are broken (H006) — table untouched, run continues', async () => {
    const db = await openQcTyped();
    try {
      const { flags, perRule } = await runQC(db.runner, pick('H006', 'Q047'));
      expect(perRule).toEqual([
        expect.objectContaining({
          ruleId: 'H006',
          status: 'broken',
          error: 'JS corrections require the QuickJS sandbox; rule not executed',
        }),
        expect.objectContaining({ ruleId: 'Q047', status: 'ok', changedCells: 1 }),
      ]);
      expect(flags.filter((f) => f.ruleId === 'H006')).toEqual([
        {
          source: 'rules',
          ruleId: 'H006',
          scope: 'dataset',
          severity: 'error',
          message:
            'Rule failed to execute: JS corrections require the QuickJS sandbox; rule not executed',
        },
      ]);
      expect(await scalar(db, "SELECT household_id FROM quac_work WHERE __row__ = 13")).toBe(
        'hh-42',
      );
    } finally {
      db.close();
    }
  });

  it('assess-only mode — corrections phase skipped cleanly, validations see uncorrected data', async () => {
    const db = await openQcTyped();
    try {
      const { flags, perRule, correctedCells } = await runQC(db.runner, pick('Q047', 'Q001'), {
        applyCorrections: false,
      });
      // No stats for correct rules at all (deferred-notes contract) and no
      // correction flags; the validation still runs on the untouched copy.
      expect(perRule.map((s) => [s.ruleId, s.status])).toEqual([['Q001', 'ok']]);
      expect(correctionFlags(flags)).toEqual([]);
      expect(correctedCells).toBe(0);
      expect(flags.filter((f) => f.ruleId === 'Q001')).toHaveLength(2);
      expect(await scalar(db, 'SELECT wage_income_annual FROM quac_work WHERE __row__ = 8')).toBe(
        999,
      );
    } finally {
      db.close();
    }
  });

  it('runQC manifest — corrections stats first (file order), then validations on the corrected data', async () => {
    const db = await openQcTyped();
    try {
      const progress: { ruleId: string; index: number; total: number; phase: string }[] = [];
      const { perRule, correctedCells } = await runQC(db.runner, [KEYS, CONSISTENCY, CORRECTIONS], {
        onProgress: (p) => progress.push({ ...p }),
      });
      expect(perRule.map((s) => [s.ruleId, s.status, s.violationCount])).toEqual([
        // Phase 1 — corrections, hesp_corrections.quac.csv row order:
        ['Q047', 'ok', 1], // wage 999 → -999 at row 8
        ['Q048', 'ok', 1], // rent 950 → -666 at row 9 (tenure 2); -666 rows no-op
        ['Q050', 'ok', 1], // rent 150000 → 1500 at row 7 (row 9 already -666)
        ['Q052', 'skipped-inapplicable', 0], // 3 debt columns absent from qc_fixture
        ['Q055', 'ok', 1], // education -999 → 4 at row 11
        ['H006', 'broken', 0], // js — this run passes no sandbox
        ['Q057', 'skipped-disabled', 0],
        // Phase 3 — validations (P11 shape; counts unchanged post-correction):
        ['Q001', 'ok', 2],
        ['Q002', 'ok', 2],
        ['Q003', 'ok', 1],
        ['Q007', 'ok', 0],
        ['H001', 'ok', 1],
        ['H002', 'ok', 1],
        ['H003', 'ok', 0],
        ['H004', 'ok', 2],
        ['H005', 'ok', 1],
        ['Q044', 'skipped-external', 0],
        ['Q011', 'ok', 1],
        ['Q021', 'skipped-inapplicable', 0],
        ['Q013', 'ok', 0],
        ['Q008', 'ok', 1],
        ['Q038', 'ok', 1],
      ]);
      expect(correctedCells).toBe(4);
      // onProgress: correct phase counts only enabled correct rules (Q057 out,
      // inapplicable Q052 and js H006 still loop work), 0-based, before-rule.
      expect(progress.filter((p) => p.phase === 'correct')).toEqual([
        { ruleId: 'Q047', index: 0, total: 6, phase: 'correct' },
        { ruleId: 'Q048', index: 1, total: 6, phase: 'correct' },
        { ruleId: 'Q050', index: 2, total: 6, phase: 'correct' },
        { ruleId: 'Q052', index: 3, total: 6, phase: 'correct' },
        { ruleId: 'Q055', index: 4, total: 6, phase: 'correct' },
        { ruleId: 'H006', index: 5, total: 6, phase: 'correct' },
      ]);
      // Q038's outlier flag now carries the CORRECTED rent value (1500, not
      // 150000): validations run on post-correction data.
      const q038 = (await runQC(db.runner, [KEYS, CONSISTENCY, CORRECTIONS])).flags.filter(
        (f) => f.ruleId === 'Q038' && f.scope === 'cell',
      );
      expect(q038).toEqual([expect.objectContaining({ row: 7, value: 1500 })]);
    } finally {
      db.close();
    }
  });

  it('parity manifest — the shared node⇄browser expectation holds on the node tier', async () => {
    const db = await openQcTyped();
    try {
      const run = await runQC(db.runner, pick(...PARITY_RULE_IDS), {
        jsSandbox: createQuickJSSandbox(), // H006 is in the parity set since P13
      });
      const comments = Object.fromEntries(ALL_RULES.map((r) => [r.ruleId, r.comment]));
      const expected = expectedParityResult(comments);
      expect(run.flags).toEqual(expected.flags);
      expect(run.perRule.map((s) => [s.ruleId, s.status, s.violationCount])).toEqual(
        expected.perRule,
      );
      expect(run.correctedCells).toBe(expected.correctedCells);
    } finally {
      db.close();
    }
  });
});

describe('runQC corrections on scratch tables', () => {
  it('T-CORRECT-ORDER — Q047 before Q050 recodes the sentinel; reversed treats it as cents', async () => {
    const seed = [
      `CREATE TABLE quac_typed (__row__ BIGINT, monthly_rent INTEGER,
         wage_income_annual INTEGER, selfemp_income_annual INTEGER, credit_card_balance INTEGER)`,
      'INSERT INTO quac_typed VALUES (0, 999999999, 50000, 0, 100)',
    ];

    const fileOrder = await openDuckDb(seed);
    try {
      const { flags } = await runQC(fileOrder.runner, pick('Q047', 'Q050'));
      expect(await scalar(fileOrder, 'SELECT monthly_rent FROM quac_work')).toBe(-999);
      expect(correctionFlags(flags)).toEqual([
        expect.objectContaining({
          ruleId: 'Q047',
          correction: { before: 999999999, after: -999 },
        }),
      ]);
    } finally {
      fileOrder.close();
    }

    // Reversed order is WRONG by construction — file order is the contract:
    // Q050 first divides the sentinel by 100, then Q047 no longer matches it.
    const reversed = await openDuckDb(seed);
    try {
      const { flags } = await runQC(reversed.runner, pick('Q050', 'Q047'));
      expect(await scalar(reversed, 'SELECT monthly_rent FROM quac_work')).toBe(10000000);
      expect(correctionFlags(flags)).toEqual([
        expect.objectContaining({
          ruleId: 'Q050',
          correction: { before: 999999999, after: 10000000 },
        }),
      ]);
    } finally {
      reversed.close();
    }
  });

  it('T-CORRECT-WINDOW — single-pass: LAG reads pre-rule values, consecutive sentinels stay', async () => {
    const db = await openDuckDb([
      'CREATE TABLE quac_typed (__row__ BIGINT, household_id VARCHAR, wave INTEGER, reference_education INTEGER)',
      "INSERT INTO quac_typed VALUES (0, 'HHX', 1, 3), (1, 'HHX', 2, -999), (2, 'HHX', 3, -888)",
    ]);
    try {
      const { flags, correctedCells } = await runQC(db.runner, pick('Q055'));
      // Wave 2 fills from wave 1 (3); wave 3's LAG sees the PRE-rule wave-2
      // value (-999, not in 1..6) so it stays sentinel — one pass, no cascade.
      expect(correctionFlags(flags)).toEqual([
        expect.objectContaining({ row: 1, correction: { before: -999, after: 3 } }),
      ]);
      expect(correctedCells).toBe(1);
      const rows = await db.runner.query<{ reference_education: number }>(
        'SELECT reference_education FROM quac_work ORDER BY __row__',
      );
      expect(rows.map((r) => r.reference_education)).toEqual([3, 3, -888]);
    } finally {
      db.close();
    }
  });

  it('multi-target __value__ — one rule corrects sentinels across different columns per row', async () => {
    const db = await openDuckDb([
      `CREATE TABLE quac_typed (__row__ BIGINT, monthly_rent INTEGER,
         wage_income_annual INTEGER, selfemp_income_annual INTEGER, credit_card_balance INTEGER)`,
      `INSERT INTO quac_typed VALUES
         (0, 1000, 999, 0, 50),
         (1, 1000, 40000, 0, 888),
         (2, 777, 41000, 0, 60)`,
    ]);
    try {
      const { flags, perRule, correctedCells } = await runQC(db.runner, pick('Q047'));
      expect(correctedCells).toBe(3);
      expect(perRule[0]).toMatchObject({ ruleId: 'Q047', changedCells: 3, violationCount: 3 });
      // Flags arrive per target pair (rule target order), each with the
      // CASE-mapped sentinel recode.
      expect(
        correctionFlags(flags).map((f) => [f.row, f.column, f.correction?.before, f.correction?.after]),
      ).toEqual([
        [0, 'wage_income_annual', 999, -999],
        [2, 'monthly_rent', 777, -777],
        [1, 'credit_card_balance', 888, -888],
      ]);
      const rows = await db.runner.query<Record<string, number>>(
        'SELECT monthly_rent, wage_income_annual, credit_card_balance FROM quac_work ORDER BY __row__',
      );
      expect(rows).toEqual([
        { monthly_rent: 1000, wage_income_annual: -999, credit_card_balance: 50 },
        { monthly_rent: 1000, wage_income_annual: 40000, credit_card_balance: -888 },
        { monthly_rent: -777, wage_income_annual: 41000, credit_card_balance: 60 },
      ]);
    } finally {
      db.close();
    }
  });

  it('broken correction — bad SQL leaves quac_work untouched, later rules still run', async () => {
    const db = await openDuckDb(qcFixtureSetupSql('quac_typed'));
    try {
      const broken = makeRule({
        ruleId: 'X_BAD',
        targetVariables: ['wage_income_annual'],
        condition: 'no_such_column > 0',
        updateExpression: '0',
      });
      const { flags, perRule } = await runQC(db.runner, [
        ...inline(broken),
        ...pick('Q047'),
      ]);
      expect(perRule[0]).toMatchObject({
        ruleId: 'X_BAD',
        status: 'broken',
        violationCount: 0,
        flagsEmitted: 1,
      });
      const xbad = flags.filter((f) => f.ruleId === 'X_BAD');
      expect(xbad).toHaveLength(1); // exactly one dataset-scope error, zero cells
      expect(xbad[0]).toMatchObject({ scope: 'dataset', severity: 'error' });
      expect(xbad[0]?.message).toMatch(/^Rule failed to execute: /);
      // The failed rule mutated nothing; the next rule corrected as normal.
      expect(perRule[1]).toMatchObject({ ruleId: 'Q047', status: 'ok', changedCells: 1 });
      expect(await scalar(db, 'SELECT wage_income_annual FROM quac_work WHERE __row__ = 8')).toBe(
        -999,
      );
    } finally {
      db.close();
    }
  });

  it('row-cap truncation — flags capped per target, the CTAS still corrects every row', async () => {
    const db = await openDuckDb([
      'CREATE TABLE quac_typed AS SELECT range AS __row__, 20000 + CAST(range AS INTEGER) AS monthly_rent FROM range(5)',
    ]);
    try {
      const { flags, perRule } = await runQC(db.runner, pick('Q050'), { rowCapPerRule: 2 });
      expect(perRule[0]).toMatchObject({
        ruleId: 'Q050',
        status: 'ok',
        violationCount: 5, // EXACT, never truncated
        changedCells: 5,
        flagsEmitted: 3, // 2 cell flags + 1 per-target summary
        truncated: true,
      });
      expect(correctionFlags(flags).map((f) => f.row)).toEqual([0, 1]);
      const summary = flags.find((f) => f.scope === 'column');
      expect(summary).toMatchObject({
        ruleId: 'Q050',
        column: 'monthly_rent',
        message: '…and 3 more rows corrected by this rule',
      });
      // The mutation is never capped: all 5 rows converted.
      const rents = await db.runner.query<{ monthly_rent: number }>(
        'SELECT monthly_rent FROM quac_work ORDER BY __row__',
      );
      expect(rents.map((r) => r.monthly_rent)).toEqual([200, 200, 200, 200, 200]);
    } finally {
      db.close();
    }
  });

  it('global flag cap — correction past the cap emits a suppression summary', async () => {
    const db = await openDuckDb([
      'CREATE TABLE quac_typed AS SELECT range AS __row__, 20000 + CAST(range AS INTEGER) AS monthly_rent FROM range(3)',
    ]);
    try {
      const { flags, perRule } = await runQC(db.runner, pick('Q050'), { globalFlagCap: 1 });
      expect(perRule[0]).toMatchObject({
        ruleId: 'Q050',
        violationCount: 3,
        changedCells: 3,
        flagsEmitted: 2, // 1 admitted cell + the suppression summary
        truncated: true,
      });
      expect(correctionFlags(flags)).toHaveLength(1);
      expect(flags.at(-1)?.message).toBe(
        '…and 2 more flags from this rule suppressed (global flag cap reached)',
      );
    } finally {
      db.close();
    }
  });
});
