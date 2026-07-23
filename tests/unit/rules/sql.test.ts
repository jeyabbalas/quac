// Builder snapshots (byte-pinned strings) + scanner semantics for sql.ts:
// __value__ substitution across 4 targets (Q047 shape), string/comment awareness,
// top-level semicolon analysis, and the append-safety postcondition of
// stripTrailingSemicolon that P11 relies on.
import { describe, expect, it } from 'vitest';
import type { QCRule } from '../../../src/core/rules/types';
import {
  analyzeSemicolons,
  containsValueToken,
  correctionCaptureSQL,
  correctionCountSQL,
  ctasRebuildSQL,
  datasetCountSQL,
  datasetFetchSQL,
  expandValueToken,
  jsChunkFetchSQL,
  jsMergeCtasSQL,
  stripTrailingSemicolon,
  substituteValueToken,
  violCountSQL,
  violFetchSQL,
} from '../../../src/core/rules/sql';

const rule = (overrides: Partial<QCRule>): QCRule => ({
  ruleId: 'R1',
  ruleType: 'correct',
  ruleScope: 'row',
  targetVariables: ['a'],
  condition: 'TRUE',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'info',
  comment: '',
  enabled: true,
  sourceFile: 'test',
  rowNumber: 1,
  extras: {},
  ...overrides,
});

describe('expandValueToken', () => {
  it('substitutes the quoted target per target — Q047 shape across 4 targets', () => {
    const q047 = rule({
      targetVariables: [
        'wage_income_annual',
        'selfemp_income_annual',
        'monthly_rent',
        'credit_card_balance',
      ],
      condition: '__value__ IN (777, 888, 999, 999999999)',
      updateExpression: 'CASE __value__ WHEN 777 THEN -777 WHEN 888 THEN -888 ELSE -999 END',
    });
    expect(expandValueToken(q047)).toEqual([
      {
        target: 'wage_income_annual',
        condition: '"wage_income_annual" IN (777, 888, 999, 999999999)',
        expression: 'CASE "wage_income_annual" WHEN 777 THEN -777 WHEN 888 THEN -888 ELSE -999 END',
      },
      {
        target: 'selfemp_income_annual',
        condition: '"selfemp_income_annual" IN (777, 888, 999, 999999999)',
        expression:
          'CASE "selfemp_income_annual" WHEN 777 THEN -777 WHEN 888 THEN -888 ELSE -999 END',
      },
      {
        target: 'monthly_rent',
        condition: '"monthly_rent" IN (777, 888, 999, 999999999)',
        expression: 'CASE "monthly_rent" WHEN 777 THEN -777 WHEN 888 THEN -888 ELSE -999 END',
      },
      {
        target: 'credit_card_balance',
        condition: '"credit_card_balance" IN (777, 888, 999, 999999999)',
        expression:
          'CASE "credit_card_balance" WHEN 777 THEN -777 WHEN 888 THEN -888 ELSE -999 END',
      },
    ]);
  });

  it('emits identical pairs per target when the token is absent', () => {
    const r = rule({
      targetVariables: ['x', 'y'],
      condition: 'tenure IN (1, 2)',
      updateExpression: '-666',
    });
    expect(expandValueToken(r)).toEqual([
      { target: 'x', condition: 'tenure IN (1, 2)', expression: '-666' },
      { target: 'y', condition: 'tenure IN (1, 2)', expression: '-666' },
    ]);
  });

  it('leaves a js update_expression untouched while substituting the condition', () => {
    const js = rule({
      updateLanguage: 'js',
      condition: '__value__ IS NOT NULL',
      updateExpression: '(value, row) => String(value) // __value__ is not SQL here',
    });
    expect(expandValueToken(js)).toEqual([
      {
        target: 'a',
        condition: '"a" IS NOT NULL',
        expression: '(value, row) => String(value) // __value__ is not SQL here',
      },
    ]);
  });
});

