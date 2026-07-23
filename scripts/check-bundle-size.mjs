/**
 * Bundle budget gate (testing-strategy.md §4): entry JS <= 300 KB gzipped.
 * "Entry" = module scripts + modulepreload links referenced by dist/index.html
 * (everything that loads eagerly). Dynamic-import lazy chunks and .wasm are
 * excluded by construction: they are never referenced from index.html.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT_BYTES = 300 * 1024;
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
for (const ref of refs) {
  const rel = ref.replace(/^\/quac\//, '').replace(/^\//, '');
  const gz = gzipSync(readFileSync(join(distDir, rel))).length;
  total += gz;
  console.log(`  ${rel}  ${(gz / 1024).toFixed(1)} KB gz`);
}

console.log(`entry JS total: ${(total / 1024).toFixed(1)} KB gz (budget ${LIMIT_BYTES / 1024} KB)`);
if (total > LIMIT_BYTES) {
  console.error('check-bundle-size: FAIL — entry bundle exceeds budget');
  process.exit(1);
}
console.log('check-bundle-size: OK');
