// P18 task 3 round-trip guarantee: import → edit ONE rule (through the
// store's serialize→parse discipline) → export leaves every OTHER row
// byte-comparable after parse — extras + row order preserved, the edited rule
// replaced in place, new rules appended — plus writer invariants (BOM, CRLF,
// formula guard) and `exportFileName` derivation. Properties only: the golden
// byte pins live in parse.test.ts and are not duplicated here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRuleFile } from '../../../src/core/rules/parse';
import { exportFileName, serializeRuleFile } from '../../../src/core/rules/serialize';
import type { QCRule, RuleFile } from '../../../src/core/rules/types';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');
const CORRECTIONS = 'hesp_corrections.quac.csv';
const readCorrections = (): string =>
  readFileSync(resolve(FIXTURES, 'hesp', 'rules', CORRECTIONS), 'utf8');

/** Split serialized CSV into records on top-level CRLF (quoted cells keep
 *  their interior newlines) — the byte-comparison unit for the guarantee. */
function splitRecords(csv: string): string[] {
  const body = csv.startsWith('\uFEFF') ? csv.slice(1) : csv;
  const records: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && ch === '\r' && body.charAt(i + 1) === '\n') {
      records.push(current);
      current = '';
      i += 1;
    } else {
      current += ch;
    }
  }
  if (current !== '') records.push(current);
  return records;
}

/** The rules-store mutation discipline: mutate → serialize → parse, so the
 *  export path sees exactly what the store would hold after an edit. */
function storeRoundTrip(file: RuleFile, rules: QCRule[]): RuleFile {
  return parseRuleFile(serializeRuleFile({ ...file, rules }), file.name).file;
}

describe('export round-trip guarantee (fixture file)', () => {
  it('editing one rule leaves all other records byte-identical, replaced in place', () => {
    const original = parseRuleFile(readCorrections(), CORRECTIONS).file;
    const before = splitRecords(serializeRuleFile(original));

    const editedIndex = original.rules.findIndex((r) => r.ruleId === 'Q052');
    expect(editedIndex).toBeGreaterThanOrEqual(0);
    const rules = [...original.rules];
    const target = rules[editedIndex];
    if (target === undefined) throw new Error('unreachable');
    rules[editedIndex] = { ...target, comment: 'Edited in the Studio.' };

    const exported = serializeRuleFile(storeRoundTrip(original, rules));
    const after = splitRecords(exported);

    expect(after).toHaveLength(before.length);
    expect(after[0]).toBe(before[0]); // header untouched
    for (let i = 1; i < before.length; i++) {
      if (i === editedIndex + 1) continue;
      expect(after[i]).toBe(before[i]); // unedited rows byte-comparable
    }
    expect(after[editedIndex + 1]).not.toBe(before[editedIndex + 1]);
    expect(after[editedIndex + 1]).toContain('Edited in the Studio.');

    // The export parses back to the store's exact model (fixpoint on export).
    const reparsed = parseRuleFile(exported, CORRECTIONS);
    expect(reparsed.issues).toEqual([]);
    expect(reparsed.file).toEqual(storeRoundTrip(original, rules));
  });

  it('appending a rule keeps every existing record byte-identical, new row last', () => {
    const original = parseRuleFile(readCorrections(), CORRECTIONS).file;
    const before = splitRecords(serializeRuleFile(original));
    const appended: QCRule = {
      ruleId: 'P18X',
      ruleType: 'validate',
      ruleScope: 'row',
      targetVariables: ['monthly_rent'],
      condition: 'monthly_rent IS NULL',
      updateLanguage: 'sql',
      updateExpression: '',
      severity: 'error',
      comment: 'Appended by the Studio.',
      enabled: true,
      sourceFile: '',
      rowNumber: 0,
      extras: {},
    };

    const exported = serializeRuleFile(storeRoundTrip(original, [...original.rules, appended]));
    const after = splitRecords(exported);

    expect(after).toHaveLength(before.length + 1);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBe(before[i]);
    }
    expect(after.at(-1)).toContain('P18X');
    const reparsed = parseRuleFile(exported, CORRECTIONS).file;
    expect(reparsed.rules.at(-1)?.ruleId).toBe('P18X');
  });
});

