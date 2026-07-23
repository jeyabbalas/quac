// T-LINT — one test per LintCode asserting the exact file/ruleId/rowNumber/
// csvColumn/severity/message shape: static stages 1–3 (P10), the external-rule
// exemptions, cross-file duplicate-id attribution, the fixtures-lint-clean
// regression (zero issues at ANY severity), and the P12 dataset-dependent
// stages 4–6 (EXPLAIN dry-run on @duckdb/node-api, pertinence, pending-data).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lintRuleFiles,
  lintRuleFilesWithDataset,
  type DatasetLintContext,
} from '../../../src/core/rules/lint';
import { parseRuleFile, type ParsedRuleFile } from '../../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../../src/core/rules/sandbox';
import type { RuleFileLintResult } from '../../../src/core/rules/types';
import { openDuckDb, openQcFixture, type QcFixtureDb } from './support';

const HEADER = 'rule_id,rule_type,rule_scope,target_variables,condition,comment\n';
const FULL_HEADER =
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled\n';

const parse = (text: string, name = 'test.quac.csv'): ParsedRuleFile => parseRuleFile(text, name);
const lintOne = (text: string, name = 'test.quac.csv'): RuleFileLintResult => {
  const result = lintRuleFiles([parse(text, name)])[0];
  if (!result) throw new Error('no lint result');
  return result;
};

describe('stage 1 — file structure', () => {
  it('missing-header (and suppresses the per-row fallout for that column)', () => {
    const { issues, executable } = lintOne(
      'rule_id,rule_type,rule_scope,target_variables,comment\nR1,validate,row,a,c\n',
    );
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'missing-header',
        file: 'test.quac.csv',
        csvColumn: 'condition',
        message: 'Required column "condition" is missing from the header row.',
      },
    ]);
    expect(executable).toBe(0); // file-level structural error blocks execution
  });

  it('empty-file', () => {
    const { issues, ok, ruleCount } = lintOne(HEADER);
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'empty-file',
        file: 'test.quac.csv',
        message: 'File contains no rules (no data rows below the header).',
      },
    ]);
    expect(ok).toBe(false);
    expect(ruleCount).toBe(0);
  });
});

