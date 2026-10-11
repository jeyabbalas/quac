/**
 * A JSON dataset's records as the file wrote them (src/core/schema/json-records.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { decodeJsonText, jsonArrayElements } from '../../../src/core/schema/json-records';
import { fixtureDir } from './helpers';

describe('jsonArrayElements', () => {
  test('the exact text of each element — whitespace inside kept, around trimmed', () => {
    const text = '﻿ [ {"a": 1, "b": "x, ] }"} ,\n{"a":[1,{"c":"\\"]"}]}, 5, "s", null ]\n';
    expect(jsonArrayElements(text)).toEqual(['{"a": 1, "b": "x, ] }"}', '{"a":[1,{"c":"\\"]"}]}', '5', '"s"', 'null']);
  });

  test('escaped backslashes before a quote', () => {
    expect(jsonArrayElements('[{"k":"a\\\\"},{"k":"b\\\\\\""}]')).toEqual(['{"k":"a\\\\"}', '{"k":"b\\\\\\""}']);
  });

  test('empty arrays and the refusals', () => {
    expect(jsonArrayElements('[]')).toEqual([]);
    expect(jsonArrayElements(' [ ] ')).toEqual([]);
    expect(() => jsonArrayElements('{"a":1}')).toThrow(SyntaxError);
    expect(() => jsonArrayElements('[{"a":1}] x')).toThrow(SyntaxError);
    expect(() => jsonArrayElements('[{"a":1}')).toThrow(SyntaxError);
    expect(() => jsonArrayElements('[{"a":"unterminated}]')).toThrow(SyntaxError);
  });

  test('every element of the vendored nested stress fixture equals JSON.parse’s reading', () => {
    const text = decodeJsonText(readFileSync(fixtureDir('nested', 'nested-stress-tests.json')));
    const whole = JSON.parse(text) as unknown[];
    const elements = jsonArrayElements(text);
    expect(elements).toHaveLength(whole.length);
    elements.forEach((element, i) => {
      expect(JSON.parse(element)).toEqual(whole[i]);
    });
  });
});