describe('substituteValueToken / containsValueToken', () => {
  it('skips string literals, comments, and quoted identifiers', () => {
    expect(substituteValueToken("note = '__value__' AND __value__ > 0", '"t"')).toBe(
      'note = \'__value__\' AND "t" > 0',
    );
    expect(substituteValueToken('__value__ > 0 -- __value__ stays', '"t"')).toBe(
      '"t" > 0 -- __value__ stays',
    );
    expect(substituteValueToken('/* __value__ */ __value__ = 1', '"t"')).toBe(
      '/* __value__ */ "t" = 1',
    );
    expect(substituteValueToken('"__value__" = 1', '"t"')).toBe('"__value__" = 1');
    expect(containsValueToken("'__value__'")).toBe(false);
  });

  it('matches the bare identifier only, case-insensitively', () => {
    expect(substituteValueToken('__VALUE__ = 1', '"t"')).toBe('"t" = 1');
    expect(substituteValueToken('a__value__b = 1', '"t"')).toBe('a__value__b = 1');
    expect(substituteValueToken('x__value__ = 1', '"t"')).toBe('x__value__ = 1');
    expect(containsValueToken('a__value__b')).toBe(false);
    expect(containsValueToken('ABS(__value__)')).toBe(true);
  });
});

describe('analyzeSemicolons', () => {
  it('finds only top-level semicolons', () => {
    expect(analyzeSemicolons("SELECT ';' AS x -- ;\n/* ; /* ; */ ; */ FROM t").positions).toEqual(
      [],
    );
    expect(analyzeSemicolons('SELECT 1; SELECT 2').positions).toHaveLength(1);
    expect(analyzeSemicolons('SELECT 1; SELECT 2').trailing).toBe(false);
    expect(analyzeSemicolons('SELECT 1;').trailing).toBe(true);
    expect(analyzeSemicolons('SELECT 1;  -- done').trailing).toBe(true);
    expect(analyzeSemicolons('SELECT $$a;b$$').positions).toEqual([]);
  });
});

describe('stripTrailingSemicolon', () => {
  it('removes one trailing semicolon plus trailing whitespace/comments after it', () => {
    expect(stripTrailingSemicolon('SELECT 1;')).toBe('SELECT 1');
    expect(stripTrailingSemicolon('SELECT 1 ; ')).toBe('SELECT 1 ');
    expect(stripTrailingSemicolon('SELECT 1; -- tail')).toBe('SELECT 1');
    expect(stripTrailingSemicolon('SELECT 1 -- c\n;')).toBe('SELECT 1 -- c\n');
  });

  it('leaves non-trailing semicolons and quoted semicolons alone', () => {
    expect(stripTrailingSemicolon("SELECT ';' AS x")).toBe("SELECT ';' AS x");
    expect(stripTrailingSemicolon('SELECT 1; SELECT 2')).toBe('SELECT 1; SELECT 2');
    expect(stripTrailingSemicolon('SELECT 1')).toBe('SELECT 1');
  });

  it('keeps the result safely appendable (P11 appends " LIMIT n")', () => {
    // An unterminated line comment at EOF is closed with a newline.
    expect(stripTrailingSemicolon('SELECT 1 -- note')).toBe('SELECT 1 -- note\n');
    expect(stripTrailingSemicolon('SELECT 1 /* c */;')).toBe('SELECT 1 /* c */');
    for (const input of ['SELECT 1;', 'SELECT 1; -- t', 'SELECT 1 -- note', 'SELECT 1 -- c\n;']) {
      const appended = `${stripTrailingSemicolon(input)} LIMIT 5`;
      // The LIMIT must land outside any comment: strip line comments and confirm
      // the keyword survives.
      expect(appended.replace(/--[^\n]*/g, '')).toContain('LIMIT 5');
    }
  });
});

