/**
 * buildDuckDBBundles() URL construction (Verified facts V8). Bases are passed
 * explicitly — the Vitest node env reports import.meta.env.BASE_URL as '/'
 * regardless of the vite `base` (Verified facts V9), so asserting the literal
 * deployed base here would be meaningless.
 */
import { expect, test } from 'vitest';
import { buildDuckDBBundles } from '../../../src/core/bridge/bridge';

test('builds the four self-hosted bundle URLs under the given base', () => {
  expect(buildDuckDBBundles('/quac/')).toEqual({
    mvp: {
      mainModule: '/quac/duckdb/duckdb-mvp.wasm',
      mainWorker: '/quac/duckdb/quac-duckdb-browser-mvp.worker.js',
    },
    eh: {
      mainModule: '/quac/duckdb/duckdb-eh.wasm',
      mainWorker: '/quac/duckdb/quac-duckdb-browser-eh.worker.js',
    },
  });
});

test('join is slash-safe for bases with and without a trailing slash', () => {
  expect(buildDuckDBBundles('/quac').eh?.mainModule).toBe('/quac/duckdb/duckdb-eh.wasm');
  expect(buildDuckDBBundles('/').mvp.mainWorker).toBe('/duckdb/quac-duckdb-browser-mvp.worker.js');
});
