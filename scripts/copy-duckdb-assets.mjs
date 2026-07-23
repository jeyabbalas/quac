/**
 * Self-host DuckDB WASM (architecture.md §8 item 4, data-table-api.md §8):
 * copy the mvp/eh bundles from @duckdb/duckdb-wasm into public/duckdb/ so the
 * deployed site makes zero third-party requests. Wired as predev/prebuild/
 * pretest:browser; public/duckdb/ is gitignored (derived, ~77 MB).
 * The coi bundle is skipped: it needs COOP/COEP headers GitHub Pages can't set.
 * Bundle URLs are built in src/core/bridge/bridge.ts (Verified facts V8).
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = [
  'duckdb-mvp.wasm',
  'duckdb-browser-mvp.worker.js',
  'duckdb-eh.wasm',
  'duckdb-browser-eh.worker.js',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
const outDir = join(root, 'public', 'duckdb');

if (!existsSync(srcDir)) {
  console.error(
    `copy-duckdb-assets: FAIL — ${srcDir} not found. Run \`npm ci\` first.`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const file of FILES) {
  const src = join(srcDir, file);
  const out = join(outDir, file);
  if (!existsSync(src)) {
    console.error(
      `copy-duckdb-assets: FAIL — ${file} missing from @duckdb/duckdb-wasm/dist (layout changed?)`,
    );
    process.exit(1);
  }
  const srcStat = statSync(src);
  if (existsSync(out)) {
    const outStat = statSync(out);
    if (outStat.size === srcStat.size && outStat.mtimeMs >= srcStat.mtimeMs) {
      continue;
    }
  }
  copyFileSync(src, out);
  copied += 1;
}

console.log(
  `copy-duckdb-assets: OK — ${copied} copied, ${FILES.length - copied} up to date in public/duckdb/`,
);