describe('export round-trip guarantee (extras + reordered headers)', () => {
  // Non-canonical header order with extra columns interleaved — parse binds
  // canonical columns by name and preserves extras in order of appearance.
  const SYNTH =
    'owner,rule_type,rule_id,rule_scope,condition,target_variables,comment,notes\n' +
    'alice,validate,R1,row,a > 1,a,check a,keep me\n' +
    'bob,validate,R2,row,b < 0,b,check b,and me\n';

  it('preserves extras and row order; edited rule replaced, new rule appended', () => {
    const original = parseRuleFile(SYNTH, 'synth.quac.csv');
    expect(original.file.extraColumns).toEqual(['owner', 'notes']);
    const before = splitRecords(serializeRuleFile(original.file));

    const rules = [...original.file.rules];
    const r1 = rules[0];
    if (r1 === undefined) throw new Error('unreachable');
    rules[0] = { ...r1, condition: 'a > 100' };
    rules.push({ ...r1, ruleId: 'R3', condition: 'a IS NULL', extras: {} });

    const exported = serializeRuleFile(storeRoundTrip(original.file, rules));
    const after = splitRecords(exported);

    // Export header: canonical order + extras appended, regardless of the
    // scrambled input order.
    expect(after[0]).toBe(
      'rule_id,rule_type,rule_scope,target_variables,condition,' +
        'update_language,update_expression,severity,comment,enabled,owner,notes',
    );
    expect(after[2]).toBe(before[2]); // untouched R2 record byte-comparable

    const reparsed = parseRuleFile(exported, 'synth.quac.csv').file;
    expect(reparsed.extraColumns).toEqual(['owner', 'notes']);
    expect(reparsed.rules.map((r) => r.ruleId)).toEqual(['R1', 'R2', 'R3']); // in place + appended
    expect(reparsed.rules[0]?.condition).toBe('a > 100');
    expect(reparsed.rules[0]?.extras).toEqual({ owner: 'alice', notes: 'keep me' });
    expect(reparsed.rules[1]?.extras).toEqual({ owner: 'bob', notes: 'and me' });
    expect(reparsed.rules[2]?.extras).toEqual({ owner: '', notes: '' });
  });
});

describe('writer invariants in the exported bytes', () => {
  it('BOM, CRLF separators, exactly one trailing CRLF, formula guard', () => {
    const csv =
      'rule_id,rule_type,rule_scope,target_variables,condition,comment\n' +
      'G1,validate,row,a,a > 1,=SUM(A1) style comment\n';
    const parsed = parseRuleFile(csv, 'guard.quac.csv');
    const exported = serializeRuleFile(parsed.file);

    expect(exported.startsWith('\uFEFF')).toBe(true);
    expect(exported).toContain('\r\n');
    expect(exported.endsWith('\r\n')).toBe(true);
    expect(exported.endsWith('\r\n\r\n')).toBe(false);
    // '=SUM…' would execute in Excel — the §7 guard prefixes a space, which
    // the parser's cell trim strips on re-import (lossless).
    expect(exported).toContain(', =SUM(A1) style comment');
    const reparsed = parseRuleFile(exported, 'guard.quac.csv').file;
    expect(reparsed.rules[0]?.comment).toBe('=SUM(A1) style comment');
  });
});

describe('exportFileName', () => {
  it('derives <group>.quac.csv', () => {
    expect(exportFileName('my_rules.quac.csv')).toBe('my_rules.quac.csv');
    expect(exportFileName('x.csv')).toBe('x.quac.csv');
    expect(exportFileName('bare_name')).toBe('bare_name.quac.csv');
    // Extension matching is case-insensitive; the group keeps its own casing.
    expect(exportFileName('Rules.QUAC.CSV')).toBe('Rules.quac.csv');
    expect(exportFileName('Upper.CSV')).toBe('Upper.quac.csv');
  });
});
