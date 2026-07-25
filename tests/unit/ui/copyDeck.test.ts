/**
 * P19 tasks 2 + 3 — the copy deck (`ui-design.md §6`) as a test rather than a
 * convention.
 *
 * Two guarantees:
 *  1. The three sanctioned loading lines are exactly the three in the spec.
 *  2. Pun containment. Duck jokes are rationed: the loading lines, at most one
 *     per empty state, and nowhere else — errors are NEVER jokes. This walks
 *     every `src/**` source plus `index.html`, drops comments (a pun in a code
 *     comment is not user-facing copy), keeps only the string literals users
 *     can actually see, subtracts identifier noise, and requires every
 *     surviving hit to be named in ALLOWED below.
 *
 * Adding a pun is therefore a deliberate act: you have to come here and write
 * it down. That is the whole point.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DUCK_LOADING_LINES } from '../../../src/ui/components/duckProgress';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** ui-design.md §6, verbatim — ellipses included. */
const SANCTIONED = [
  'Getting your ducks in a row…',
  'Dabbling through your data…',
  'Quacking the checks…',
];

const PUN = /\b(duck|ducks|ducky|quack\w*|dabbl\w*)\b/i;

/**
 * Every user-visible pun in the app, keyed by the file that owns it. A file
 * absent from this map may not contain one at all.
 */
const ALLOWED = new Map<string, readonly string[]>([
  // The rotating loading copy — its single home.
  ['src/ui/components/duckProgress.ts', SANCTIONED],
  // The demo modal reuses a sanctioned line (no ellipsis: it is a static
  // caption for a determinate bar, not a line that rotates).
  ['src/app/shell.ts', ['Quacking the checks']],
  // The one in-panel pun: the Findings panel's empty. §6 allows one per empty
  // state; the Report and Studio view-level empties spend theirs on
  // "see what floats up", which carries no pun WORD and so never reaches here.
  ['src/ui/views/report/reportPanels.ts', ['No dataset- or column-level findings. Ducky.']],
]);

/**
 * Identifiers that merely CONTAIN a pun word: the vendored engine's name, the
 * component's own name, CSS hooks, the asset path. They are not copy, and are
 * removed before matching so a class rename can never be mistaken for a joke.
 */
// Order matters: the longest identifiers first, or a shorter pattern eats the
// middle of one and leaves a bare `duck` behind (q-duckprogress-duck did
// exactly that).
const NOISE = [
  /q-duck[\w-]*/gi,
  /q-empty-duck/gi,
  /q-example-duck/gi,
  /logo\/quac-duck\.svg/gi,
  /--q-dp-duck/gi,
  /duckdb[\w-]*/gi,
  /duck-?progress/gi,
];

const denoise = (text: string): string =>
  NOISE.reduce((acc, pattern) => acc.replaceAll(pattern, ''), text);

interface Literal {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Comment-aware scan of a TS source. Returns the string/template literals,
 * which is where copy lives. A naive `//` strip would mangle every URL in the
 * file, so this tracks strings, templates, comments, and regex literals in one
 * pass; `prev` is the last significant character, which is what disambiguates
 * a regex literal from a division.
 */
function tsLiterals(file: string, src: string): Literal[] {
  const out: Literal[] = [];
  let line = 1;
  let prev = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') {
      line++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    // A regex literal can hold quotes; skipping it keeps the scanner in sync.
    if (c === '/' && prev !== '' && !/[\w)\]]/.test(prev)) {
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i++;
      }
      prev = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const startLine = line;
      let text = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          i++;
        } else if (src[i] === '\n') {
          line++;
        }
        text += src[i] ?? '';
        i++;
      }
      out.push({ file, line: startLine, text });
      prev = quote;
      continue;
    }
    if (!/\s/.test(c ?? '')) prev = c ?? '';
  }
  return out;
}

/** CSS has no `//` comments; only `/* … *\/` matters, and only outside quotes. */
function cssLiterals(file: string, src: string): Literal[] {
  const out: Literal[] = [];
  let line = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') {
      line++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const startLine = line;
      let text = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\n') line++;
        text += src[i] ?? '';
        i++;
      }
      out.push({ file, line: startLine, text });
    }
  }
  return out;
}

/** Everything outside `<!-- … -->` is either markup text or an attribute value. */
function htmlText(file: string, src: string): Literal[] {
  const stripped = src.replaceAll(/<!--[\s\S]*?-->/g, '');
  return [{ file, line: 1, text: stripped }];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|css)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

describe('copy deck', () => {
  it('DUCK_LOADING_LINES is exactly the three sanctioned lines', () => {
    expect([...DUCK_LOADING_LINES]).toEqual(SANCTIONED);
  });

  it('every user-visible pun is in the allowlist', () => {
    const literals: Literal[] = [];
    for (const path of sourceFiles(join(ROOT, 'src'))) {
      const rel = relative(ROOT, path).split(sep).join('/');
      const src = readFileSync(path, 'utf8');
      literals.push(...(path.endsWith('.css') ? cssLiterals : tsLiterals)(rel, src));
    }
    literals.push(...htmlText('index.html', readFileSync(join(ROOT, 'index.html'), 'utf8')));

    const unexpected = literals
      .filter((lit) => PUN.test(denoise(lit.text)))
      .filter((lit) => !(ALLOWED.get(lit.file) ?? []).includes(lit.text))
      .map((lit) => `${lit.file}:${String(lit.line)} — ${JSON.stringify(lit.text)}`);

    expect(unexpected, 'unallowlisted duck puns in user-visible copy').toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    // A pun that has been removed from the app must be removed from here too,
    // or the list stops describing anything.
    const byFile = new Map<string, Set<string>>();
    for (const path of sourceFiles(join(ROOT, 'src'))) {
      const rel = relative(ROOT, path).split(sep).join('/');
      if (!ALLOWED.has(rel)) continue;
      const found = (path.endsWith('.css') ? cssLiterals : tsLiterals)(
        rel,
        readFileSync(path, 'utf8'),
      );
      byFile.set(rel, new Set(found.map((lit) => lit.text)));
    }
    const stale: string[] = [];
    for (const [file, phrases] of ALLOWED) {
      for (const phrase of phrases) {
        if (!byFile.get(file)?.has(phrase)) stale.push(`${file} — ${JSON.stringify(phrase)}`);
      }
    }
    expect(stale, 'allowlisted puns no longer present in the source').toEqual([]);
  });
});
