/**
 * The agreement test for the lifted `quoteIdentifier` (P22 packaging).
 *
 * QuaC now quotes SQL identifiers with its own copy of the function rather
 * than `@jeyabbalas/data-table`'s export, so that `dependencies` can shrink to
 * the eight packages the headless binary actually imports. But the browser app
 * still hands the SAME table and column names to data-table's grids, which
 * quote them with their own copy — so the two have to agree character for
 * character. Where they diverge, a column the grid can address becomes one
 * QuaC's SQL cannot (or worse: quotes differently and addresses something
 * else). This is the check, and it is the reason data-table stays a
 * devDependency rather than leaving the tree entirely.
 *
 * The corpus is the real HESP header — 265 production column names, read off
 * the fixture rather than retyped — plus the hostile inputs a synthetic corpus
 * is for: embedded quotes, the two rejection cases, and the Unicode the
 * upstream contract explicitly promises to pass through.
 *
 * Fast unit tier, deliberately: data-table's package root imports cleanly
 * under plain Node ESM (V29), so this needs no browser and costs nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quoteIdentifier as upstream } from '@jeyabbalas/data-table';
import { describe, expect, it } from 'vitest';
import { SqlIdentifierError, quoteIdentifier } from '../../../src/core/sql-identifier';

/** Every column name the HESP fixtures actually carry. */
const HESP_COLUMNS: readonly string[] = (
  readFileSync(
    fileURLToPath(new URL('../../fixtures/hesp/data/hesp_valid_100.csv', import.meta.url)),
    'utf8',
  ).split('\n')[0] ?? ''
)
  .trim()
  .split(',');

/**
 * Names no dataset should contain but some will: the delimiter set QuaC's own
 * hygiene pass tolerates, the identifiers DuckDB reserves, and the ones whose
 * whole point is to escape the quoting.
 */
const HOSTILE: readonly string[] = [
  'we"ird',
  '"',
  '""',
  'a""b',
  '"; DROP TABLE quac_raw; --',
  "o'brien",
  'has space',
  'has\ttab',
  'has\nnewline',
  'has\rcarriage',
  'trailing ',
  ' leading',
  'select',
  'SELECT',
  'from',
  'table',
  '__row__',
  '__rowid__',
  'quac_raw',
  '1',
  '1abc',
  '-',
  '.',
  '*',
  '%',
  'a.b',
  'a\\b',
  'a`b',
  'a[b]',
  '\x01control',
  '\x7f',
  'x'.repeat(1024),
];

/** The contract's explicit pass-throughs: non-ASCII and surrogate pairs. */
const UNICODE: readonly string[] = [
  'café',
  'naïve',
  'Straße',
  'año',
  '年齢',
  'возраст',
  'العمر',
  'ålder',
  '🦆',
  '👨‍👩‍👧‍👦',
  '𝕢𝕦𝕒𝕔',
  'é', // combining acute — not the precomposed é above
  'a​b', // zero-width space
];

const CORPUS: readonly string[] = [...HESP_COLUMNS, ...HOSTILE, ...UNICODE];

describe('quoteIdentifier agrees with @jeyabbalas/data-table', () => {
  it('reads the real HESP vocabulary, not a stand-in', () => {
    // The fixture is 265 columns wide; if it ever narrows, this test quietly
    // stops covering production names, so the width is asserted.
    expect(HESP_COLUMNS).toHaveLength(265);
    expect(HESP_COLUMNS[0]).toBe('record_id');
    expect(HESP_COLUMNS).toContain('reference_age');
  });

  it.each(CORPUS.map((name) => [JSON.stringify(name), name] as const))(
    'quotes %s identically',
    (_label, name) => {
      expect(quoteIdentifier(name)).toBe(upstream(name));
    },
  );

  it('agrees on the whole corpus at once, so no case is silently skipped', () => {
    expect(CORPUS.map(quoteIdentifier)).toEqual(CORPUS.map((n) => upstream(n)));
    expect(CORPUS.length).toBeGreaterThan(300);
  });

  it('round-trips: unquoting the result recovers the name', () => {
    for (const name of CORPUS) {
      const quoted = quoteIdentifier(name);
      expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true);
      expect(quoted.slice(1, -1).replaceAll('""', '"')).toBe(name);
    }
  });
});

describe('the two rejections', () => {
  it.each([
    ['the empty string', ''],
    ['an embedded NUL', 'a\0b'],
    ['a leading NUL', '\0'],
    ['a trailing NUL', 'record_id\0'],
  ])('rejects %s exactly where upstream does', (_label, name) => {
    expect(() => quoteIdentifier(name)).toThrow();
    expect(() => upstream(name)).toThrow();
  });

  it("carries upstream's INVALID_IDENTIFIER code", () => {
    // Nothing in QuaC catches either class — the code is what the shape
    // promises, and what a future catcher would branch on.
    for (const name of ['', 'a\0b']) {
      let thrown: unknown;
      try {
        quoteIdentifier(name);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SqlIdentifierError);
      expect((thrown as SqlIdentifierError).code).toBe('INVALID_IDENTIFIER');
      expect((thrown as SqlIdentifierError).name).toBe('SqlIdentifierError');
      // Upstream agrees on the code even though the class differs.
      expect((upstreamThrow(name) as { code?: unknown }).code).toBe('INVALID_IDENTIFIER');
    }
  });
});

function upstreamThrow(name: string): unknown {
  try {
    upstream(name);
  } catch (err) {
    return err;
  }
  throw new Error(`upstream accepted ${JSON.stringify(name)}`);
}
