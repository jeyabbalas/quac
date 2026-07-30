/**
 * The headless build (headless.md §9): two Node entries into `dist-cli/`.
 *
 * An SSR build, not a library build and emphatically not esbuild — Vite 8
 * ships rolldown and esbuild is not in this tree. SSR is also what keeps
 * `dependencies` external, which two things depend on: QuickJS resolves its
 * wasm through `import.meta.url`, and `@duckdb/node-api` is a native binding.
 * Bundling either would break it.
 *
 * `dist-cli/` is gitignored and disjoint from `dist/`, so the web build, the
 * Pages artifact and the 300 KB entry gate are untouched by construction.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

const SHEBANG = '#!/usr/bin/env node\n';

export default defineConfig({
  // Same define as vite.config.ts. Without it `--version` and the summary's
  // quacVersion silently fall back to src/app/version.ts's dev sentinel.
  define: { __QUAC_VERSION__: JSON.stringify(pkg.version) },
  // `publicDir` defaults to `public/`, which vite COPIES into outDir — that is
  // the 100 MB of self-hosted duckdb-wasm the browser app serves and the Node
  // CLI has no use for (it drives the native binding). Left on, every build
  // copied it and `npm pack` shipped it: a 23 MB tarball for a 300 KB program.
  publicDir: false,
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist-cli',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        quac: fileURLToPath(new URL('./src/cli/quac.ts', import.meta.url)),
        index: fileURLToPath(new URL('./src/headless/index.ts', import.meta.url)),
      },
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name]-[hash].mjs',
        // Only the bin gets a shebang; a `#!` line in the library entry would
        // be dead weight at best and a parse hazard for some tooling.
        banner: (chunk) => (chunk.name === 'quac' && chunk.isEntry ? SHEBANG : ''),
      },
    },
  },
});
