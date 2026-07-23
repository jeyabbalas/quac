// T-LINT — one test per static LintCode (stages 1–3) asserting the exact
// file/ruleId/rowNumber/csvColumn/severity/message shape, the external-rule
// exemptions, cross-file duplicate-id attribution, and the fixtures-lint-clean
// regression (zero issues at ANY severity).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintRuleFiles } from '../../../src/core/rules/lint';
import { parseRuleFile, type ParsedRuleFile } from '../../../src/core/rules/parse';
import type { RuleFileLintResult } from '../../../src/core/rules/types';

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