describe('stage 2 — row structural checks', () => {
  it('bad-enum', () => {
    const { issues } = lintOne(`${HEADER}R1,fixup,row,a,a > 1,c\n`);
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'bad-enum',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'rule_type',
        message: 'rule_type "fixup" is not one of validate | correct | external.',
      },
    ]);
  });

  it('missing-field — blank rule_id, blank condition, blank targets', () => {
    expect(lintOne(`${HEADER},validate,row,a,a > 1,c\n`).issues).toEqual([
      {
        severity: 'error',
        code: 'missing-field',
        file: 'test.quac.csv',
        rowNumber: 1,
        csvColumn: 'rule_id',
        message: 'rule_id is required.',
      },
    ]);
    expect(lintOne(`${HEADER}R1,validate,row,a,,c\n`).issues).toEqual([
      {
        severity: 'error',
        code: 'missing-field',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'condition',
        message: 'condition must not be blank — write TRUE for an always-apply correction.',
      },
    ]);
    expect(lintOne(`${HEADER}R1,validate,longitudinal,,a > 1,c\n`).issues).toEqual([
      {
        severity: 'error',
        code: 'missing-field',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'target_variables',
        message: 'target_variables is required for rule_scope=longitudinal.',
      },
    ]);
  });

  it('duplicate-id — cross-file, the LATER occurrence gets the error', () => {
    const a = parse(`${HEADER}R1,validate,row,a,a > 1,c\n`, 'a.quac.csv');
    const b = parse(
      `${HEADER}R2,validate,row,a,a > 1,c\nR1,validate,row,a,a > 2,c\n`,
      'b.quac.csv',
    );
    const [ra, rb] = lintRuleFiles([a, b]);
    expect(ra?.issues).toEqual([]);
    expect(rb?.issues).toEqual([
      {
        severity: 'error',
        code: 'duplicate-id',
        file: 'b.quac.csv',
        ruleId: 'R1',
        rowNumber: 2,
        csvColumn: 'rule_id',
        message: 'rule_id "R1" is already defined in a.quac.csv (row 1).',
      },
    ]);
  });

  it('bad-id', () => {
    const { issues } = lintOne(`${HEADER}9bad,validate,row,a,a > 1,c\n`);
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'bad-id',
        file: 'test.quac.csv',
        ruleId: '9bad',
        rowNumber: 1,
        csvColumn: 'rule_id',
        message: 'rule_id "9bad" must match [A-Za-z][A-Za-z0-9_-]*.',
      },
    ]);
  });

  it('update-on-validate / missing-update with the "did you mean" hints', () => {
    expect(
      lintOne(`${FULL_HEADER}R1,validate,row,a,a > 1,sql,ABS(a),error,c,true\n`).issues,
    ).toEqual([
      {
        severity: 'error',
        code: 'update-on-validate',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'update_expression',
        message:
          'validate rules must leave update_expression blank — did you mean rule_type=correct?',
      },
    ]);
    expect(lintOne(`${FULL_HEADER}R1,correct,row,a,a = 1,sql,,info,c,true\n`).issues).toEqual([
      {
        severity: 'error',
        code: 'missing-update',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'update_expression',
        message: 'correct rules require an update_expression — did you mean rule_type=validate?',
      },
    ]);
  });

  it('bad-scope-combo — the only two invalid (type,scope) combos', () => {
    expect(lintOne(`${FULL_HEADER}R1,correct,column,a,unique,sql,-1,info,c,true\n`).issues).toEqual(
      [
        {
          severity: 'error',
          code: 'bad-scope-combo',
          file: 'test.quac.csv',
          ruleId: 'R1',
          rowNumber: 1,
          csvColumn: 'rule_scope',
          message:
            'correct rules cannot use rule_scope=column — use rule_scope=row with __value__.',
        },
      ],
    );
    expect(lintOne(`${FULL_HEADER}R1,correct,dataset,,TRUE,sql,-1,info,c,true\n`).issues).toEqual([
      {
        severity: 'error',
        code: 'bad-scope-combo',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'rule_scope',
        message: 'correct rules cannot use rule_scope=dataset.',
      },
    ]);
  });

  it('semicolon — single-statement gate; dataset allows exactly one trailing ";"', () => {
    expect(lintOne(`${HEADER}R1,validate,row,a,a > 1; DROP TABLE x,c\n`).issues).toEqual([
      {
        severity: 'error',
        code: 'semicolon',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'condition',
        message: 'condition must be a single SQL expression — top-level ";" is not allowed.',
      },
    ]);
    expect(lintOne(`${HEADER}R1,validate,dataset,,SELECT 1;,c\n`).issues).toEqual([]);
    expect(lintOne(`${HEADER}R1,validate,dataset,,SELECT 1; SELECT 2,c\n`).issues).toEqual([
      {
        severity: 'error',
        code: 'semicolon',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'condition',
        message:
          'condition may end with at most one trailing ";" — rule SQL must be a single statement.',
      },
    ]);
    expect(
      lintOne(`${FULL_HEADER}R1,correct,row,a,TRUE,sql,-666; DROP TABLE x,info,c,true\n`).issues,
    ).toEqual([
      {
        severity: 'error',
        code: 'semicolon',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'update_expression',
        message:
          'update_expression must be a single SQL expression — top-level ";" is not allowed.',
      },
    ]);
    // js expressions are never scanned; quoted ';' in SQL is not top-level
    expect(
      lintOne(
        `${FULL_HEADER}R1,correct,row,a,TRUE,js,(v) => { const x = 1; return x; },info,c,true\n`,
      ).issues,
    ).toEqual([]);
    expect(lintOne(`${HEADER}R1,validate,row,a,a = ';',c\n`).issues).toEqual([]);
  });

  it('value-token-misuse — error on validate; info on multi-target correct without __value__', () => {
    expect(lintOne(`${HEADER}R1,validate,row,a,__value__ > 0,c\n`).issues).toEqual([
      {
        severity: 'error',
        code: 'value-token-misuse',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'condition',
        message: '__value__ is only available in correct rules.',
      },
    ]);
    expect(lintOne(`${FULL_HEADER}R1,correct,row,a|b,x > 0,sql,-666,info,c,true\n`).issues).toEqual(
      [
        {
          severity: 'info',
          code: 'value-token-misuse',
          file: 'test.quac.csv',
          ruleId: 'R1',
          rowNumber: 1,
          csvColumn: 'update_expression',
          message:
            'all 2 targets receive the same expression value — use __value__ to reference each target column.',
        },
      ],
    );
    // single-target corrects without the token stay silent (Q048/Q050/Q057 shape)
    expect(lintOne(`${FULL_HEADER}R1,correct,row,a,x > 0,sql,-666,info,c,true\n`).issues).toEqual(
      [],
    );
    // a '__value__' inside a string literal is not the bare token
    expect(lintOne(`${HEADER}R1,validate,row,a,note = '__value__',c\n`).issues).toEqual([]);
  });

  it('smart-quotes — warned in SQL cells, accepted in comments', () => {
    expect(lintOne(`${HEADER}R1,validate,row,a,name = ’x’,c\n`).issues).toEqual([
      {
        severity: 'warning',
        code: 'smart-quotes',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'condition',
        message: 'condition contains smart quotes (‘ ’ “ ”) — did you paste from a word processor?',
      },
    ]);
    expect(lintOne(`${HEADER}R1,validate,row,a,a > 1,“fancy note”\n`).issues).toEqual([]);
  });

  it('extra-columns — file-level info', () => {
    const { issues } = lintOne(`${HEADER.trimEnd()},notes\nR1,validate,row,a,a > 1,c,keep\n`);
    expect(issues).toEqual([
      {
        severity: 'info',
        code: 'extra-columns',
        file: 'test.quac.csv',
        message: 'Unknown columns preserved for round-trip: notes.',
      },
    ]);
  });

  it('empty-comment — warning, fallback text deferred to the renderer', () => {
    const { issues } = lintOne(`${HEADER}R1,validate,row,a,a > 1,\n`);
    expect(issues).toEqual([
      {
        severity: 'warning',
        code: 'empty-comment',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'comment',
        message: 'comment is blank — a generic fallback text will be generated for the report.',
      },
    ]);
  });
});

