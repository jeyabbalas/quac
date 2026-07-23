// T-ASSERT-EXPANSION — all 8 §4.1 expansions byte-pinned, then executed against
// the seeded qc_fixture table on @duckdb/node-api through the engine's own
// violation-fetch wrapper, asserting exact violating __row__ sets (including
// count_distinct_in_range's inclusive bounds). Monotonic execution cases use
// partition_by=household_id with the DEFAULT order_by (__row__): LAG over tied
// ORDER BY keys has no guaranteed predecessor, so the order_by=wave form is
// pinned as a snapshot only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expandAssertion,
  parseAssertion,
  type ParsedAssertion,
} from '../../../src/core/rules/assertions';
import { violCountSQL, violFetchSQL } from '../../../src/core/rules/sql';
import { openQcFixture, type QcFixtureDb } from './support';

const parsed = (text: string): ParsedAssertion => {
  const result = parseAssertion(text);
  if (!result.ok) throw new Error(`expected "${text}" to parse: ${result.error}`);
  return result.assertion;
};

const rowSql = (text: string, target: string): string => {
  const exp = expandAssertion(parsed(text), target);
  if (exp.kind !== 'row-condition') throw new Error(`expected row-condition for ${text}`);
  return exp.sql;
};

describe('§4.1 expansions (byte-pinned)', () => {
  it('unique / no_nulls / not_blank', () => {
    expect(rowSql('unique', 'wave')).toBe(
      '("wave" IS NOT NULL AND COUNT(*) OVER (PARTITION BY "wave") > 1)',
    );
    expect(rowSql('no_nulls', 'wave')).toBe('("wave" IS NULL)');
    expect(rowSql('not_blank', 'wave')).toBe(
      '("wave" IS NULL OR TRIM(CAST("wave" AS VARCHAR)) = \'\')',
    );
  });

  it('in_range / in_enum / match_regex emit literals token-verbatim', () => {
    expect(rowSql('in_range(0, 120)', 'wave')).toBe(
      '("wave" IS NOT NULL AND ("wave" < 0 OR "wave" > 120))',
    );
    expect(rowSql("in_enum(1, 2, 'x''y')", 'wave')).toBe(
      '("wave" IS NOT NULL AND "wave" NOT IN (1, 2, \'x\'\'y\'))',
    );
    expect(rowSql("match_regex('^HH[0-9]{8}$')", 'household_id')).toBe(
      '("household_id" IS NOT NULL AND NOT regexp_full_match(CAST("household_id" AS VARCHAR), \'^HH[0-9]{8}$\'))',
    );
  });

  it('monotonic — the phase-mandated order_by/partition_by snapshot', () => {
    expect(
      rowSql('monotonic(increasing, order_by=wave, partition_by=household_id)', 'reference_age'),
    ).toBe(
      '("reference_age" IS NOT NULL AND ' +
        'LAG("reference_age") OVER (PARTITION BY "household_id" ORDER BY "wave") IS NOT NULL AND ' +
        '"reference_age" < LAG("reference_age") OVER (PARTITION BY "household_id" ORDER BY "wave"))',
    );
  });

  it('monotonic — four directions; PARTITION BY omitted when absent; __row__ default order', () => {
    expect(rowSql('monotonic(increasing)', 'v')).toBe(
      '("v" IS NOT NULL AND LAG("v") OVER (ORDER BY "__row__") IS NOT NULL AND "v" < LAG("v") OVER (ORDER BY "__row__"))',
    );
    expect(rowSql('monotonic(strict_increasing)', 'v')).toContain('"v" <= LAG');
    expect(rowSql('monotonic(decreasing)', 'v')).toContain('"v" > LAG');
    expect(rowSql('monotonic(strict_decreasing)', 'v')).toContain('"v" >= LAG');
  });

  it('count_distinct_in_range — whole-column aggregate with host-side bounds', () => {
    const exp = expandAssertion(parsed('count_distinct_in_range(1, 20)'), 'wave');
    expect(exp).toEqual({
      kind: 'column-aggregate',
      countSql: 'SELECT COUNT(DISTINCT "wave") FROM data',
      lo: 1,
      hi: 20,
    });
  });
});

