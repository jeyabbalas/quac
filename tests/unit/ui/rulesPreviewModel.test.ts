/**
 * Preview → QC rules model: derived labels, the search corpus and matcher, the
 * (type, scope) → language mapping of qc-rules-format.md §3/§4, and the line
 * splitting the `+N more` cap rests on.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPR_LINE_CAP,
  conditionLang,
  countReadout,
  noMatchMessage,
  parseQuery,
  ruleHaystack,
  ruleIdLabel,
  ruleMatches,
  rulesCount,
  splitLines,
  typeScopeLabel,
  updateLang,
} from '../../../src/ui/views/load/preview/rulesPreviewModel';
import type { TokenRun } from '../../../src/ui/views/load/preview/rulesPreviewModel';
import type { QCRule, RuleScope, RuleType } from '../../../src/core/rules/types';

function rule(over: Partial<QCRule> = {}): QCRule {
  return {
    ruleId: 'Q047',
    ruleType: 'correct',
    ruleScope: 'row',
    targetVariables: ['wage_income_annual', 'monthly_rent'],
    condition: '__value__ IN (777, 888, 999)',
    updateLanguage: 'sql',
    updateExpression: 'CASE __value__ WHEN 777 THEN -777 ELSE -999 END',
    severity: 'info',
    comment: 'Legacy positive sentinel recoded.',
    enabled: true,
    sourceFile: 'hesp_corrections',
    rowNumber: 1,
    extras: {},
    ...over,
  };
}

const run = (text: string, classes = ''): TokenRun => ({ text, classes });
const BREAK = run('\n');

describe('typeScopeLabel', () => {
  it('pairs the two halves of the format matrix on one line', () => {
    expect(typeScopeLabel(rule())).toBe('correct · row');
    expect(typeScopeLabel(rule({ ruleType: 'validate', ruleScope: 'longitudinal' }))).toBe(
      'validate · longitudinal',
    );
  });
});

describe('ruleIdLabel', () => {
  it('names an id-less rule the way the Studio grid does', () => {
    expect(ruleIdLabel(rule({ ruleId: '' }))).toBe('(blank)');
    expect(ruleIdLabel(rule())).toBe('Q047');
  });
});

describe('count copy', () => {
  it('singularises', () => {
    expect(rulesCount(0)).toBe('0 rules');
    expect(rulesCount(1)).toBe('1 rule');
    expect(rulesCount(22)).toBe('22 rules');
  });

  it('reads out the total unfiltered and the fraction while filtering', () => {
    expect(countReadout(22, 22, false)).toBe('22 rules');
    expect(countReadout(3, 22, true)).toBe('3 of 22 rules');
    expect(countReadout(1, 1, true)).toBe('1 of 1 rule');
  });

  it('quotes the trimmed query in the no-match note', () => {
    expect(noMatchMessage('  zzzz ')).toBe("No rules match 'zzzz'.");
  });
});

describe('parseQuery', () => {
  it('is empty for blank input, so everything matches', () => {
    expect(parseQuery('')).toEqual([]);
    expect(parseQuery('   ')).toEqual([]);
  });

  it('trims, lowercases and splits on any run of whitespace', () => {
    expect(parseQuery('  LAG   Wave\t')).toEqual(['lag', 'wave']);
  });
});

describe('ruleHaystack + ruleMatches', () => {
  it('covers id, targets, condition, update expression, comment and enums', () => {
    const haystack = ruleHaystack(rule());
    for (const token of [
      'q047',
      'wage_income_annual',
      '__value__',
      'case',
      'sentinel',
      'correct',
      'row',
      'info',
    ]) {
      expect(ruleMatches(haystack, [token]), token).toBe(true);
    }
  });

  it('is token-AND, not substring — the tokens may match different fields', () => {
    const haystack = ruleHaystack(rule());
    expect(ruleMatches(haystack, ['q047', 'rent'])).toBe(true);
    expect(ruleMatches(haystack, ['q047', 'nothinghere'])).toBe(false);
    // Both tokens present but never adjacent: a plain substring test fails here.
    expect(ruleMatches(haystack, ['sentinel', '777'])).toBe(true);
  });

  it('folds case on both sides', () => {
    expect(ruleMatches(ruleHaystack(rule()), parseQuery('Q047 CASE'))).toBe(true);
  });

  it('matches everything when the query is empty', () => {
    expect(ruleMatches(ruleHaystack(rule()), parseQuery(''))).toBe(true);
  });
});

describe('conditionLang / updateLang', () => {
  const TYPES: RuleType[] = ['validate', 'correct', 'external'];
  const SCOPES: RuleScope[] = ['row', 'column', 'dataset', 'longitudinal'];

  it('reads every executable condition as SQL, whatever the scope', () => {
    for (const ruleType of ['validate', 'correct'] as const) {
      for (const ruleScope of SCOPES) {
        expect(conditionLang(rule({ ruleType, ruleScope })), `${ruleType}/${ruleScope}`).toBe(
          'sql',
        );
      }
    }
  });

  it('leaves external free text alone — it is prose, and never executed', () => {
    for (const ruleScope of SCOPES) {
      expect(conditionLang(rule({ ruleType: 'external', ruleScope }))).toBe('text');
      expect(updateLang(rule({ ruleType: 'external', ruleScope, updateLanguage: 'js' }))).toBe(
        'text',
      );
    }
  });

  it('follows the declared update_language for everything else', () => {
    for (const ruleType of TYPES) {
      for (const updateLanguage of ['sql', 'js'] as const) {
        expect(updateLang(rule({ ruleType, updateLanguage }))).toBe(
          ruleType === 'external' ? 'text' : updateLanguage,
        );
      }
    }
  });
});

describe('splitLines', () => {
  it('returns one line when there is no break', () => {
    expect(splitLines([run('a '), run('>=', 'tok-operator'), run(' 0')])).toEqual([
      [run('a '), run('>=', 'tok-operator'), run(' 0')],
    ]);
  });

  it('partitions at the break runs and keeps every other run intact', () => {
    const lines = splitLines([
      run('a'),
      BREAK,
      run('AND', 'tok-keyword'),
      run(' b'),
      BREAK,
      run('c'),
    ]);
    expect(lines).toEqual([[run('a')], [run('AND', 'tok-keyword'), run(' b')], [run('c')]]);
  });

  it('always yields at least one line, so an empty expression is one empty line', () => {
    expect(splitLines([])).toEqual([[]]);
  });

  it('keeps trailing and leading breaks as empty lines rather than dropping them', () => {
    expect(splitLines([BREAK, run('a'), BREAK])).toEqual([[], [run('a')], []]);
  });

  it('does not mistake a styled newline-looking run for a break', () => {
    // Defensive: only the classless '\n' exprTokens.ts emits from putBreak
    // splits a line. A string literal is a single run and stays one.
    expect(splitLines([run("'\n'", 'tok-string')])).toEqual([[run("'\n'", 'tok-string')]]);
  });

  it('caps at six lines, which is where HESP Q021 spills into +5 more', () => {
    expect(EXPR_LINE_CAP).toBe(6);
    const eleven = Array.from({ length: 11 }, (_, i) => [run(`line ${String(i)}`)]).flatMap(
      (line, i) => (i === 0 ? line : [BREAK, ...line]),
    );
    const lines = splitLines(eleven);
    expect(lines).toHaveLength(11);
    expect(lines.length - EXPR_LINE_CAP).toBe(5);
  });
});