describe('stage 3 — assertions and SELECT placement', () => {
  it('bad-assertion — SQL or unknown names in column scope', () => {
    const sql = lintOne(`${HEADER}R1,validate,column,a,a > 1,c\n`).issues;
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatchObject({
      severity: 'error',
      code: 'bad-assertion',
      file: 'test.quac.csv',
      ruleId: 'R1',
      rowNumber: 1,
      csvColumn: 'condition',
    });
    expect(sql[0]?.message).toContain('invalid column assertion');
    const unknown = lintOne(`${HEADER}R1,validate,column,a,"in_rage(1, 2)",c\n`).issues;
    expect(unknown[0]?.message).toContain('unknown assertion "in_rage"');
  });

  it('select-in-row-scope', () => {
    const { issues } = lintOne(`${HEADER}R1,validate,row,a,SELECT * FROM data,c\n`);
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'select-in-row-scope',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'condition',
        message: 'condition is a SELECT statement — use rule_scope=dataset for queries.',
      },
    ]);
    // 'selected_flag = 1' must not trip the word-boundary check
    expect(lintOne(`${HEADER}R1,validate,row,a,selected_flag = 1,c\n`).issues).toEqual([]);
  });

  it('smart quotes in a column assertion get the word-processor hint alongside bad-assertion', () => {
    const { issues } = lintOne(`${HEADER}R1,validate,column,a,match_regex(‘re’),c\n`);
    expect(issues.map((i) => i.code).sort()).toEqual(['bad-assertion', 'smart-quotes']);
  });
});

describe('external rules — free text is exempt from SQL-shaped checks', () => {
  it('accepts prose conditions, blank targets, and skips every SQL scan', () => {
    const csv =
      FULL_HEADER +
      `X1,external,row,,Linkage consent must cover the attached records.,,,warning,c1,true\n` +
      `X2,external,row,t,"Select records; check ’consent’ = __value__",,,warning,c2,true\n` +
      `X3,external,column,t,not an assertion at all,,,info,c3,true\n`;
    const { issues, executable, ruleCount } = lintOne(csv);
    expect(issues).toEqual([]);
    expect(ruleCount).toBe(3);
    expect(executable).toBe(3);
  });

  it('still checks identity, enums, blank condition, and comments', () => {
    const { issues } = lintOne(`${FULL_HEADER}9x,external,row,t,,,,warning,,true\n`);
    expect(issues.map((i) => i.code).sort()).toEqual(['bad-id', 'empty-comment', 'missing-field']);
  });
});

