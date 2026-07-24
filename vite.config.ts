import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  base: '/quac/',
  // Build-time app version for the Excel report's Run Info sheet (src/app/version.ts).
  define: { __QUAC_VERSION__: JSON.stringify(pkg.version) },
  optimizeDeps: {
    // quickjs: esbuild pre-bundling relocates the module, breaking its
    // `new URL('emscripten-module.wasm', import.meta.url)` asset resolution;
    // excluded deps also never trigger the late-discovery reload flake.
    exclude: [
      '@duckdb/duckdb-wasm',
      'quickjs-emscripten-core',
      '@jitl/quickjs-wasmfile-release-sync',
    ],
    // Pre-bundle upfront: late discovery mid-test-run makes Vite reload and flake.
    // ajv/ajv-formats reach the browser via dynamic import (meta-validate) and
    // the validation worker (P09) — same late-discovery reload otherwise.
    // exceljs is reached only via the report-export dynamic import (P15).
    include: [
      '@jeyabbalas/data-table',
      'ajv',
      'ajv/dist/2019.js',
      'ajv/dist/2020.js',
      'ajv-formats',
      'exceljs',
    ],
  },
  preview: { port: 4173, strictPort: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          // DuckDB-WASM init + 35 MB bundle fetches exceed the 5 s defaults in CI.
          testTimeout: 60_000,
          hookTimeout: 60_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
