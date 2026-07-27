import { expect, test } from 'vitest';
import { buildShareLink, buildShareModel } from '../../../../src/core/share/shareModel';
import { MAX_URL_CHARS, assembleFragment } from '../../../../src/core/share/urlConfig';
import type { UrlConfig } from '../../../../src/core/share/urlConfig';

test('empty input produces an empty, non-shareable model', () => {
  const model = buildShareModel({ dataset: null, schema: null, rules: [] });
  expect(model.empty).toBe(true);
  expect(model.hasShareable).toBe(false);
  expect(assembleFragment(model.config)).toBe('#/load');
});

test('URL-loaded schema + rules assemble a link with index=, in order', () => {
  const model = buildShareModel({
    dataset: null,
    schema: {
      origin: 'url',
      sourceUrls: ['https://h/core.schema.json'],
      indexFileId: 'https://schemas.example.org/hesp/core/core.schema.json',
    },
    rules: [
      { name: 'a.quac.csv', sourceUrl: 'https://h/a.quac.csv' },
      { name: 'b.quac.csv', sourceUrl: 'https://h/b.quac.csv' },
    ],
  });
  expect(model.hasShareable).toBe(true);
  expect(model.config.schema).toEqual(['https://h/core.schema.json']);
  expect(model.config.rules).toEqual(['https://h/a.quac.csv', 'https://h/b.quac.csv']);
  expect(model.index).toBe('https://schemas.example.org/hesp/core/core.schema.json');
  const frag = assembleFragment(model.config);
  expect(frag).toContain('index=');
  // Rules order preserved (correction order contract).
  expect(frag.indexOf('a.quac.csv')).toBeLessThan(frag.indexOf('b.quac.csv'));
});

test('uploaded artifacts are listed excluded and never enter the link', () => {
  const model = buildShareModel({
    dataset: { name: 'hesp.csv' }, // no sourceUrl → uploaded
    schema: { origin: 'upload', sourceUrls: [], rootLabel: 'core/core.schema.json' },
    rules: [{ name: 'local.quac.csv', sourceUrl: null }],
  });
  expect(model.hasShareable).toBe(false);
  expect(model.artifacts.every((a) => !a.shareable)).toBe(true);
  expect(model.artifacts.map((a) => a.slot)).toEqual(['data', 'schema', 'rules']);
  expect(model.config.schema).toEqual([]);
  expect(model.config.rules).toEqual([]);
  expect(model.config.data).toBeUndefined();
  expect(model.index).toBeUndefined();
  // The uploaded schema still shows its root label.
  expect(model.artifacts[1]?.label).toBe('core/core.schema.json');
});

test('mixed provenance: URL rules included, uploaded rules excluded', () => {
  const model = buildShareModel({
    dataset: { name: 'd.csv', sourceUrl: 'https://h/d.csv' },
    schema: null,
    rules: [
      { name: 'hosted.quac.csv', sourceUrl: 'https://h/hosted.quac.csv' },
      { name: 'local.quac.csv', sourceUrl: null },
    ],
  });
  expect(model.config.data).toBe('https://h/d.csv');
  expect(model.config.rules).toEqual(['https://h/hosted.quac.csv']);
  const rulesArtifacts = model.artifacts.filter((a) => a.slot === 'rules');
  expect(rulesArtifacts.map((a) => a.shareable)).toEqual([true, false]);
});

// UX-07: the modal renders link + Copy unconditionally and only ADDS the
// manifest offer past the limit, so the threshold itself is what needs pinning.
const BASE = 'https://jeyabbalas.github.io/quac/';

/** A config whose assembled link measures exactly `target` characters. */
function configOfLength(target: number): UrlConfig {
  // Measure the empty-`data=` link rather than the empty config: the latter has
  // no `?` separator, which would put the padding off by one.
  const overhead = buildShareLink(BASE, { schema: [], rules: [], passthrough: [], data: '' }).length;
  return { schema: [], rules: [], passthrough: [], data: 'd'.repeat(target - overhead) };
}

test('buildShareLink measures the assembled link and flags only what is OVER the limit', () => {
  const under = buildShareLink(BASE, configOfLength(MAX_URL_CHARS - 1));
  expect(under.length).toBe(MAX_URL_CHARS - 1);
  expect(under.overLimit).toBe(false);

  // The boundary is `>`, not `>=` — a link measuring exactly the limit is within it.
  const exact = buildShareLink(BASE, configOfLength(MAX_URL_CHARS));
  expect(exact.length).toBe(MAX_URL_CHARS);
  expect(exact.overLimit).toBe(false);

  const over = buildShareLink(BASE, configOfLength(MAX_URL_CHARS + 1));
  expect(over.length).toBe(MAX_URL_CHARS + 1);
  expect(over.overLimit).toBe(true);
});

test('buildShareLink returns the same string the fragment grammar assembles', () => {
  const model = buildShareModel({
    dataset: { name: 'd.csv', sourceUrl: 'https://h/d.csv' },
    schema: null,
    rules: [],
  });
  const link = buildShareLink(BASE, model.config);
  expect(link.url).toBe(`${BASE}${assembleFragment(model.config)}`);
  expect(link.url).toHaveLength(link.length);
});

test('multi-base schema lists one row per crawl base', () => {
  const model = buildShareModel({
    dataset: null,
    schema: {
      origin: 'url',
      sourceUrls: ['https://h/a.schema.json', 'https://h/b.schema.json'],
      indexFileId: 'https://h/a.schema.json',
    },
    rules: [],
  });
  const schemaArtifacts = model.artifacts.filter((a) => a.slot === 'schema');
  expect(schemaArtifacts).toHaveLength(2);
  expect(schemaArtifacts.map((a) => a.label)).toEqual(['a.schema.json', 'b.schema.json']);
  expect(model.config.schema).toEqual(['https://h/a.schema.json', 'https://h/b.schema.json']);
});
