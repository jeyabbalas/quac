// P17 draft-rule lint: the synthetic one-rule wrap must surface the engine's
// REAL stage-4 EXPLAIN errors (actual DuckDB via @duckdb/node-api), bucket
// them by CSV column for the form, route file-level issues to `general`, and
// mirror lint's cross-file duplicate-id message with editing-self exclusion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucketStoredIssues, runDraftLint } from '../../../src/ui/views/studio/draftLint';
import { lintRuleFilesWithDataset } from '../../../src/core/rules/lint';
import { parseRuleFile } from '../../../src/core/rules/parse';
import type { DatasetLintContext } from '../../../src/core/rules/lint';
import type { QCRule } from '../../../src/core/rules/types';
import { openDuckDb, type QcFixtureDb } from '../rules/support';

const HEADER = 'rule_id,rule_type,rule_scope,target_variables,condition,comment\n';

let db: QcFixtureDb;
let ctx: DatasetLintContext;

beforeAll(async () => {
  db = await openDuckDb([
    'CREATE TABLE studio_fixture(__row__ BIGINT, record_id VARCHAR, wave INTEGER)',
    "INSERT INTO studio_fixture VALUES (0, 'A', 1), (1, 'B', 2)",
    'CREATE VIEW data AS SELECT * FROM studio_fixture',
  ]);
  ctx = { runner: db.runner, datasetColumns: ['record_id', 'wave'] };
});

afterAll(() => {
  db.close();
});

const draft = (overrides: Partial<QCRule>): QCRule => ({
  ruleId: 'D1',
  ruleType: 'validate',
  ruleScope: 'row',
  targetVariables: ['record_id'],
  condition: 'record_id IS NULL',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'error',
  comment: 'draft',
  enabled: true,
  sourceFile: '',
  rowNumber: 0,
  extras: {},
  ...overrides,
});

