/**
 * The real CodeMirror path behind the QC rules preview, on real HESP
 * expressions.
 *
 * This runs in the `environment: 'node'` unit project, not the browser one:
 * @codemirror/lang-sql pulls @codemirror/language → @codemirror/view, but
 * nothing on the import-and-parse path touches the DOM, so the fast project
 * can afford to pin it. If that ever stops being true the whole file moves to
 * tests/browser/ unchanged — the assertions do not depend on the environment.
 */
import { describe, expect, it } from 'vitest';
import { tokenize } from '../../../src/ui/views/load/preview/exprTokens';
import { splitLines } from '../../../src/ui/views/load/preview/rulesPreviewModel';
import type { ExprLang } from '../../../src/ui/views/load/preview/rulesPreviewModel';

/** `[text, classes]` pairs — terser to read than the object form in a table. */
const pairs = (code: string, lang: ExprLang): [string, string][] =>
  tokenize(code, lang).map((run) => [run.text, run.classes]);

const classOf = (code: string, lang: ExprLang, text: string): string | undefined =>
  tokenize(code, lang).find((run) => run.text === text)?.classes;

describe('tokenize — the round-trip invariant', () => {
  const SAMPLES: [string, ExprLang][] = [
    ['__value__ IN (777, 888, 999) AND tenure <> -666', 'sql'],
    ["match_regex('^HH[0-9]{8}$')", 'sql'],
    ['unique', 'sql'],
    ['(value, row) => { return value ?? null; }', 'js'],
    ['a >= 0\nAND b >= 0\nAND c > 1', 'sql'],
    ["SELECT 'a\nmulti\nline' AS x", 'sql'],
    ['/* block\ncomment */ const x = 1;', 'js'],
    ['', 'sql'],
  ];

  it.each(SAMPLES)('concatenating the runs reproduces %j exactly', (code, lang) => {
    expect(
      tokenize(code, lang)
        .map((run) => run.text)
        .join(''),
    ).toBe(code);
  });

  it.each(SAMPLES)('never emits a text run spanning a newline in %j', (code, lang) => {
    // splitLines() is exact only because of this: every break arrives as its
    // own classless '\n' run, including inside strings and block comments.
    for (const run of tokenize(code, lang)) {
      if (run.text === '\n' && run.classes === '') continue;
      expect(run.text).not.toContain('\n');
    }
  });
});

describe('tokenize — SQL', () => {
  it('reads a sentinel recode the way the Studio editor does', () => {
    expect(pairs('__value__ IN (777, 888, 999) AND tenure <> -666', 'sql')).toEqual([
      // __value__ is an Identifier, which classHighlighter emits nothing for —
      // unstyled here AND unstyled in the editor, which is the point.
      ['__value__ ', ''],
      ['IN', 'tok-keyword'],
      [' ', ''],
      ['(', 'tok-punctuation'],
      ['777', 'tok-number'],
      [',', 'tok-punctuation'],
      [' ', ''],
      ['888', 'tok-number'],
      [',', 'tok-punctuation'],
      [' ', ''],
      ['999', 'tok-number'],
      [')', 'tok-punctuation'],
      [' ', ''],
      ['AND', 'tok-keyword'],
      [' tenure ', ''],
      ['<>', 'tok-operator'],
      [' ', ''],
      ['-', 'tok-operator'],
      ['666', 'tok-number'],
    ]);
  });

  it('reads the column-scope assertion DSL correctly (qc-rules-format.md §4.1)', () => {
    // The reason conditionLang() hands `column` scope to the SQL parser: a
    // shorthand is an identifier, parens and a quoted string to Lezer.
    expect(pairs("match_regex('^HH[0-9]{8}$')", 'sql')).toEqual([
      ['match_regex', ''],
      ['(', 'tok-punctuation'],
      ["'^HH[0-9]{8}$'", 'tok-string'],
      [')', 'tok-punctuation'],
    ]);
    expect(pairs('unique', 'sql')).toEqual([['unique', 'tok-keyword']]);
  });

  it('breaks the deliberate multi-line SQL of the format spec at its newlines', () => {
    const runs = tokenize('a >= 0\nAND b >= 0\nAND c > 1', 'sql');
    const breaks = runs.flatMap((run, index) => (run.text === '\n' ? [index] : []));
    // `a `,`>=`,` `,`0` | break | `AND`,` b `,`>=`,` `,`0` | break | …
    expect(breaks).toEqual([4, 10]);
    expect(runs.filter((run) => run.text === '\n').every((run) => run.classes === '')).toBe(true);
    expect(splitLines(runs)).toHaveLength(3);
  });
});

describe('tokenize — JavaScript', () => {
  it('reads a correction arrow function', () => {
    const code = '(value, row) => { return value ?? null; }';
    expect(classOf(code, 'js', 'value')).toBe('tok-variableName tok-definition');
    expect(classOf(code, 'js', 'row')).toBe('tok-variableName tok-definition');
    expect(classOf(code, 'js', 'return')).toBe('tok-keyword');
    expect(classOf(code, 'js', 'null')).toBe('tok-keyword');
    expect(classOf(code, 'js', '??')).toBe('tok-operator');
  });

  it('highlights the HESP H006 id normaliser across its four lines', () => {
    const code = [
      '(value, row) => {',
      '  const m = /^hh[\\s_-]*([0-9]{1,8})$/i.exec(String(value).trim());',
      '  if (!m) return value; // leave unrecognized formats for manual review',
      "  return 'HH' + m[1].padStart(8, '0');",
      '}',
    ].join('\n');
    const runs = tokenize(code, 'js');
    expect(splitLines(runs)).toHaveLength(5);
    expect(runs.some((run) => run.classes === 'tok-comment')).toBe(true);
    expect(runs.some((run) => run.classes === 'tok-string')).toBe(true);
    expect(classOf(code, 'js', 'const')).toBe('tok-keyword');
  });
});
