import { expect, test } from 'vitest';

// P01 harness proof: real Chromium via @vitest/browser-playwright.
// P03 replaces the meat of this tier with real duckdb-wasm bridge tests.
test('browser tier runs in a real browser with the APIs P03 needs', () => {
  expect(typeof window).toBe('object');
  expect(document.createElement('canvas')).toBeInstanceOf(HTMLElement);
  expect(typeof WebAssembly).toBe('object');
  expect(typeof Worker).toBe('function');
});