describe('runDraftLint', () => {
  it('clean draft with a dataset: ok, no issues', async () => {
    const result = await runDraftLint(draft({}), 'work.quac.csv', null, { ctx, files: [] });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.general).toEqual([]);
  });

  it("typo'd column → sql-error bucketed under condition, with the binder detail", async () => {
    const result = await runDraftLint(
      draft({ condition: 'recrd_id IS NULL' }),
      'work.quac.csv',
      null,
      { ctx, files: [] },
    );
    expect(result.ok).toBe(false);
    const issue = result.byField.condition?.[0];
    expect(issue?.code).toBe('sql-error');
    expect(issue?.message).toContain('condition failed the SQL dry-run:');
    expect(issue?.detail).toContain('recrd_id');
  });

  it('broken update_expression → sql-error bucketed under update_expression', async () => {
    const result = await runDraftLint(
      draft({
        ruleType: 'correct',
        targetVariables: ['wave'],
        condition: 'wave > 1',
        updateExpression: 'nonexistent_col + 1',
        severity: 'info',
      }),
      'work.quac.csv',
      null,
      { ctx, files: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.byField.condition).toBeUndefined();
    const issue = result.byField.update_expression?.[0];
    expect(issue?.code).toBe('sql-error');
    expect(issue?.detail).toContain('nonexistent_col');
  });

  it('no dataset context → pending-data lands in general, draft still ok', async () => {
    const result = await runDraftLint(draft({}), 'work.quac.csv', null, { ctx: null, files: [] });
    expect(result.ok).toBe(true);
    expect(result.general.map((i) => i.code)).toEqual(['pending-data']);
    expect(result.general[0]?.message).toBe('SQL checks are pending until a dataset is loaded.');
    expect(result.byField.condition).toBeUndefined();
  });

  it('bad assertion (column scope) → bad-assertion under condition', async () => {
    const result = await runDraftLint(
      draft({ ruleScope: 'column', condition: 'frobnicate(1)' }),
      'work.quac.csv',
      null,
      { ctx, files: [] },
    );
    expect(result.ok).toBe(false);
    const issue = result.byField.condition?.[0];
    expect(issue?.code).toBe('bad-assertion');
    expect(issue?.message).toContain('unknown assertion "frobnicate"');
  });

  it('unknown target → unknown-target under target_variables, banner in general', async () => {
    const result = await runDraftLint(
      draft({ targetVariables: ['no_such_col'], condition: 'no_such_col IS NULL' }),
      'work.quac.csv',
      null,
      { ctx, files: [] },
    );
    expect(result.ok).toBe(true); // warnings only — partial acceptance
    expect(result.byField.target_variables?.[0]?.code).toBe('unknown-target');
    expect(result.general.map((i) => i.code)).toEqual(['pertinence']);
  });

  describe('cross-file duplicate-id', () => {
    const loaded = parseRuleFile(
      `${HEADER}R1,validate,row,record_id,record_id IS NULL,first\n` +
        `R2,validate,row,wave,wave > 99,second\n`,
      'loaded.quac.csv',
    );

    it('flags a clash with any loaded rule, message matching lint', async () => {
      const result = await runDraftLint(draft({ ruleId: 'R2' }), 'work.quac.csv', null, {
        ctx,
        files: [loaded],
      });
      expect(result.ok).toBe(false);
      expect(result.byField.rule_id?.[0]).toEqual({
        severity: 'error',
        code: 'duplicate-id',
        file: 'work.quac.csv',
        ruleId: 'R2',
        rowNumber: 1,
        csvColumn: 'rule_id',
        message: 'rule_id "R2" is already defined in loaded.quac.csv (row 2).',
      });
    });

    it('excludes the rule being edited — keeping your own id is not a clash', async () => {
      const editingSelf = await runDraftLint(
        draft({ ruleId: 'R2' }),
        'loaded.quac.csv',
        { fileName: 'loaded.quac.csv', index: 1 },
        { ctx, files: [loaded] },
      );
      expect(editingSelf.byField.rule_id).toBeUndefined();

      const editingOther = await runDraftLint(
        draft({ ruleId: 'R2' }),
        'loaded.quac.csv',
        { fileName: 'loaded.quac.csv', index: 0 },
        { ctx, files: [loaded] },
      );
      expect(editingOther.byField.rule_id?.[0]?.code).toBe('duplicate-id');
    });
  });

  describe('bucketStoredIssues (P18 import-back seed)', () => {
    it('picks only the opened row, bucketed by field', async () => {
      const stored = parseRuleFile(
        `${HEADER}R1,validate,row,record_id,record_id IS NULL,fine\n` +
          `R2,validate,row,record_id,recrd_id IS NULL,broken re-import\n`,
        'stored.quac.csv',
      );
      const [result] = await lintRuleFilesWithDataset([stored], ctx);
      if (result === undefined) throw new Error('lint returned no result');

      const broken = bucketStoredIssues(result, 2);
      expect(broken.ok).toBe(false);
      expect(broken.byField.condition?.[0]?.code).toBe('sql-error');
      expect(broken.byField.condition?.[0]?.detail).toContain('recrd_id');
      expect(broken.general).toEqual([]);

      const clean = bucketStoredIssues(result, 1);
      expect(clean.ok).toBe(true);
      expect(clean.issues).toEqual([]);
    });

    it('drops file-level issues — the live draft lint owns those', async () => {
      const stored = parseRuleFile(
        `${HEADER}R1,validate,row,record_id,record_id IS NULL,fine\n`,
        'stored.quac.csv',
      );
      const [result] = await lintRuleFilesWithDataset([stored], null); // no dataset yet
      if (result === undefined) throw new Error('lint returned no result');
      expect(result.issues.some((i) => i.code === 'pending-data')).toBe(true);
      const bucket = bucketStoredIssues(result, 1);
      expect(bucket.issues).toEqual([]); // pending-data is file-level, not row 1's
      expect(bucket.ok).toBe(true);
    });
  });
});
