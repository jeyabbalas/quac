import { describe, expect, it } from 'vitest';
import { rowFocusSQL } from '../../../src/core/report/rowFocus';

const COL = '__rowid__';

describe('rowFocusSQL', () => {
  it('is empty for no rows — the caller reads that as "nothing to focus"', () => {
    expect(rowFocusSQL(COL, [])).toBe('');
  });

  it('lists a short scatter', () => {
    expect(rowFocusSQL(COL, [4, 1, 9])).toBe('"__rowid__" IN (1, 4, 9)');
  });

  it('keeps a two-long run in the IN list — a BETWEEN would not be shorter', () => {
    expect(rowFocusSQL(COL, [1, 2])).toBe('"__rowid__" IN (1, 2)');
  });

  it('collapses a run of three or more', () => {
    expect(rowFocusSQL(COL, [3, 4, 5])).toBe('"__rowid__" BETWEEN 3 AND 5');
  });

  it('mixes runs and singletons, ranges first', () => {
    expect(rowFocusSQL(COL, [0, 2, 3, 4, 9, 20, 21, 22])).toBe(
      '"__rowid__" BETWEEN 2 AND 4 OR "__rowid__" BETWEEN 20 AND 22 OR "__rowid__" IN (0, 9)',
    );
  });

  it('sorts and dedupes whatever order the rows arrive in', () => {
    expect(rowFocusSQL(COL, [5, 3, 4, 3, 5])).toBe('"__rowid__" BETWEEN 3 AND 5');
  });

  it('collapses a dense set to one term — the reason ranges exist at all', () => {
    // A rule firing on every row of a 10k dataset (the engine rowCapPerRule)
    // must not become a 60 KB literal list.
    const dense = [...Array(10_000).keys()];
    expect(rowFocusSQL(COL, dense)).toBe('"__rowid__" BETWEEN 0 AND 9999');
  });

  it('quotes the column name', () => {
    expect(rowFocusSQL('od"d', [1])).toBe('"od""d" IN (1)');
  });
});