describe('result shape', () => {
  it('sorts issues by row, then code, then column; ok reflects error presence', () => {
    const csv =
      FULL_HEADER +
      `R1,validate,row,a,a > 1,,,error,,true\n` +
      `R1,fixup,row,,__value__ > 0,,,error,c,maybe\n`;
    const { issues, ok, executable } = lintOne(csv);
    expect(issues.map((i) => [i.rowNumber, i.code])).toEqual([
      [1, 'empty-comment'],
      [2, 'bad-enum'],
      [2, 'bad-enum'],
      [2, 'duplicate-id'],
    ]);
    expect(ok).toBe(false);
    expect(executable).toBe(1); // R1 row 1 has only a warning; row 2 is error-laden
  });
});

describe('fixtures lint clean (regression)', () => {
  it('the 3 HESP files + tiny produce ZERO issues at any severity in one load', () => {
    const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');
    const load = (rel: string): ParsedRuleFile => {
      const name = rel.split('/').pop() ?? rel;
      return parseRuleFile(readFileSync(resolve(FIXTURES, rel), 'utf8'), name);
    };
    const results = lintRuleFiles([
      load('hesp/rules/hesp_keys_and_structure.quac.csv'),
      load('hesp/rules/hesp_consistency.quac.csv'),
      load('hesp/rules/hesp_corrections.quac.csv'),
      load('tiny/people_rules.quac.csv'),
    ]);
    for (const result of results) {
      expect(result.issues, `${result.file} must lint clean`).toEqual([]);
      expect(result.ok).toBe(true);
    }
    expect(results.map((r) => [r.ruleCount, r.executable])).toEqual([
      [10, 10],
      [5, 5],
      [7, 6], // Q057 (disclosure top-code) ships disabled
      [6, 6],
    ]);
  });
});

