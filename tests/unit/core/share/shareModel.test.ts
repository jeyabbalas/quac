import { expect, test } from 'vitest';
import { buildShareModel } from '../../../../src/core/share/shareModel';
import { assembleFragment } from '../../../../src/core/share/urlConfig';

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
