/**
 * SQL/JS → TokenRun[] adapter for the QC rules preview: the only module
 * outside views/studio that imports @codemirror/*, and it is reached SOLELY
 * through the dynamic import() in exprHighlight.ts.
 *
 * Bundle gate (check-bundle-size.mjs:19,61-64): the build hard-fails if a
 * @codemirror/view dist marker turns up in any eagerly-loaded entry chunk.
 * @codemirror/lang-sql → @codemirror/language → @codemirror/view, and the Load
 * view is eager — so a STATIC import of this module from anywhere under
 * views/load breaks `npm run build`, loudly. Same discipline, same reason as
 * codeEditor.ts:1-17 and core/rules/sandbox-loader.ts. Rolldown hoists the
 * shared CodeMirror code into a chunk that both this module and the lazy
 * studio workspace import; nothing eager references it, so the gate stays
 * green and `npm run size` keeps reporting codemirror as a lazy chunk.
 *
 * The parsers are the two the Studio editors already use, and classHighlighter
 * emits the same `tok-*` class names `syntaxHighlighting(classHighlighter)`
 * puts in those editors — so an expression is coloured identically whether you
 * are reading it in the Load preview or editing it in the Studio, by
 * construction rather than by two palettes agreeing.
 */
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { PostgreSQL } from '@codemirror/lang-sql';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import type { ExprLang, TokenRun } from './rulesPreviewModel';

/**
 * Highlight `code` into a flat run list. Concatenating every `text` reproduces
 * the input exactly — the invariant the plain-text fallback and `splitLines`
 * both rest on. Line breaks come back as a run of exactly `'\n'` with no
 * classes: `highlightCode` splits its own output at every newline and never
 * emits a text run spanning one, so a `'\n'` run is an unambiguous line
 * boundary. Rendering the break as a run rather than a `<br>` is what makes
 * the highlighted and un-highlighted paintings identical in layout under
 * `white-space: pre-wrap`.
 *
 * Degradation is by design: DuckDB-only keywords are not in the PostgreSQL
 * dialect's keyword list and come back unstyled, and `Identifier` maps to a
 * tag classHighlighter emits nothing for, so `__value__` and `__row__` stay
 * plain — exactly as they do in the Studio editors.
 */
export function tokenize(code: string, lang: ExprLang): TokenRun[] {
  const parser = lang === 'sql' ? PostgreSQL.language.parser : javascriptLanguage.parser;
  const runs: TokenRun[] = [];
  highlightCode(
    code,
    parser.parse(code),
    classHighlighter,
    (text, classes) => {
      runs.push({ text, classes });
    },
    () => {
      runs.push({ text: '\n', classes: '' });
    },
  );
  return runs;
}