describe('stages 4–6 — dataset-dependent lint (P12)', () => {
  const openScratch = (): Promise<QcFixtureDb> =>
    openDuckDb([
      // __row__ is always present on the real view (injected at ingest);
      // datasetColumns below mirrors DatasetSession.columns (excludes it).
      'CREATE TABLE t (__row__ BIGINT, a INTEGER, b INTEGER, "Age" INTEGER)',
      'CREATE VIEW data AS SELECT * FROM t',
    ]);
  const scratchCtx = (db: QcFixtureDb): DatasetLintContext => ({
    runner: db.runner,
    datasetColumns: ['a', 'b', 'Age'],
  });
  const withScratch = async (
    fn: (ctx: DatasetLintContext) => Promise<void>,
  ): Promise<void> => {
    const db = await openScratch();
    try {
      await fn(scratchCtx(db));
    } finally {
      db.close();
    }
  };
  const lintWith = async (
    text: string,
    ctx: DatasetLintContext | null,
  ): Promise<RuleFileLintResult> => {
    const result = (await lintRuleFilesWithDataset([parse(text)], ctx))[0];
    if (!result) throw new Error('no lint result');
    return result;
  };

  it('pending-data — reported without a dataset, resolved when one arrives', async () => {
    const csv = `${HEADER}R1,validate,row,a,a > 1,c\n`;
    const before = await lintWith(csv, null);
    expect(before.issues).toEqual([
      {
        severity: 'info',
        code: 'pending-data',
        file: 'test.quac.csv',
        message: 'SQL checks are pending until a dataset is loaded.',
      },
    ]);
    await withScratch(async (ctx) => {
      const after = await lintWith(csv, ctx);
      expect(after.issues).toEqual([]); // resolved — clean dry-run, targets present
      expect(after.pertinence).toEqual({ targetsFound: 1, targetsTotal: 1, missing: [] });
    });
  });

  it('pending-data — external-only files have nothing pending', async () => {
    const csv = `${HEADER}R1,external,row,a,free text describing a linkage check,c\n`;
    const result = await lintWith(csv, null);
    expect(result.issues).toEqual([]);
  });

  it('sql-error — binder error surfaced with exact location and raw detail', async () => {
    await withScratch(async (ctx) => {
      const { issues, executable } = await lintWith(`${HEADER}R1,validate,row,a,no_col > 1,c\n`, ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        severity: 'error',
        code: 'sql-error',
        file: 'test.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'condition',
      });
      expect(issues[0]?.message).toMatch(/^condition failed the SQL dry-run: /);
      expect(issues[0]?.message).toContain('no_col');
      expect(issues[0]?.detail).toContain('no_col'); // raw DuckDB message
      expect(executable).toBe(0); // sql-error excludes the rule from runs
    });
  });

  it('sql-error — smart-quote hint appended when the SQL contains smart quotes', async () => {
    await withScratch(async (ctx) => {
      const { issues } = await lintWith(`${HEADER}R1,validate,row,a,"a > ’1’",c\n`, ctx);
      const sqlError = issues.find((i) => i.code === 'sql-error');
      expect(sqlError?.message).toContain('smart quotes — did you paste from a word processor?');
      expect(issues.some((i) => i.code === 'smart-quotes')).toBe(true); // stage-2 static warning stays
    });
  });

  it('sql-error — correct rules attribute condition vs update_expression separately', async () => {
    await withScratch(async (ctx) => {
      const badUpdate = await lintWith(
        `${FULL_HEADER}R1,correct,row,a,a > 1,sql,no_col + 1,info,c,true\n`,
        ctx,
      );
      expect(badUpdate.issues.map((i) => [i.code, i.csvColumn])).toEqual([
        ['sql-error', 'update_expression'],
      ]);
      const badCondition = await lintWith(
        `${FULL_HEADER}R2,correct,row,a,no_col > 1,sql,a + 1,info,c,true\n`,
        ctx,
      );
      // Condition failure reports once — the rebuild SELECT is not also run.
      expect(badCondition.issues.map((i) => [i.code, i.csvColumn])).toEqual([
        ['sql-error', 'condition'],
      ]);
    });
  });

  it('sql-error — dataset rule carrying its own LIMIT breaks under the appended cap (P11 known edge)', async () => {
    await withScratch(async (ctx) => {
      const { issues } = await lintWith(
        `${HEADER}R1,validate,dataset,,"SELECT a FROM data LIMIT 5",c\n`,
        ctx,
      );
      expect(issues.map((i) => i.code)).toEqual(['sql-error']);
    });
  });

  it('sql-error — assertion arguments are dry-run too (monotonic order_by)', async () => {
    await withScratch(async (ctx) => {
      const { issues } = await lintWith(
        `${HEADER}R1,validate,column,a,"monotonic(increasing, order_by=no_col)",c\n`,
        ctx,
      );
      expect(issues.map((i) => i.code)).toEqual(['sql-error']);
    });
  });

  it('sql-error — disabled rules are still dry-run (one toggle from running)', async () => {
    await withScratch(async (ctx) => {
      const { issues, executable } = await lintWith(
        `${FULL_HEADER}R1,validate,row,a,no_col > 1,,,error,c,false\n`,
        ctx,
      );
      expect(issues.map((i) => i.code)).toEqual(['sql-error']);
      expect(executable).toBe(0);
    });
  });

  it('unknown-target — missing targets warn, mark the rule inapplicable, and fill pertinence', async () => {
    await withScratch(async (ctx) => {
      const csv = `${HEADER}R1,validate,row,a|nope,a > 1 AND nope > 2,c\nR2,validate,row,a,a > 1,c\n`;
      const { issues, executable, pertinence } = await lintWith(csv, ctx);
      expect(issues).toEqual([
        {
          severity: 'warning',
          code: 'unknown-target',
          file: 'test.quac.csv',
          ruleId: 'R1',
          rowNumber: 1,
          csvColumn: 'target_variables',
          message:
            'target columns missing from the dataset: nope — rule is inapplicable and will be skipped at run.',
        },
      ]);
      expect(executable).toBe(1); // R1 enabled but inapplicable; R2 runs
      expect(pertinence).toEqual({ targetsFound: 1, targetsTotal: 2, missing: ['nope'] });
    });
  });

  it('unknown-target — case near-miss adds the dataset spelling as a hint', async () => {
    await withScratch(async (ctx) => {
      const { issues } = await lintWith(`${HEADER}R1,validate,row,age,age > 1,c\n`, ctx);
      const missing = issues.find((i) => i.code === 'unknown-target');
      expect(missing?.message).toContain('case mismatch? dataset has: Age');
      // 0/1 targets present → the file-level pertinence banner fires too.
      expect(issues.some((i) => i.code === 'pertinence')).toBe(true);
    });
  });

  it('pertinence — file-level banner below 50% target coverage', async () => {
    await withScratch(async (ctx) => {
      const csv = `${HEADER}R1,validate,row,x,x > 1,c\nR2,validate,row,y,y > 1,c\nR3,validate,row,a,a > 1,c\n`;
      const { issues } = await lintWith(csv, ctx);
      const banner = issues.find((i) => i.code === 'pertinence');
      expect(banner).toMatchObject({ severity: 'warning', file: 'test.quac.csv' });
      expect(banner?.message).toContain('only 1 of 3 rule target columns are present');
      expect(banner?.rowNumber).toBeUndefined(); // file-level
    });
  });

  it('js rules — condition is dry-run; compile check pends without a sandbox source', async () => {
    await withScratch(async (ctx) => {
      const csv = `${FULL_HEADER}R1,correct,row,a,a > 1,js,"(value, row) => value",info,c,true\n`;
      const { issues } = await lintWith(csv, ctx);
      expect(issues).toEqual([
        {
          severity: 'info',
          code: 'pending-data',
          file: 'test.quac.csv',
          ruleId: 'R1',
          rowNumber: 1,
          csvColumn: 'update_expression',
          message: 'JS compile check pending — no sandbox available.',
        },
      ]);
      const badCond = await lintWith(
        `${FULL_HEADER}R2,correct,row,a,no_col > 1,js,"(value, row) => value",info,c,true\n`,
        ctx,
      );
      expect(badCond.issues.map((i) => i.code).sort()).toEqual(['pending-data', 'sql-error']);
    });
  });

  describe('stage 5 — QuickJS compile checks (P13)', () => {
    const js = { loadSandbox: () => Promise.resolve(createQuickJSSandbox()) };
    const lintJs = async (
      text: string,
      ctx: DatasetLintContext | null,
      opts = js,
    ): Promise<RuleFileLintResult> => {
      const result = (await lintRuleFilesWithDataset([parse(text)], ctx, opts))[0];
      if (!result) throw new Error('no lint result');
      return result;
    };
    const GOOD = `${FULL_HEADER}R1,correct,row,a,a > 1,js,"(value, row) => value + 1",info,c,true\n`;
    const BAD = `${FULL_HEADER}R1,correct,row,a,a > 1,js,"(value, row => {",info,c,true\n`;

    it('a compiling js rule lints clean — the P12 pending is gone', async () => {
      await withScratch(async (ctx) => {
        const result = await lintJs(GOOD, ctx);
        expect(result.issues).toEqual([]);
        expect(result.executable).toBe(1);
      });
    });

    it('a broken js rule gets js-error with the raw QuickJS detail and drops from executable', async () => {
      await withScratch(async (ctx) => {
        const result = await lintJs(BAD, ctx);
        expect(result.issues).toEqual([
          expect.objectContaining({
            severity: 'error',
            code: 'js-error',
            ruleId: 'R1',
            rowNumber: 1,
            csvColumn: 'update_expression',
          }),
        ]);
        expect(result.issues[0]?.message).toMatch(
          /^update_expression failed the JS compile check: SyntaxError/,
        );
        expect(result.issues[0]?.detail).toMatch(/SyntaxError/);
        expect(result.ok).toBe(false);
        expect(result.executable).toBe(0);
      });
    });

    it('a non-function expression is a js-error too', async () => {
      await withScratch(async (ctx) => {
        const result = await lintJs(
          `${FULL_HEADER}R1,correct,row,a,a > 1,js,42,info,c,true\n`,
          ctx,
        );
        expect(result.issues[0]?.message).toMatch(/must evaluate to a function/);
      });
    });

    it('compile checks are dataset-independent — they run with ctx === null', async () => {
      const result = await lintJs(BAD, null);
      expect(result.issues.map((i) => i.code).sort()).toEqual(['js-error', 'pending-data']);
      // The file-level SQL pending stays until a dataset arrives.
      expect(result.issues.find((i) => i.code === 'pending-data')?.message).toBe(
        'SQL checks are pending until a dataset is loaded.',
      );
    });

    it('inapplicable js rules still compile-check (applicability does not gate stage 5)', async () => {
      await withScratch(async (ctx) => {
        const result = await lintJs(
          `${FULL_HEADER}R1,correct,row,missing_col,missing_col > 1,js,"(value, row => {",info,c,true\n`,
          ctx,
        );
        // pertinence: 0 of 1 targets present also raises the file banner.
        expect(result.issues.map((i) => i.code).sort()).toEqual([
          'js-error',
          'pertinence',
          'unknown-target',
        ]);
      });
    });

    it('pending resolves to a real result when a sandbox source appears', async () => {
      await withScratch(async (ctx) => {
        const before = await lintWith(GOOD, ctx); // no js option
        expect(before.issues.map((i) => i.code)).toEqual(['pending-data']);
        const after = await lintJs(GOOD, ctx);
        expect(after.issues).toEqual([]);
      });
    });

    it('a failing sandbox load falls back to the pending info', async () => {
      await withScratch(async (ctx) => {
        const result = await lintJs(GOOD, ctx, {
          loadSandbox: () => Promise.reject(new Error('chunk failed to load')),
        });
        expect(result.issues).toEqual([
          expect.objectContaining({
            code: 'pending-data',
            message: 'JS compile check pending — no sandbox available.',
          }),
        ]);
      });
    });

    it('the sandbox source is not consulted for js-free files', async () => {
      await withScratch(async (ctx) => {
        let calls = 0;
        const result = await lintJs(`${HEADER}R1,validate,row,a,a > 1,c\n`, ctx, {
          loadSandbox: () => {
            calls += 1;
            return Promise.resolve(createQuickJSSandbox());
          },
        });
        expect(result.issues).toEqual([]);
        expect(calls).toBe(0); // the lazy-chunk trigger contract
      });
    });
  });

  it('HESP fixtures + qc_fixture — inapplicable rules flagged, everything else dry-runs clean', async () => {
    const db = await openQcFixture();
    try {
      const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');
      const load = (rel: string): ParsedRuleFile => {
        const name = rel.split('/').pop() ?? rel;
        return parseRuleFile(readFileSync(resolve(FIXTURES, rel), 'utf8'), name);
      };
      const columns = await db.runner.query<{ column_name: string }>('DESCRIBE qc_fixture');
      const results = await lintRuleFilesWithDataset(
        [
          load('hesp/rules/hesp_keys_and_structure.quac.csv'),
          load('hesp/rules/hesp_consistency.quac.csv'),
          load('hesp/rules/hesp_corrections.quac.csv'),
        ],
        {
          runner: db.runner,
          datasetColumns: columns
            .map((c) => c.column_name)
            .filter((name) => name !== '__row__'),
        },
      );
      const allIssues = results.flatMap((r) => r.issues);
      expect(allIssues.filter((i) => i.code === 'sql-error')).toEqual([]);
      // Q021 (7 income components) and Q052 (3 debt balances) target columns
      // qc_fixture does not carry; H006 is the js compile-check pending.
      expect(
        allIssues.filter((i) => i.code === 'unknown-target').map((i) => i.ruleId),
      ).toEqual(['Q021', 'Q052']);
      expect(
        allIssues.filter((i) => i.code === 'pending-data').map((i) => i.ruleId),
      ).toEqual(['H006']);
      expect(results.map((r) => [r.file, r.executable])).toEqual([
        ['hesp_keys_and_structure.quac.csv', 10],
        ['hesp_consistency.quac.csv', 4], // Q021 inapplicable
        ['hesp_corrections.quac.csv', 5], // Q052 inapplicable + Q057 disabled
      ]);
    } finally {
      db.close();
    }
  });
});

