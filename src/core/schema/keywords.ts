/**
 * Two engine behaviours QuaC replaces in Ajv, because Ajv's own are wrong for
 * data that people actually have.
 *
 * 1. `multipleOf` with decimal semantics. JSON numbers are decimals, and
 *    2020-12 Validation §6.2.1 asks whether dividing by the keyword's value
 *    gives an integer. Ajv divides doubles — `0.07 / 0.01` is
 *    `7.000000000000001` — so money columns with `multipleOf: 0.01` reported
 *    ordinary prices like 19.99 as errors. Here each number is read as the
 *    decimal it was written as (its shortest round-trip form, which is what
 *    JSON.parse and DuckDB hand over) and compared exactly, as scaled BigInts.
 *    An integer divisor takes the plain `%` path: the remainder of two
 *    integer-valued doubles is exact (fmod), and a non-integer can never be a
 *    multiple of an integer.
 *
 * 2. Patterns in either dialect. Ajv compiles `pattern` and
 *    `patternProperties` with the `u` flag, under which `\-`, `\@`, `\_`, a
 *    lone `{` or `]` and `a{,3}` are syntax errors — and one such pattern
 *    killed the whole validation run. ECMA-262 accepts them without `u`
 *    (Annex B), as every browser does, so `tolerantRegExp` compiles with `u`
 *    and falls back to the non-Unicode dialect only when `u` refuses. A
 *    pattern valid either way keeps `u`, so `\p{L}` and astral characters
 *    still mean what the schema says.
 */
import { _, str } from 'ajv';
import type AjvCore from 'ajv/dist/core';
import type { KeywordCxt } from 'ajv';

/** A non-integer's magnitude as `digits × 10^−scale` (scale ≥ 1), from its shortest round-trip text. */
interface Decimal {
  digits: string;
  scale: number;
}

function decimalOf(n: number): Decimal {
  const text = String(Math.abs(n)); // "19.99", "7.5e-7" — never an exponent above 20 for a non-integer
  const e = text.indexOf('e');
  const mantissa = e === -1 ? text : text.slice(0, e);
  const exponent = e === -1 ? 0 : Number(text.slice(e + 1));
  const dot = mantissa.indexOf('.');
  const fraction = dot === -1 ? 0 : mantissa.length - dot - 1;
  const digits = dot === -1 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  return { digits, scale: fraction - exponent };
}

/** Is `x` an integer multiple of the decimal `d`? Exact; false for non-finite input. */
export function isMultipleOf(x: number, d: number): boolean {
  return multipleOfChecker(d)(x);
}

/**
 * The check for one divisor, prepared once — the divisor is a constant of
 * the compiled schema, so its decimal is read at compile time. Three paths,
 * all exact:
 *
 * - an integer divisor: `%` on the doubles (exact for integer values), and a
 *   non-integer is never a multiple;
 * - an integer value over a decimal divisor `D × 10^−s`: x × 10^s must be a
 *   multiple of D — always, when D divides 10^s (0.5, 0.25, 0.01 …);
 * - two decimals: both scaled to the same exponent, compared as integers —
 *   in doubles while they stay below 2^53, as BigInts past it.
 */
export function multipleOfChecker(divisor: number): (x: number) => boolean {
  if (!Number.isFinite(divisor) || divisor <= 0) return () => false;
  if (Number.isInteger(divisor)) {
    return (x) => Number.isInteger(x) && x % divisor === 0;
  }
  const d = decimalOf(divisor);
  const dDigits = BigInt(d.digits);
  const dNumber = Number(d.digits);
  const integersAlwaysMultiples = 10n ** BigInt(d.scale) % dDigits === 0n;
  // 10^s exactly, for the double path below (10^22 is the last exact power);
  // 0 turns that path off, as does a divisor with more digits than 2^53 holds.
  const power = d.scale <= 22 && Number.isSafeInteger(dNumber) ? 10 ** d.scale : 0;
  return (x) => {
    if (!Number.isFinite(x)) return false;
    if (Number.isInteger(x)) {
      return integersAlwaysMultiples || (BigInt(x) * 10n ** BigInt(d.scale)) % dDigits === 0n;
    }
    // Doubles, no text: m = x·10^s rounded. When m / 10^s gives x back, x is
    // the decimal m × 10^−s (its shortest form has at most s fraction
    // digits), so it is a multiple exactly when m is a multiple of D; when it
    // does not, x has more fraction digits than any multiple of D × 10^−s.
    // Safe while |m| < 2^51, where the rounding of x·10^s cannot reach ½.
    if (power !== 0) {
      const scaled = x * power;
      if (Math.abs(scaled) < 2 ** 51) {
        const m = Math.round(scaled);
        return m / power === x && m % dNumber === 0;
      }
    }
    const v = decimalOf(x);
    const scale = Math.max(v.scale, d.scale);
    const vScaled = Number(v.digits) * 10 ** (scale - v.scale);
    const dScaled = dNumber * 10 ** (scale - d.scale);
    if (Number.isSafeInteger(vScaled) && Number.isSafeInteger(dScaled))
      return vScaled % dScaled === 0;
    const vi = BigInt(v.digits) * 10n ** BigInt(scale - v.scale);
    const di = dDigits * 10n ** BigInt(scale - d.scale);
    return vi % di === 0n;
  };
}

/**
 * Replace Ajv's `multipleOf` with the exact one. Same keyword, same error
 * shape (`params: { multipleOf }`), so everything reading Ajv errors is
 * unaffected.
 */
export function useExactMultipleOf(ajv: AjvCore): void {
  ajv.removeKeyword('multipleOf');
  ajv.addKeyword({
    keyword: 'multipleOf',
    type: 'number',
    schemaType: 'number',
    error: {
      message: ({ schemaCode }) => str`must be multiple of ${schemaCode}`,
      params: ({ schemaCode }) => _`{multipleOf: ${schemaCode}}`,
    },
    code(cxt: KeywordCxt) {
      const { gen, data } = cxt;
      // `schemaType: 'number'` and meta-validation guarantee a number above 0.
      const divisor = Number(cxt.schema);
      if (Number.isSafeInteger(divisor) && divisor > 0) {
        // Inline, as Ajv's own: `%` is exact on integer-valued doubles.
        cxt.fail(_`!Number.isInteger(${data}) || ${data} % ${divisor} !== 0`);
        return;
      }
      const check = gen.scopeValue('func', { ref: multipleOfChecker(divisor) });
      cxt.fail(_`!${check}(${data})`);
    },
  });
}

/**
 * Ajv's `code.regExp` hook: compile with the flags Ajv asks for, and when
 * the Unicode dialect refuses the pattern, without `u`. A pattern neither
 * dialect accepts still throws — the load-time check names it first.
 */
export const tolerantRegExp = Object.assign(
  (pattern: string, flags: string): RegExp => {
    try {
      return new RegExp(pattern, flags);
    } catch (err) {
      if (!flags.includes('u')) throw err;
      return new RegExp(pattern, flags.replace('u', ''));
    }
  },
  { code: 'new RegExp' },
);
