/**
 * §E.5 shared pertinence check: thresholds, case-mismatch near-misses,
 * zero-property skip, required-fallback denominator.
 */
import { describe, expect, it } from 'vitest';
import { computePertinence } from '../../../src/core/pertinence';
import type { PertinenceColumn } from '../../../src/core/pertinence';

const required = (...names: string[]): PertinenceColumn[] =>
  names.map((name) => ({ name, required: true }));

describe('computePertinence thresholds', () => {
  const schemaColumns = required('a', 'b', 'c', 'd', 'e');

  it('score 0 → block', () => {
    const result = computePertinence({ schemaColumns, datasetColumns: ['x', 'y'] });
    expect(result?.score).toBe(0);
    expect(result?.verdict).toBe('block');
    expect(result?.matched).toEqual([]);
    expect(result?.missingRequired).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result?.extra).toEqual(['x', 'y']);
  });

  it('score 0.4 → block', () => {
    const result = computePertinence({ schemaColumns, datasetColumns: ['a', 'b'] });
    expect(result?.score).toBe(0.4);
    expect(result?.verdict).toBe('block');
  });

  it('score 0.6 → warn', () => {
    const result = computePertinence({ schemaColumns, datasetColumns: ['a', 'b', 'c'] });
    expect(result?.score).toBe(0.6);
    expect(result?.verdict).toBe('warn');
    expect(result?.missingRequired).toEqual(['d', 'e']);
  });

  it('score 1.0 → ok (extras allowed)', () => {
    const result = computePertinence({
      schemaColumns,
      datasetColumns: ['a', 'b', 'c', 'd', 'e', 'extra_1'],
    });
    expect(result?.score).toBe(1);
    expect(result?.verdict).toBe('ok');
    expect(result?.extra).toEqual(['extra_1']);
  });
});

describe('computePertinence details', () => {
  it('detects AGE vs age as a case mismatch, not a match', () => {
    const result = computePertinence({
      schemaColumns: required('age', 'name'),
      datasetColumns: ['AGE', 'name'],
    });
    expect(result?.matched).toEqual(['name']);
    expect(result?.missingRequired).toEqual(['age']);
    expect(result?.caseMismatches).toEqual([{ dataset: 'AGE', schema: 'age' }]);
    expect(result?.score).toBe(0.5);
    expect(result?.verdict).toBe('warn');
  });

  it('folds NFC + trim for near-miss detection only', () => {
    const result = computePertinence({
      schemaColumns: required('née'),
      datasetColumns: ['née '],
    });
    expect(result?.caseMismatches).toEqual([{ dataset: 'née ', schema: 'née' }]);
  });

  it('skips zero-property schemas (null)', () => {
    expect(computePertinence({ schemaColumns: [], datasetColumns: ['a'] })).toBeNull();
  });

  it('falls back to all declared columns when none are required', () => {
    const result = computePertinence({
      schemaColumns: [
        { name: 'a', required: false },
        { name: 'b', required: false },
      ],
      datasetColumns: ['a'],
    });
    expect(result?.score).toBe(0.5);
    expect(result?.missingOptional).toEqual(['b']);
    expect(result?.verdict).toBe('warn');
  });

  it('mixed required/optional: score counts required only', () => {
    const result = computePertinence({
      schemaColumns: [...required('a', 'b'), { name: 'c', required: false }],
      datasetColumns: ['a', 'b'],
    });
    expect(result?.score).toBe(1);
    expect(result?.verdict).toBe('ok');
    expect(result?.missingOptional).toEqual(['c']);
  });
});
