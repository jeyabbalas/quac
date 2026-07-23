import { defineConfig } from 'vite';

export default defineConfig({
  base: '/quac/',
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  preview: { port: 4173, strictPort: true },
});
