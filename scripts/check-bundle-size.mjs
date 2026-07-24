/**
 * Bundle budget gate (testing-strategy.md §4): entry JS <= 300 KB gzipped.
 * "Entry" = module scripts + modulepreload links referenced by dist/index.html
 * (everything that loads eagerly). Dynamic-import lazy chunks and .wasm are
 * excluded by construction: they are never referenced from index.html.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT_BYTES = 300 * 1024;
// exceljs (P15) is huge and must stay a lazy chunk; this marker (the UMD global
// assignment `.ExcelJS=…`) appears only in its bundle, never in minified app code.
const EXCELJS_MARKER = 'ExcelJS';
// CodeMirror (P17 Studio) must stay in the lazy workspace chunk; this marker is
// a live-announcer class name string in @codemirror/view's dist (survives
// minification), absent from app sources.
const CODEMIRROR_MARKER = 'cm-announced';
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const html = readFileSync(join(distDir, 'index.html'), 'utf8');

const refs = new Set();
for (const match of html.matchAll(/<script\b[^>]*>|<link\b[^>]*>/g)) {
  const tag = match[0];
  const isEntryScript = tag.startsWith('<script') && tag.includes('type="module"');
  const isPreload = tag.startsWith('<link') && tag.includes('rel="modulepreload"');
  if (!isEntryScript && !isPreload) continue;
  const url = /(?:src|href)="([^"]+\.js)"/.exec(tag)?.[1];
  if (url) refs.add(url);
}

if (refs.size === 0) {
  console.error('check-bundle-size: FAIL — no entry JS found in dist/index.html (build shape changed?)');
  process.exit(1);
}

let total = 0;
const entryRels = new Set();
for (const ref of refs) {
  const rel = ref.replace(/^\/quac\//, '').replace(/^\//, '');
  entryRels.add(rel);
  const bytes = readFileSync(join(distDir, rel));
  const gz = gzipSync(bytes).length;
  total += gz;
  console.log(`  ${rel}  ${(gz / 1024).toFixed(1)} KB gz`);
  // The exceljs writer is dynamically imported; it must never be pulled into an
  // eager entry chunk (would blow the budget and delay first paint by ~256 KB gz).
  if (bytes.includes(EXCELJS_MARKER)) {
    console.error(`check-bundle-size: FAIL — exceljs leaked into the entry chunk ${rel}`);
    process.exit(1);
  }
  // Same discipline for CodeMirror: only the lazy studio workspace chunk may
  // carry it (~150 KB raw that first paint never needs).
  if (bytes.includes(CODEMIRROR_MARKER)) {
    console.error(`check-bundle-size: FAIL — CodeMirror leaked into the entry chunk ${rel}`);
    process.exit(1);
  }
}

console.log(`entry JS total: ${(total / 1024).toFixed(1)} KB gz (budget ${LIMIT_BYTES / 1024} KB)`);
if (total > LIMIT_BYTES) {
  console.error('check-bundle-size: FAIL — entry bundle exceeds budget');
  process.exit(1);
}

// Report the lazy exceljs/CodeMirror chunk weights so their cost stays visible
// in CI logs.
const assetsDir = join(distDir, 'assets');
const lazyChunks = readdirSync(assetsDir).filter(
  (f) => f.endsWith('.js') && !entryRels.has(`assets/${f}`),
);
for (const { label, marker, missing } of [
  { label: 'exceljs', marker: EXCELJS_MARKER, missing: 'report-export path absent?' },
  { label: 'codemirror', marker: CODEMIRROR_MARKER, missing: 'studio workspace path absent?' },
]) {
  const chunk = lazyChunks.find((f) => readFileSync(join(assetsDir, f)).includes(marker));
  if (chunk === undefined) {
    console.log(`lazy ${label} chunk: not built (${missing})`);
  } else {
    const gz = gzipSync(readFileSync(join(assetsDir, chunk))).length;
    console.log(`lazy ${label} chunk: assets/${chunk}  ${(gz / 1024).toFixed(1)} KB gz`);
  }
}

console.log('check-bundle-size: OK');