describe('grammar', () => {
  const errorOf = (text: string): string => {
    const result = parseAssertion(text);
    if (result.ok) throw new Error(`expected "${text}" to fail`);
    return result.error;
  };

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(parseAssertion('NO_NULLS').ok).toBe(true);
    expect(parseAssertion('unique()').ok).toBe(true);
    expect(parseAssertion('  Monotonic ( INCREASING , order_by = wave )  ').ok).toBe(true);
    expect(parseAssertion("in_range('2020-01-01', '2030-12-31')").ok).toBe(true); // date bounds
  });

  it('rejects unknown names, bad arity, bad types, and malformed args', () => {
    expect(errorOf('is_unique')).toContain('unknown assertion');
    expect(errorOf('SELECT 1')).toContain('not an assertion');
    expect(errorOf('unique(1)')).toContain('takes no arguments');
    expect(errorOf('in_range(1)')).toContain('exactly 2');
    expect(errorOf('in_range(lo, hi)')).toContain('literals');
    expect(errorOf("count_distinct_in_range(1, 'x')")).toContain('numbers');
    expect(errorOf('in_enum()')).toContain('at least 1');
    expect(errorOf('match_regex(5)')).toContain('quoted-string');
    expect(errorOf('monotonic(sideways)')).toContain('direction must be one of');
    expect(errorOf('monotonic(increasing, order_by=5)')).toContain('must name a column');
    expect(errorOf('monotonic(increasing, limit=3)')).toContain('does not take');
    expect(errorOf('monotonic(order_by=wave, increasing)')).toContain('positional argument after');
    expect(errorOf("in_enum('unterminated)")).toContain('unterminated string');
    expect(errorOf('in_enum(1,,2)')).toContain('empty argument');
    expect(errorOf('unique extra')).toContain('not an assertion');
  });
});

describe('execution against qc_fixture (exact violating __row__ sets)', () => {
  let db: QcFixtureDb;
  beforeAll(async () => {
    db = await openQcFixture();
  });
  afterAll(() => {
    db.close();
  });

  const violRows = async (text: string, target: string): Promise<number[]> => {
    const rows = await db.runner.query<{ __row__: number }>(
      violFetchSQL(rowSql(text, target), [target], 10_000),
    );
    return rows.map((r) => r.__row__);
  };

  it('unique — both members of the duplicated record_id pair', async () => {
    expect(await violRows('unique', 'record_id')).toEqual([3, 4]);
    const [count] = await db.runner.query<{ 'count_star()': number }>(
      violCountSQL(rowSql('unique', 'record_id')),
    );
    expect(Object.values(count ?? {})[0]).toBe(2);
  });

  it('no_nulls / not_blank — NULL vs whitespace-only interview_date', async () => {
    expect(await violRows('no_nulls', 'interview_date')).toEqual([14]);
    expect(await violRows('not_blank', 'interview_date')).toEqual([14, 15]);
  });

  it('in_range — cents-scaled rent AND the -666 sentinels fall out of range', async () => {
    expect(await violRows('in_range(0, 20000)', 'monthly_rent')).toEqual([3, 4, 5, 6, 7, 10, 11]);
    expect(await violRows('in_range(0, 120)', 'reference_age')).toEqual([]);
  });

  it('in_enum — tenure 9 is outside the coded set', async () => {
    expect(await violRows('in_enum(1, 2, 3, 4, 5)', 'tenure')).toEqual([15]);
  });

  it('match_regex — full-match anchors catch hh-42 only', async () => {
    expect(await violRows("match_regex('^HH[0-9]{8}$')", 'household_id')).toEqual([13]);
  });

  it('monotonic — per-household directions over __row__ order', async () => {
    expect(
      await violRows('monotonic(decreasing, partition_by=household_id)', 'reference_age'),
    ).toEqual([1, 2, 11]);
    expect(
      await violRows('monotonic(strict_increasing, partition_by=household_id)', 'wave'),
    ).toEqual([4]);
    expect(
      await violRows('monotonic(increasing, partition_by=household_id)', 'reference_age'),
    ).toEqual([]);
  });

  it('count_distinct_in_range — bounds are inclusive (3 distinct waves)', async () => {
    const distinctWaves = async (lo: number, hi: number): Promise<boolean> => {
      const exp = expandAssertion(
        parsed(`count_distinct_in_range(${String(lo)}, ${String(hi)})`),
        'wave',
      );
      if (exp.kind !== 'column-aggregate') throw new Error('expected aggregate');
      const [row] = await db.runner.query(exp.countSql);
      const n = Number(Object.values(row ?? {})[0]);
      return n < exp.lo || n > exp.hi; // violation predicate (engine §3)
    };
    expect(await distinctWaves(3, 3)).toBe(false); // n == lo == hi → pass
    expect(await distinctWaves(1, 3)).toBe(false); // n == hi → pass
    expect(await distinctWaves(4, 20)).toBe(true); // n < lo → violation
    expect(await distinctWaves(1, 2)).toBe(true); // n > hi → violation
  });
});
