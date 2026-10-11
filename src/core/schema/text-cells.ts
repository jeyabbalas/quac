/**
 * A text cell — from a CSV or TSV file, or an Excel sheet read as text — as
 * the JSON value it spells, for the Ajv row loop.
 *
 * Text carries no type, so the schema says how to read it: a cell is the JSON
 * value it spells when the schema allows that value's type, and otherwise the
 * text itself.
 *
 * - **A number** is written the way JSON writes one — `-12`, `0.5`, `1e5` —
 *   with no `+` sign, no leading zero, and a digit on both sides of a `.`.
 *   `007`, `+5`, `.5`, `1,000` and `1_000` are text.
 * - **true / false** in any letter case (Excel and Python write `TRUE`,
 *   `True`). `yes`, `t`, `1` are not booleans.
 * - **An array or object** is JSON text: `[1, 2]`, `{"k": 1}`.
 * - Spaces around a number, a boolean or JSON text are ignored, as JSON
 *   ignores them; a string keeps every character.
 *
 * So `42` under `type: integer` is the number 42, `42` under `type: string`
 * is the text "42", and `["string", "integer"]` reads `42` as 42 and `0042`
 * as text. When a cell spells no value of any type the schema allows — `abc`
 * under `type: integer` — it is a cast finding, with its own message, and
 * the validator never sees the cell.
 *
 * Pure; runs in the validation worker.
 */
import type { JsonTypeName } from './value-spec';

/** JSON's number grammar (RFC 8259 §6). */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const JSON_BOOLEAN = /^(?:true|false)$/i;

export type TextCellReading =
  /** `precision`: the digits of an integer past ±(2^53 − 1), which Ajv sees rounded. */
  | { kind: 'value'; value: unknown; precision?: string }
  /** The text spells no value of an allowed type, and text is not allowed either. */
  | { kind: 'cast'; reason: 'type' | 'non-integral' | 'out-of-range'; expected: string };

const NOUNS: readonly [JsonTypeName, string][] = [
  ['integer', 'integer'],
  ['number', 'number'],
  ['boolean', 'true/false value'],
  ['array', 'JSON array'],
  ['object', 'JSON object'],
];

/** What a cell should have held, in words: `integer`, `number or true/false value`. */
export function expectedNoun(types: ReadonlySet<JsonTypeName>): string {
  const nouns = NOUNS.filter(([t]) => types.has(t) && !(t === 'integer' && types.has('number'))).map(
    ([, noun]) => noun,
  );
  if (types.has('array') && types.has('object')) {
    nouns.splice(nouns.indexOf('JSON array'), 2, 'JSON array or object');
  }
  return nouns.length === 0 ? 'value' : nouns.join(' or ');
}

/**
 * Read one non-empty text cell. `types` is what the schema allows for the
 * column (empty: anything — read the text as the JSON value it spells, and
 * as text when it spells none).
 */
export function readTextCell(text: string, types: ReadonlySet<JsonTypeName>): TextCellReading {
  const any = types.size === 0;
  const allows = (t: JsonTypeName): boolean => any || types.has(t);
  const trimmed = text.trim();

  if ((allows('number') || allows('integer')) && JSON_NUMBER.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      if (allows('string')) return { kind: 'value', value: text };
      return { kind: 'cast', reason: 'out-of-range', expected: expectedNoun(types) };
    }
    if (!allows('number') && !Number.isInteger(value)) {
      if (allows('string')) return { kind: 'value', value: text };
      return { kind: 'cast', reason: 'non-integral', expected: expectedNoun(types) };
    }
    return Number.isInteger(value) && !Number.isSafeInteger(value)
      ? { kind: 'value', value, precision: trimmed }
      : { kind: 'value', value };
  }
  if (allows('boolean') && JSON_BOOLEAN.test(trimmed)) {
    return { kind: 'value', value: trimmed.toLowerCase() === 'true' };
  }
  if ((allows('array') || allows('object')) && (trimmed.startsWith('[') || trimmed.startsWith('{'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) ? allows('array') : allows('object')) return { kind: 'value', value: parsed };
    } catch {
      // Not JSON: text, or a cast finding below.
    }
  }
  if (allows('string')) return { kind: 'value', value: text };
  // Nothing the schema allows. A type the reader has no text form for (only
  // `null`, say) gets the text itself, and Ajv names the mismatch.
  const expected = expectedNoun(types);
  return expected === 'value' ? { kind: 'value', value: text } : { kind: 'cast', reason: 'type', expected };
}
