/**
 * UX-07 regression: the bundled example's OWN share link must fit the
 * portability limit at the origin QuaC actually ships to.
 *
 * The finding was origin-dependent, which is exactly why five manual passes and
 * a full e2e suite missed it: with all 14 schema files inline the link measured
 * 1965 chars at `http://localhost:4173/quac/` (under) and 2062 at
 * `https://jeyabbalas.github.io/quac/` (over), so the flagship "Load example
 * files → Share" path was broken only in production. Measuring at the DEPLOYED
 * base is the whole point of this test — pinning it locally would reproduce the
 * blind spot rather than close it.
 *
 * Built from `tests/fixtures/hesp/` through the same `buildExampleIndex` the
 * generator uses, so a fixture that grows a file, or an index.json that goes
 * back to listing every crawl base, fails here instead of on the deployed site.
 */
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { buildShareLink } from '../../../../src/core/share/shareModel';
import { MAX_URL_CHARS } from '../../../../src/core/share/urlConfig';
import { buildExampleIndex } from '../../../../scripts/example-manifest.mjs';
import type { UrlConfig } from '../../../../src/core/share/urlConfig';

/** The GitHub Pages origin from README.md / vite.config.ts `base: '/quac/'`. */
const DEPLOYED = 'https://jeyabbalas.github.io/quac/';
const FIXTURES = fileURLToPath(new URL('../../../fixtures/hesp', import.meta.url));

/** What a session holds after `Load example files` — see loadView.ts's `abs`. */
function exampleConfig(base: string): UrlConfig {
  const { index } = buildExampleIndex(FIXTURES);
  const abs = (path: string): string => new URL(`${base}examples/${path}`).toString();
  return {
    schema: index.schema.map(abs),
    rules: index.rules.map(abs),
    // The resolved root's `$id`, which is origin-independent — hashSync derives
    // `index=` from the live root, and core.schema.json declares this one.
    index: 'https://schemas.example.org/hesp/core/core.schema.json',
    data: abs(index.dataset),
    passthrough: [],
  };
}

test("the bundled example's share link fits the limit at the deployed origin", () => {
  const link = buildShareLink(DEPLOYED, exampleConfig(DEPLOYED));
  expect(link.overLimit).toBe(false);
  expect(link.length).toBeLessThanOrEqual(MAX_URL_CHARS);
});

test('the example contributes ONE schema crawl base, and the crawl finds the rest', () => {
  const { index, schemaFiles } = buildExampleIndex(FIXTURES);
  // All 14 files still ship; only the link's crawl-base count shrank.
  expect(schemaFiles).toHaveLength(14);
  expect(index.schema).toEqual(['json_schema/core/core.schema.json']);
  expect(schemaFiles).toContain(index.schema[0]);

  const link = buildShareLink(DEPLOYED, exampleConfig(DEPLOYED));
  expect(link.url.match(/schema=/g)).toHaveLength(1);
});

test('a localhost preview stays under too — the bug was NOT that the base is short', () => {
  const local = 'http://localhost:4173/quac/';
  expect(buildShareLink(local, exampleConfig(local)).overLimit).toBe(false);
});
