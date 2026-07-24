// P17 completion feed composition (phase-17 verification: "completion feed
// composition (columns + functions + tokens + assertion snippets by
// scope/type); validity-matrix enforcement logic"). Node-tier on purpose —
// snippetCompletion is DOM-free — plus the (type,scope) matrix truth table
// against the lint helpers the rule form consumes.
import { describe, expect, it } from 'vitest';
import {
  ASSERTION_SNIPPETS,
  buildCompletions,
  columnOptions,
  type CompletionFeedContext,
} from '../../../src/ui/views/studio/completionSource';
import { isValidTypeScope, typeScopeComboError } from '../../../src/core/rules/lint';
import type { RuleScope, RuleType } from '../../../src/core/rules/types';

const ALL_ASSERTIONS = [
  'unique',
  'no_nulls',
  'not_blank',
  'in_range',
  'in_enum',
  'match_regex',
  'monotonic',
  'count_distinct_in_range',
];

const feed = (overrides: Partial<CompletionFeedContext>): CompletionFeedContext => ({
  columns: [],
  functions: [],
  ruleType: 'validate',
  ruleScope: 'row',
  field: 'condition',
  ...overrides,
});

const labels = (ctx: CompletionFeedContext): string[] => buildCompletions(ctx).map((c) => c.label);

describe('columnOptions', () => {
  it('maps names + DESCRIBE types into lang-sql schema completions', () => {
    expect(
      columnOptions([{ name: 'record_id', type: 'VARCHAR' }, { name: 'wave' }]),
    ).toEqual([
      { label: 'record_id', type: 'property', detail: 'VARCHAR' },
      { label: 'wave', type: 'property' },
    ]);
  });
});

describe('buildCompletions', () => {
  it('external rules complete nothing', () => {
    expect(
      buildCompletions(feed({ ruleType: 'external', functions: ['abs'], ruleScope: 'column' })),
    ).toEqual([]);
  });

  it('functions pass through; non-identifier catalog entries are dropped', () => {
    const out = labels(feed({ functions: ['regexp_full_match', '!__postfix', '+', 'abs'] }));
    expect(out).toContain('regexp_full_match');
    expect(out).toContain('abs');
    expect(out).not.toContain('!__postfix');
    expect(out).not.toContain('+');
  });

  it('__row__ is always offered; __value__ only on correct rules (both fields)', () => {
    expect(labels(feed({}))).toContain('__row__');
    expect(labels(feed({}))).not.toContain('__value__');

    const correctCondition = labels(feed({ ruleType: 'correct' }));
    expect(correctCondition).toContain('__row__');
    expect(correctCondition).toContain('__value__');
    expect(labels(feed({ ruleType: 'correct', field: 'update_expression' }))).toContain(
      '__value__',
    );
  });

  it('assertion snippets appear ONLY for validate×column×condition, all 8, boosted', () => {
    const out = buildCompletions(feed({ ruleScope: 'column' }));
    const snippets = out.filter((c) => c.detail === 'assertion');
    expect(snippets.map((c) => c.label).sort()).toEqual([...ALL_ASSERTIONS].sort());
    for (const s of snippets) {
      expect(s.boost).toBe(2);
      expect(typeof s.apply).toBe('function'); // snippetCompletion wiring
    }

    const noSnippets = (ctx: CompletionFeedContext): void => {
      expect(buildCompletions(ctx).filter((c) => c.detail === 'assertion')).toEqual([]);
    };
    noSnippets(feed({})); // row scope
    noSnippets(feed({ ruleScope: 'dataset' }));
    noSnippets(feed({ ruleScope: 'column', field: 'update_expression' }));
    noSnippets(feed({ ruleType: 'correct', ruleScope: 'column' }));
  });

  it('ASSERTION_SNIPPETS covers the full vocabulary', () => {
    expect(Object.keys(ASSERTION_SNIPPETS).sort()).toEqual([...ALL_ASSERTIONS].sort());
  });
});

describe('(type,scope) validity matrix', () => {
  const TYPES: RuleType[] = ['validate', 'correct', 'external'];
  const SCOPES: RuleScope[] = ['row', 'column', 'dataset', 'longitudinal'];

  it('truth table: exactly correct×column and correct×dataset are invalid', () => {
    for (const type of TYPES) {
      for (const scope of SCOPES) {
        const invalid = type === 'correct' && (scope === 'column' || scope === 'dataset');
        expect(isValidTypeScope(type, scope), `${type}×${scope}`).toBe(!invalid);
        expect(typeScopeComboError(type, scope) === null, `${type}×${scope}`).toBe(!invalid);
      }
    }
  });

  it('invalid combos carry the pinned lint messages (form tooltips = lint text)', () => {
    expect(typeScopeComboError('correct', 'column')).toBe(
      'correct rules cannot use rule_scope=column — use rule_scope=row with __value__.',
    );
    expect(typeScopeComboError('correct', 'dataset')).toBe(
      'correct rules cannot use rule_scope=dataset.',
    );
  });
});
