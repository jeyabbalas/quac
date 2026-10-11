/**
 * A text cell read as the JSON value it spells (src/core/schema/text-cells.ts).
 */
import { describe, expect, test } from 'vitest';
import { expectedNoun, readTextCell } from '../../../src/core/schema/text-cells';
import type { JsonTypeName } from '../../../src/core/schema/value-spec';

const types = (...names: JsonTypeName[]): Set<JsonTypeName> => new Set(names);

describe('readTextCell', () => {
  test("JSON's number grammar, nothing looser", () => {
    for (const [text, value] of [
      ['0', 0],
      ['-12', -12],
      ['0.5', 0.5],
      ['1e5', 100000],
      ['1E+2', 100],
      ['-0', -0],
      [' 42 ', 42],
    ] as const) {
      expect(readTextCell(text, types('number')), text).toEqual({ kind: 'value', value });
    }
    for (const text of ['+5', '.5', '5.', '007', '0x1F', '1_000', '1,000', 'NaN', 'Infinity', '']) {
      expect(readTextCell(text, types('number')).kind, text).toBe('cast');
    }
  });

  test('integer-only columns: a fraction is non-integral, a huge integer is read with its digits', () => {
    expect(readTextCell('1.5', types('integer'))).toEqual({ kind: 'cast', reason: 'non-integral', expected: 'integer' });
    expect(readTextCell('2.0', types('integer'))).toEqual({ kind: 'value', value: 2 });
    expect(readTextCell('18446744073709551615', types('integer'))).toEqual({
      kind: 'value',
      value: 2 ** 64,
      precision: '18446744073709551615',
    });
    expect(readTextCell('1e400', types('number'))).toEqual({ kind: 'cast', reason: 'out-of-range', expected: 'number' });
  });

  test('booleans are true/false in any letter case', () => {
    expect(readTextCell('TRUE', types('boolean'))).toEqual({ kind: 'value', value: true });
    expect(readTextCell('False', types('boolean'))).toEqual({ kind: 'value', value: false });
    for (const text of ['yes', 't', '1', 'on']) expect(readTextCell(text, types('boolean')).kind, text).toBe('cast');
  });

  test('JSON arrays and objects, strictly', () => {
    expect(readTextCell(' [1, 2] ', types('array'))).toEqual({ kind: 'value', value: [1, 2] });
    expect(readTextCell('{"k":1}', types('object'))).toEqual({ kind: 'value', value: { k: 1 } });
    expect(readTextCell('[1,]', types('array')).kind).toBe('cast');
    expect(readTextCell('{"k":1}', types('array')).kind).toBe('cast');
  });

  test('where text is allowed, text that spells nothing else stays text — as written', () => {
    expect(readTextCell(' 0042 ', types('integer', 'string'))).toEqual({ kind: 'value', value: ' 0042 ' });
    expect(readTextCell('42', types('string'))).toEqual({ kind: 'value', value: '42' });
  });

  test('an unconstrained column reads the value the text spells', () => {
    expect(readTextCell('42', types())).toEqual({ kind: 'value', value: 42 });
    expect(readTextCell('true', types())).toEqual({ kind: 'value', value: true });
    expect(readTextCell('[1]', types())).toEqual({ kind: 'value', value: [1] });
    expect(readTextCell('abc', types())).toEqual({ kind: 'value', value: 'abc' });
  });

  test('a type with no text form (only null) hands the text to the validator', () => {
    expect(readTextCell('x', types('null'))).toEqual({ kind: 'value', value: 'x' });
  });
});

describe('expectedNoun', () => {
  test('names what a cell should have held', () => {
    expect(expectedNoun(types('integer'))).toBe('integer');
    expect(expectedNoun(types('integer', 'number'))).toBe('number');
    expect(expectedNoun(types('boolean', 'integer'))).toBe('integer or true/false value');
    expect(expectedNoun(types('array', 'object', 'null'))).toBe('JSON array or object');
    expect(expectedNoun(types('null'))).toBe('value');
  });
});
