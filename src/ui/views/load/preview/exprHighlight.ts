/**
 * The eager-safe façade over exprTokens.ts: it owns the dynamic import, the
 * staleness guard, a small parse cache, and the DOM the runs turn into.
 *
 * Nothing here imports @codemirror/* — that is the point. The Load view is
 * eager, so this is the file the panel imports and exprTokens.ts is the file
 * only `import()` reaches.
 *
 * Cold, the first cells paint plain mono text and upgrade in place a tick
 * later. Warm — which is every render after the first — the module holds the
 * tokenizer synchronously, so a cell is highlighted in its first and only
 * painting and nothing flashes.
 */
import { EXPR_LINE_CAP, splitLines } from './rulesPreviewModel';
import { overflowDetails } from './previewDom';
import type { ExprLang, TokenRun } from './rulesPreviewModel';

type Tokenize = (code: string, lang: ExprLang) => TokenRun[];

let tokenizePromise: Promise<Tokenize> | null = null;
let tokenizeSync: Tokenize | null = null;

function loadTokenizer(): Promise<Tokenize> {
  // A rejected promise is kept, deliberately: a chunk that failed to load will
  // fail again, and every caller already falls back to plain text.
  tokenizePromise ??= import('./exprTokens').then((mod) => {
    tokenizeSync = mod.tokenize;
    return mod.tokenize;
  });
  return tokenizePromise;
}

/**
 * Start fetching the tokenizer chunk. Called the first time the panel has
 * rules to draw — not at mount, which would download CodeMirror for every
 * first-run visitor to serve a tab they have not filled.
 */
export function preloadHighlighter(): void {
  void loadTokenizer().catch((err: unknown) => {
    // Panel content degrades to plain mono text; nothing to tell the user.
    console.warn('expression highlighter unavailable', err);
  });
}

/**
 * The panel rebuilds wholesale on every rules-store change (load, lint settle,
 * Studio edit) and HESP alone carries 22 expressions, so re-parsing the same
 * strings on every store tick is pure waste. LRU: a hit is re-inserted, and
 * the oldest key goes when the cap is passed.
 */
const CACHE_CAP = 256;
const cache = new Map<string, TokenRun[]>();

function tokenizeCached(tokenize: Tokenize, code: string, lang: ExprLang): TokenRun[] {
  const key = `${lang} ${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const runs = tokenize(code, lang);
  cache.set(key, runs);
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return runs;
}

/**
 * Which render each host is showing. An in-flight upgrade must never write
 * into a cell the panel has already rebuilt or thrown away, and a WeakMap
 * says so without putting bookkeeping attributes in the DOM.
 */
let nextStamp = 0;
const stamps = new WeakMap<HTMLElement, number>();

/**
 * The un-highlighted rendering, in the exact shape `tokenize` returns: one
 * classless run per non-empty line with `'\n'` runs between them (highlightCode
 * skips empty text runs the same way). Identical shape means identical line
 * count, identical cap, and an upgrade that never changes the cell's height.
 */
function plainRuns(src: string): TokenRun[] {
  const runs: TokenRun[] = [];
  src.split('\n').forEach((line, index) => {
    if (index > 0) runs.push({ text: '\n', classes: '' });
    if (line !== '') runs.push({ text: line, classes: '' });
  });
  return runs;
}

function appendLines(host: DocumentFragment | HTMLElement, lines: readonly TokenRun[][]): void {
  lines.forEach((line, index) => {
    // A text node, not a <br>: the cell is `white-space: pre-wrap`, so the
    // newline IS the break, and the plain and highlighted paths stay identical.
    if (index > 0) host.append('\n');
    for (const run of line) {
      if (run.classes === '') {
        host.append(run.text);
        continue;
      }
      const span = document.createElement('span');
      span.className = run.classes;
      // textContent everywhere — no innerHTML in this module, so a rule file
      // full of angle brackets is text and can never be markup.
      span.textContent = run.text;
      host.append(span);
    }
  });
}

function paint(host: HTMLElement, runs: readonly TokenRun[]): void {
  const lines = splitLines(runs);
  const shown = document.createDocumentFragment();
  appendLines(shown, lines.slice(0, EXPR_LINE_CAP));
  host.replaceChildren(shown);
  if (lines.length <= EXPR_LINE_CAP) return;
  // The same `+N more` disclosure the dictionary folds long value lists into —
  // native <details>, so Enter/Space and aria-expanded come from the UA. It is
  // display:block, so it starts its own line without an explicit break.
  host.append(
    overflowDetails(lines.length - EXPR_LINE_CAP, (tail) => {
      appendLines(tail, lines.slice(EXPR_LINE_CAP));
    }),
  );
}

/**
 * Render one expression into `host`, highlighted if the tokenizer is available.
 *
 * `lang: 'text'` is the external-rule case: free prose that is never executed
 * (qc-rules-format.md §3), so it never goes near a parser — but it still goes
 * through the same line cap, so a ten-line note behaves like a ten-line
 * condition.
 */
export function renderExpr(host: HTMLElement, code: string, lang: ExprLang | 'text'): void {
  // The tok-* colours are scoped to this marker (primitives.css), so the
  // function that emits the classes is the one that guarantees it.
  host.classList.add('q-syntax');

  // Studio edits round-trip through the CRLF serializer (§7) and PapaParse
  // keeps \r\n inside quoted fields, so a multi-line condition really can
  // arrive here carrying CRs. highlightCode only breaks on \n; normalising up
  // front keeps both paths on the same line boundaries — CodeMirror does
  // exactly this to its own documents.
  const src = code.replace(/\r\n?/g, '\n');
  const mine = (nextStamp += 1);
  stamps.set(host, mine);

  if (lang === 'text') {
    paint(host, plainRuns(src));
    return;
  }
  if (tokenizeSync !== null) {
    paint(host, tokenizeCached(tokenizeSync, src, lang));
    return;
  }
  paint(host, plainRuns(src));
  void loadTokenizer()
    .then((tokenize) => {
      if (stamps.get(host) !== mine || !host.isConnected) return; // stale cell
      paint(host, tokenizeCached(tokenize, src, lang));
    })
    .catch(() => {
      // preloadHighlighter already reported it; the plain painting stands.
    });
}
