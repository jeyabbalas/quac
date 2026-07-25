/**
 * Dictionary search primitives (UIX-4 §5.4): token-AND substring matching,
 * the two-halves cap, and the x-* → display-label mapping that keeps the
 * dictionary using `buildTooltip`'s words.
 */
import { describe, expect, it } from 'vitest';
import {
  capped,
  extraLabel,
  parseQuery,
  rowMatches,
} from '../../../src/core/schema/data-dictionary';
import type { DictionaryRow } from '../../../src/core/schema/data-dictionary';

/** A row is only ever matched through its prebuilt (lowercased) haystack. */
const rowWith = (haystack: string): DictionaryRow => ({
  name: 'x',
  description: '',
  type: '',
  format: '',
  values: [],
  sentinelStart: 0,
  constraints: [],
  extras: [],
  haystack: haystack.toLowerCase(),
});

describe('parseQuery', () => {
  it('trims, lowercases and splits on whitespace', () => {
    expect(parseQuery('  Annual   INCOME ')).toEqual(['annual', 'income']);
  });

  it('treats blank input as no tokens', () => {
    expect(parseQuery('')).toEqual([]);
    expect(parseQuery('   ')).toEqual([]);
  });
});

describe('rowMatches', () => {
  const row = rowWith(
    'partner_earnings_annual Annual earnings of the partner integer -666 Refused ' +
      'required Unit currency units per year HESP CORE - Household income',
  );

  it('matches everything when there are no tokens', () => {
    expect(rowMatches(row, [])).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(rowMatches(row, parseQuery('ANNUAL'))).toBe(true);
  });

  it('requires EVERY token, in any order and any field', () => {
    // The reason plain substring is wrong: these two words never sit adjacent.
    expect(rowMatches(row, parseQuery('income annual'))).toBe(true);
    expect(rowMatches(row, parseQuery('annual missing'))).toBe(false);
  });

  it('matches value codes and labels, constraint text, extras, and the category', () => {
    expect(rowMatches(row, parseQuery('-666'))).toBe(true);
    expect(rowMatches(row, parseQuery('refused'))).toBe(true);
    expect(rowMatches(row, parseQuery('required'))).toBe(true);
    expect(rowMatches(row, parseQuery('currency units'))).toBe(true);
    expect(rowMatches(row, parseQuery('household income'))).toBe(true);
  });

  it('matches substrings, not whole words', () => {
    expect(rowMatches(row, parseQuery('earn'))).toBe(true);
  });
});

describe('capped', () => {
  const items = [1, 2, 3, 4, 5];

  it('returns everything and an empty tail at or below the cap', () => {
    expect(capped(items, 5)).toEqual({ shown: items, hidden: [] });
    expect(capped(items, 9)).toEqual({ shown: items, hidden: [] });
    expect(capped([], 3)).toEqual({ shown: [], hidden: [] });
  });

  it('splits at the cap and keeps the tail — nothing is dropped', () => {
    const { shown, hidden } = capped(items, 2);
    expect(shown).toEqual([1, 2]);
    expect(hidden).toEqual([3, 4, 5]);
    expect([...shown, ...hidden]).toEqual(items);
  });
});

describe('extraLabel', () => {
  it('uses buildTooltip’s words for the facts the two share', () => {
    expect(extraLabel('x-unit')).toBe('Unit');
    expect(extraLabel('x-universe')).toBe('Universe');
    expect(extraLabel('x-role')).toBe('Role');
  });

  it('strips a leading x-, spaces separators and capitalises', () => {
    expect(extraLabel('x-derivation')).toBe('Derivation');
    expect(extraLabel('default')).toBe('Default');
    expect(extraLabel('x-collection_mode')).toBe('Collection mode');
    expect(extraLabel('x-follow-up-window')).toBe('Follow up window');
  });

  it('leaves an empty key empty rather than throwing', () => {
    expect(extraLabel('')).toBe('');
  });
});
