// T-CSV-ROUNDTRIP — .quac.csv parse → serialize → parse fixpoint plus every
// Excel-mangling tolerance the format spec (§7) names. Fixture files are LF/no-BOM
// (committed verbatim from qc-rules-format.md §8); the mangled variants are
// synthesized here because the fixtures deliberately exercise none of them.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRuleFile } from '../../../src/core/rules/parse';
import { serializeRuleFile } from '../../../src/core/rules/serialize';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');
const read = (rel: string): string => readFileSync(resolve(FIXTURES, rel), 'utf8');

const HESP_FILES = [
  'hesp/rules/hesp_keys_and_structure.quac.csv',
  'hesp/rules/hesp_consistency.quac.csv',
  'hesp/rules/hesp_corrections.quac.csv',
] as const;
const ALL_FILES = [...HESP_FILES, 'tiny/people_rules.quac.csv'] as const;

const baseName = (rel: string): string => rel.split('/').pop() ?? rel;

describe('fixture round-trip (T-CSV-ROUNDTRIP)', () => {
  for (const rel of ALL_FILES) {
    it(`model fixpoint + byte idempotence: ${baseName(rel)}`, () => {
      const text = read(rel);
      const p1 = parseRuleFile(text, baseName(rel));
      expect(p1.issues).toEqual([]);
      const s1 = serializeRuleFile(p1.file);
      const p2 = parseRuleFile(s1, baseName(rel));
      expect(p2.issues).toEqual([]);
      expect(p2.file).toEqual(p1.file); // model fixpoint
      expect(serializeRuleFile(p2.file)).toBe(s1); // byte idempotence from first output
    });
  }

  it('parses the HESP fixtures to the §8 shapes', () => {
    const keys = parseRuleFile(read(HESP_FILES[0]), baseName(HESP_FILES[0])).file;
    const consistency = parseRuleFile(read(HESP_FILES[1]), baseName(HESP_FILES[1])).file;
    const corrections = parseRuleFile(read(HESP_FILES[2]), baseName(HESP_FILES[2])).file;

    expect(keys.rules.map((r) => r.ruleId)).toEqual([
      'Q001',
      'Q002',
      'Q003',
      'Q007',
      'H001',
      'H002',
      'H003',
      'H004',
      'H005',
      'Q044',
    ]);
    expect(keys.group).toBe('hesp_keys_and_structure');
    expect(keys.extraColumns).toEqual([]);
    expect(consistency.rules).toHaveLength(5);
    expect(corrections.rules).toHaveLength(7);

    // rowNumber = physical 1-based data row
    expect(keys.rules.map((r) => r.rowNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // multiline SQL preserved with interior indentation (Q021, H005)
    const q021 = consistency.rules.find((r) => r.ruleId === 'Q021');
    expect(q021?.targetVariables).toHaveLength(10);
    expect(q021?.condition).toContain('\n       + retirement_income_annual');
    const h005 = keys.rules.find((r) => r.ruleId === 'H005');
    expect(h005?.ruleScope).toBe('dataset');
    expect(h005?.targetVariables).toEqual(['household_id', 'wave']); // targets legal at dataset scope
    expect(h005?.condition).toContain('\nGROUP BY wave\n');

    // multiline JS preserved byte-for-byte, including regex backslashes (H006)
    const h006 = corrections.rules.find((r) => r.ruleId === 'H006');
    expect(h006?.updateLanguage).toBe('js');
    expect(h006?.updateExpression).toContain('/^hh[\\s_-]*([0-9]{1,8})$/i');
    expect(h006?.updateExpression).toContain('\n  const m =');

    // defaults and explicit values
    const q057 = corrections.rules.find((r) => r.ruleId === 'Q057');
    expect(q057?.enabled).toBe(false);
    const q001 = keys.rules.find((r) => r.ruleId === 'Q001');
    expect(q001?.updateLanguage).toBe('sql'); // blank update_language → default
    expect(q001?.severity).toBe('error');
    const q044 = keys.rules.find((r) => r.ruleId === 'Q044');
    expect(q044?.ruleType).toBe('external');
    expect(q044?.severity).toBe('warning');
  });

  it('normalizes over-quoted cells on the first serialize and writes no formula guards for the fixtures', () => {
    const corrections = parseRuleFile(read(HESP_FILES[2]), baseName(HESP_FILES[2]));
    const s1 = serializeRuleFile(corrections.file);
    // Q047's update_expression is quoted in the fixture without needing quoting →
    // minimal quoting drops the quotes.
    expect(s1).toContain(',CASE __value__ WHEN 777 THEN -777 WHEN 888 THEN -888 ELSE -999 END,');
    // Q048's -666 is minus-digit → exempt from the guard, written bare.
    expect(s1).toContain(',-666,');
    expect(s1.startsWith('\uFEFF')).toBe(true);
    expect(s1.endsWith('\r\n')).toBe(true);
    expect(s1.endsWith('\r\n\r\n')).toBe(false); // exactly one trailing CRLF
  });
});

describe('Excel-mangled variants', () => {
  const keysRel = HESP_FILES[0];

  it('strips a UTF-8 BOM', () => {
    const text = read(keysRel);
    const plain = parseRuleFile(text, baseName(keysRel));
    const bommed = parseRuleFile('\uFEFF' + text, baseName(keysRel));
    expect(bommed.issues).toEqual([]);
    expect(bommed.file).toEqual(plain.file);
  });

  it('accepts CRLF record separators and uppercase TRUE', () => {
    const csv =
      'rule_id,rule_type,rule_scope,target_variables,condition,comment,enabled\r\n' +
      'R1,validate,row,a,a > 1,check a,TRUE\r\n' +
      'R2,validate,row,b,b > 2,check b,False\r\n';
    const { file, issues } = parseRuleFile(csv, 'crlf.quac.csv');
    expect(issues).toEqual([]);
    expect(file.rules.map((r) => r.enabled)).toEqual([true, false]);
    expect(file.rules.map((r) => r.rowNumber)).toEqual([1, 2]);
  });

  it('auto-detects semicolon delimiters (German-locale Excel) without mistaking target pipes', () => {
    const csv =
      'rule_id;rule_type;rule_scope;target_variables;condition;comment\n' +
      "R1;validate;row;a|b;lpad(a, 2, '0') = b;note\n";
    const { file, issues } = parseRuleFile(csv, 'semi.quac.csv');
    expect(issues).toEqual([]);
    expect(file.rules[0]?.targetVariables).toEqual(['a', 'b']);
    expect(file.rules[0]?.condition).toBe("lpad(a, 2, '0') = b");
    expect(file.rules[0]?.comment).toBe('note');
  });

  it('keeps smart quotes in comments verbatim', () => {
    const csv =
      'rule_id,rule_type,rule_scope,target_variables,condition,comment\n' +
      'R1,validate,row,a,a IS NULL,“it’s fine” here\n';
    const { file, issues } = parseRuleFile(csv, 'smart.quac.csv');
    expect(issues).toEqual([]);
    expect(file.rules[0]?.comment).toBe('“it’s fine” here');
  });

  it('trims the formula-guard space on read and re-injects it on write', () => {
    const csv =
      'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled\n' +
      'R1,correct,row,a, =SUM(A1),sql, -__value__,info,c1,true\n' +
      'R2,correct,row,a,@indirect,sql, +x,info,c2,true\n' +
      'R3,correct,row,a,a = 777,sql,-666,info,c3,true\n';
    const { file, issues } = parseRuleFile(csv, 'guard.quac.csv');
    expect(issues).toEqual([]);
    expect(file.rules.map((r) => r.condition)).toEqual(['=SUM(A1)', '@indirect', 'a = 777']);
    expect(file.rules.map((r) => r.updateExpression)).toEqual(['-__value__', '+x', '-666']);

    const out = serializeRuleFile(file);
    expect(out).toContain(', =SUM(A1),'); // '=' always guarded
    expect(out).toContain(', @indirect,'); // '@' always guarded
    expect(out).toContain(', -__value__,'); // minus + non-digit guarded
    expect(out).toContain(', +x,'); // plus + non-digit guarded
    expect(out).toContain(',-666,'); // minus + digit stays bare

    const again = parseRuleFile(out, 'guard.quac.csv');
    expect(again.file).toEqual(file);
  });

  it('preserves unknown extra columns verbatim (padded header names included)', () => {
    const csv =
      'rule_id,rule_type,rule_scope,target_variables,condition,comment, Notes ,owner\n' +
      'R1,validate,row,a,a IS NULL,c, keep me ,jeya\n';
    const p1 = parseRuleFile(csv, 'extras.quac.csv');
    expect(p1.file.extraColumns).toEqual([' Notes ', 'owner']); // verbatim keys
    expect(p1.file.rules[0]?.extras).toEqual({ ' Notes ': 'keep me', owner: 'jeya' }); // trimmed values
    const s1 = serializeRuleFile(p1.file);
    expect(s1).toContain(', Notes ,owner\r\n');
    const p2 = parseRuleFile(s1, 'extras.quac.csv');
    expect(p2.file).toEqual(p1.file);
  });

  it('matches headers by trimmed case-insensitive name regardless of order; serializer restores canonical order', () => {
    const csv =
      'Enabled, COMMENT ,Condition,rule_scope,RULE_TYPE,rule_id,target_variables\n' +
      'false,hi there,a = 1,row,validate,R9,a\n';
    const { file, issues } = parseRuleFile(csv, 'shuffled.quac.csv');
    expect(issues).toEqual([]);
    const rule = file.rules[0];
    expect(rule?.ruleId).toBe('R9');
    expect(rule?.enabled).toBe(false);
    expect(rule?.comment).toBe('hi there');
    expect(rule?.condition).toBe('a = 1');
    expect(file.extraColumns).toEqual([]);
    expect(serializeRuleFile(file).startsWith('\uFEFFrule_id,rule_type,rule_scope,')).toBe(true);
  });

  it('skips fully-empty records while keeping physical row numbers', () => {
    const csv =
      'rule_id,rule_type,rule_scope,target_variables,condition,comment\n' +
      'R1,validate,row,a,a > 1,c1\n' +
      '\n' +
      ',,,,,\n' +
      'R4,validate,row,b,b > 2,c4\n';
    const { file, issues } = parseRuleFile(csv, 'gaps.quac.csv');
    expect(issues).toEqual([]);
    expect(file.rules.map((r) => [r.ruleId, r.rowNumber])).toEqual([
      ['R1', 1],
      ['R4', 4],
    ]);
  });

  it('drops trailing empty columns (Excel comma padding)', () => {
    const csv =
      'rule_id,rule_type,rule_scope,target_variables,condition,comment,,,\n' +
      'R1,validate,row,a,a > 1,c1,,,\n';
    const { file, issues } = parseRuleFile(csv, 'padded.quac.csv');
    expect(issues).toEqual([]);
    expect(file.extraColumns).toEqual([]);
    expect(file.rules[0]?.extras).toEqual({});
  });
});

describe('parse-level issues and group derivation', () => {
  it('reports every missing required header plus empty-file for empty input', () => {
    const { issues } = parseRuleFile('', 'empty.quac.csv');
    const missing = issues.filter((i) => i.code === 'missing-header').map((i) => i.csvColumn);
    expect(missing).toEqual([
      'rule_id',
      'rule_type',
      'rule_scope',
      'target_variables',
      'condition',
      'comment',
    ]);
    expect(issues.filter((i) => i.code === 'empty-file')).toHaveLength(1);
    expect(issues.every((i) => i.file === 'empty.quac.csv' && i.severity === 'error')).toBe(true);
  });

  it('reports empty-file for a header-only file', () => {
    const { issues, presentHeaders } = parseRuleFile(
      'rule_id,rule_type,rule_scope,target_variables,condition,comment\n',
      'headeronly.quac.csv',
    );
    expect(issues.map((i) => i.code)).toEqual(['empty-file']);
    expect(presentHeaders).toHaveLength(6);
  });

  it('reports bad-enum with exact location and keeps the raw value', () => {
    const csv =
      'rule_id,rule_type,rule_scope,target_variables,condition,comment,enabled\n' +
      'R1,fixup,row,a,a > 1,c1,maybe\n';
    const { file, issues } = parseRuleFile(csv, 'enums.quac.csv');
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'bad-enum',
        file: 'enums.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'rule_type',
        message: 'rule_type "fixup" is not one of validate | correct | external.',
      },
      {
        severity: 'error',
        code: 'bad-enum',
        file: 'enums.quac.csv',
        ruleId: 'R1',
        rowNumber: 1,
        csvColumn: 'enabled',
        message: 'enabled "maybe" is not one of true/false/yes/no/1/0 or blank.',
      },
    ]);
    // raw (lowercased) value preserved — never silently reinterpreted; the error
    // issue excludes the rule from execution downstream.
    expect(file.rules[0]?.ruleType).toBe('fixup');
    expect(file.rules[0]?.enabled).toBe(true);
  });

  it('derives the group from the basename minus .quac.csv/.csv (case-insensitive)', () => {
    expect(parseRuleFile('', 'dir/sub/foo.quac.csv').file.group).toBe('foo');
    expect(parseRuleFile('', 'BAR.CSV').file.group).toBe('BAR');
    expect(parseRuleFile('', 'x.QUAC.CSV').file.group).toBe('x');
    expect(parseRuleFile('', 'plain.txt').file.group).toBe('plain.txt');
    expect(parseRuleFile('', 'dir\\win.quac.csv').file.name).toBe('win.quac.csv');
  });
});
