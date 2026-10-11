/**
 * The two engine behaviours QuaC replaces in Ajv (src/core/schema/keywords.ts):
 * `multipleOf` read as decimals, and patterns compiled in either ECMA-262
 * dialect — both through the real `buildAjv`, so what is pinned here is what
 * a row in a validation run meets.
 */
import { describe, expect, it } from 'vitest';
import { buildAjv } from '../../../src/core/schema/ajv-engine';
import { isMultipleOf, multipleOfChecker, tolerantRegExp } from '../../../src/core/schema/keywords';

describe('multipleOf — decimal semantics (2020-12 Validation §6.2.1)', () => {
  it('money and decimals divide the way they read', () => {
    for (const [x, d] of [
      [0.07, 0.01],
      [19.99, 0.01],
      [4.35, 0.01],
      [0.3, 0.1],
      [71.2833, 0.0001],
      [1.23456789, 1e-8],
      [0.0075, 0.0001],
      [-0.3, 0.1],
      [7.5, 2.5],
      [12, 0.5],
      [1e308, 0.5], // the suite's float-overflow case
      [0, 0.7],
    ] as const) {
      expect(isMultipleOf(x, d), `${String(x)} % ${String(d)}`).toBe(true);
    }
  });

  it('and still says no where the decimal says no', () => {
    for (const [x, d] of [
      [0.075, 0.01],
      [0.00751, 0.0001],
      [1e-9, 1e-8],
      [5, 2],
      [2.5, 2],
      [0.35, 0.1],
      [1.5, 0.4],
    ] as const) {
      expect(isMultipleOf(x, d), `${String(x)} % ${String(d)}`).toBe(false);
    }
  });

  it('agrees with exact BigInt arithmetic on many random decimals', () => {
    const exact = (x: number, d: number): boolean => {
      const parts = (n: number): [bigint, number] => {
        const [mant = '', exp = '0'] = String(Math.abs(n)).split('e');
        const [int = '', frac = ''] = mant.split('.');
        const scale = frac.length - Number(exp);
        const digits = BigInt(int + frac);
        return scale >= 0 ? [digits, scale] : [digits * 10n ** BigInt(-scale), 0];
      };
      const [xd, xs] = parts(x);
      const [dd, ds] = parts(d);
      const s = Math.max(xs, ds);
      return (xd * 10n ** BigInt(s - xs)) % (dd * 10n ** BigInt(s - ds)) === 0n;
    };
    let seed = 7;
    const rand = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (const d of [0.01, 0.05, 0.25, 0.3, 0.0001, 1.5, 0.125, 3.14159]) {
      const check = multipleOfChecker(d);
      for (let i = 0; i < 5000; i += 1) {
        const places = Math.floor(rand() * 7);
        const x = Number((rand() * 10 ** Math.floor(rand() * 7)).toFixed(places));
        const multiple = Number((Math.floor(rand() * 1e5) * d).toPrecision(12));
        for (const v of [x, -x, multiple])
          expect(check(v), `${String(v)} % ${String(d)}`).toBe(exact(v, d));
      }
    }
  });

  it('replaces Ajv’s keyword with the same error shape', () => {
    const validate = buildAjv('2020-12').compile({ type: 'number', multipleOf: 0.01 });
    expect(validate(19.99)).toBe(true);
    expect(validate(0.07)).toBe(true);
    expect(validate(0.075)).toBe(false);
    expect(validate.errors?.[0]).toMatchObject({
      keyword: 'multipleOf',
      params: { multipleOf: 0.01 },
    });
    const integers = buildAjv('draft-07').compile({ multipleOf: 3 });
    expect(integers(9)).toBe(true);
    expect(integers(10)).toBe(false);
    expect(integers(4.5)).toBe(false);
    expect(integers('9')).toBe(true); // multipleOf only applies to numbers
  });
});

describe('patterns in either ECMA-262 dialect', () => {
  it('a pattern only the non-Unicode dialect accepts compiles instead of failing the run', () => {
    const ajv = buildAjv('2020-12');
    const phone = ajv.compile({ type: 'string', pattern: '^\\d{3}\\-\\d{4}$' });
    expect(phone('555-1234')).toBe(true);
    expect(phone('5551234')).toBe(false);
    for (const pattern of ['\\@', '\\_', 'a{,3}', '\\ ', "\\'", ']']) {
      expect(() => ajv.compile({ type: 'string', pattern }), pattern).not.toThrow();
    }
    const keys = ajv.compile({
      type: 'object',
      patternProperties: { '^x\\-': { type: 'integer' } },
    });
    expect(keys({ 'x-a': 1 })).toBe(true);
    expect(keys({ 'x-a': 'one' })).toBe(false);
  });

  it('a pattern valid with `u` keeps Unicode semantics', () => {
    const ajv = buildAjv('2020-12');
    expect(ajv.compile({ type: 'string', pattern: '^\\p{L}+$' })('été')).toBe(true);
    expect(ajv.compile({ type: 'string', pattern: '^.$' })('😀')).toBe(true); // one code point
    expect(tolerantRegExp('^.$', 'u').flags).toContain('u');
    expect(tolerantRegExp('\\-', 'u').flags).not.toContain('u');
  });

  it('a pattern neither dialect accepts still throws', () => {
    expect(() => tolerantRegExp('(?i)x', 'u')).toThrow();
  });
});