describe('wrapper builders (engine §3 pseudocode, byte-pinned)', () => {
  it('violation count + fetch wrappers', () => {
    expect(violCountSQL('wave > 20')).toBe(
      'SELECT COUNT(*) FROM (SELECT (wave > 20) AS viol FROM data) WHERE viol',
    );
    expect(violFetchSQL('wave > 20', ['wave', 'household_id'], 10_000)).toBe(
      'SELECT __row__, "wave", "household_id" FROM (SELECT *, (wave > 20) AS viol FROM data) ' +
        'WHERE viol ORDER BY __row__ LIMIT 10000',
    );
    expect(violFetchSQL('TRUE', [], 5)).toBe(
      'SELECT __row__ FROM (SELECT *, (TRUE) AS viol FROM data) ' +
        'WHERE viol ORDER BY __row__ LIMIT 5',
    );
  });

  it('correction capture wrappers (no-op suppression via IS DISTINCT FROM)', () => {
    expect(
      correctionCountSQL(
        '"monthly_rent" >= 20000',
        'ROUND("monthly_rent" / 100.0)',
        'monthly_rent',
      ),
    ).toBe(
      'SELECT COUNT(*) FROM (SELECT (ROUND("monthly_rent" / 100.0)) AS after, ' +
        '"monthly_rent" AS before, ("monthly_rent" >= 20000) AS hit FROM data) ' +
        'WHERE hit AND after IS DISTINCT FROM before',
    );
    expect(correctionCaptureSQL('c', 'e', 'weird "col"', 10)).toBe(
      'SELECT __row__, before, after FROM (SELECT __row__, "weird ""col""" AS before, ' +
        '(e) AS after, (c) AS hit FROM data) ' +
        'WHERE hit AND after IS DISTINCT FROM before ORDER BY __row__ LIMIT 10',
    );
  });

  it('dataset SELECT wrappers — cap append + exact-count wrapper', () => {
    expect(datasetFetchSQL('SELECT wave FROM data ORDER BY wave;', 201)).toBe(
      'SELECT wave FROM data ORDER BY wave LIMIT 201',
    );
    // Unterminated line comment: stripTrailingSemicolon closes it so the
    // appended LIMIT / closing paren land outside the comment.
    expect(datasetFetchSQL('SELECT 1 -- note', 5)).toBe('SELECT 1 -- note\n LIMIT 5');
    expect(datasetCountSQL('SELECT wave FROM data ORDER BY wave;')).toBe(
      'SELECT COUNT(*) FROM (\nSELECT wave FROM data ORDER BY wave\n)',
    );
    expect(datasetCountSQL('SELECT 1 -- note')).toBe(
      'SELECT COUNT(*) FROM (\nSELECT 1 -- note\n\n)',
    );
  });

  it('atomic CTAS rebuild covering all targets of a rule', () => {
    const pairs = [
      { target: 'a', condition: '"a" = 1', expression: '-"a"' },
      { target: 'b', condition: '"b" = 2', expression: '"b" + 1' },
    ];
    expect(ctasRebuildSQL(pairs)).toBe(
      'CREATE TABLE quac_work_next AS SELECT * REPLACE (' +
        'CASE WHEN ("a" = 1) THEN (-"a") ELSE "a" END AS "a", ' +
        'CASE WHEN ("b" = 2) THEN ("b" + 1) ELSE "b" END AS "b") FROM data',
    );
  });

  it('js keyset chunk fetch + provisional staged-merge CTAS', () => {
    expect(jsChunkFetchSQL('hit_cond', 'household_id', 4999n, 5000)).toBe(
      'SELECT __row__, "household_id" AS value, * FROM (SELECT *, (hit_cond) AS hit FROM data) ' +
        'WHERE hit AND __row__ > 4999 ORDER BY __row__ LIMIT 5000',
    );
    expect(jsMergeCtasSQL('household_id', 'VARCHAR')).toBe(
      'CREATE TABLE quac_work_next AS SELECT data.* REPLACE ' +
        '(CASE WHEN u.__row__ IS NOT NULL THEN CAST(u.val AS VARCHAR) ELSE "household_id" END ' +
        'AS "household_id") FROM data LEFT JOIN __qc_updates u ON data.__row__ = u.__row__',
    );
  });
});