// ---- P14: executableRuleFile — what the RUN sees (engine-spec §7) ----------
describe('executableRuleFile', () => {
  const csv =
    FULL_HEADER +
    'G1,validate,row,a,a > 1,,,error,Good.,true\n' +
    'B1,validate,row,a,,,,error,No condition.,true\n' + // missing-field error row
    'D1,validate,row,a,a > 2,,,error,Disabled.,false\n';

  it('drops error-severity rows, keeps clean + disabled rules', async () => {
    const { executableRuleFile } = await import('../../../src/core/rules/lint');
    const parsed = parse(csv);
    const result = lintOne(csv);
    const file = executableRuleFile(parsed, result);
    expect(file?.rules.map((r) => r.ruleId)).toEqual(['G1', 'D1']);
  });

  it('file-level structural error excludes the whole file (null)', async () => {
    const { executableRuleFile } = await import('../../../src/core/rules/lint');
    const text = 'rule_id,rule_type,rule_scope,target_variables,comment\nR1,validate,row,a,c\n';
    const file = executableRuleFile(parse(text), lintOne(text));
    expect(file).toBeNull();
  });

  it('clean file passes through unchanged (same reference)', async () => {
    const { executableRuleFile } = await import('../../../src/core/rules/lint');
    const text = `${HEADER}R1,validate,row,a,a > 1,c\n`;
    const parsed = parse(text);
    expect(executableRuleFile(parsed, lintOne(text))).toBe(parsed.file);
  });
});
