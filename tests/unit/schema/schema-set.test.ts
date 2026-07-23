import { describe, expect, it } from 'vitest';
import {
  classifyJson,
  computeSetId,
  extractManifestHints,
  intakeFiles,
  quacSetUri,
  stripBom,
  stripCommonRoot,
} from '../../../src/core/schema/schema-set';
import { entriesFromDir, entry, fixtureDir } from './helpers';

describe('stripBom', () => {
  it('removes a UTF-8 BOM and leaves clean text alone', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('')).toBe('');
  });

  it('lets a BOM-prefixed file parse (edge ledger 1)', () => {
    const result = intakeFiles([entry('bom.json', '﻿{"type":"array"}')], 'upload');
    expect(result.errors).toEqual([]);
    expect(result.files[0]?.classification).toBe('schema');
  });
});

describe('classifyJson', () => {
  it('accepts any object with one schema marker key', () => {
    expect(classifyJson({ $schema: 'x' })).toBe('schema');
    expect(classifyJson({ type: 'array' })).toBe('schema');
    expect(classifyJson({ properties: {} })).toBe('schema');
    expect(classifyJson({ $ref: '#/x' })).toBe('schema');
    expect(classifyJson({ definitions: {} })).toBe('schema');
  });

  it('rejects manifests, arrays, primitives, and bare booleans', () => {
    expect(classifyJson({ name: 'x', entrypoints: {} })).toBe('non-schema');
    expect(classifyJson([1, 2])).toBe('non-schema');
    expect(classifyJson('type')).toBe('non-schema');
    expect(classifyJson(null)).toBe('non-schema');
    expect(classifyJson(true)).toBe('non-schema');
    expect(classifyJson(false)).toBe('non-schema');
  });
});

describe('stripCommonRoot', () => {
  it('strips exactly one shared leading directory', () => {
    expect(stripCommonRoot(['json_schema/core/a.json', 'json_schema/manifest.json'])).toEqual([
      'core/a.json',
      'manifest.json',
    ]);
  });

  it('leaves flat and divergent paths unchanged', () => {
    expect(stripCommonRoot(['a.json', 'b.json'])).toEqual(['a.json', 'b.json']);
    expect(stripCommonRoot(['x/a.json', 'y/b.json'])).toEqual(['x/a.json', 'y/b.json']);
    expect(stripCommonRoot(['x/a.json', 'b.json'])).toEqual(['x/a.json', 'b.json']);
    expect(stripCommonRoot([])).toEqual([]);
  });
});

describe('computeSetId', () => {
  const a = entry('a.json', '{"type":"array"}');
  const b = entry('b.json', '{"type":"object"}');

  it('is 16 hex chars and stable across entry order', async () => {
    const forward = await computeSetId([a, b]);
    const reversed = await computeSetId([b, a]);
    expect(forward).toMatch(/^[0-9a-f]{16}$/);
    expect(reversed).toBe(forward);
  });

  it('changes when content or paths change', async () => {
    const base = await computeSetId([a, b]);
    expect(await computeSetId([a, entry('b.json', '{"type":"string"}')])).not.toBe(base);
    expect(await computeSetId([a, entry('c.json', b.raw)])).not.toBe(base);
  });
});

describe('intakeFiles', () => {
  it('accepts .JSON case-insensitively and ignores other extensions silently (ledger 1–2)', () => {
    const result = intakeFiles(
      [
        entry('A.JSON', '{"type":"array"}'),
        entry('README.md', '# docs'),
        entry('.DS_Store', 'binary-ish'),
      ],
      'upload',
    );
    expect(result.files.map((f) => f.fileId)).toEqual(['A.JSON']);
    expect(result.ignored).toEqual([
      { fileId: '.DS_Store', reason: 'unsupported-extension' },
      { fileId: 'README.md', reason: 'unsupported-extension' },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('reports E_PARSE with the exact spec copy and keeps the file as invalid-json', () => {
    const result = intakeFiles([entry('broken.json', '{ nope')], 'upload');
    expect(result.files[0]?.classification).toBe('invalid-json');
    const error = result.errors[0];
    expect(error?.code).toBe('E_PARSE');
    expect(error?.severity).toBe('fatal');
    expect(error?.message).toMatch(/^`broken\.json` is not valid JSON: .+\.$/);
    expect(error?.message).not.toMatch(/at position \d+.*at position/);
  });

  it('renders "(near position n)" when the engine reports one', () => {
    let engineMessage = '';
    try {
      JSON.parse('{"a":}');
    } catch (err) {
      engineMessage = (err as Error).message;
    }
    const result = intakeFiles([entry('p.json', '{"a":}')], 'upload');
    if (/at position \d+/.test(engineMessage)) {
      expect(result.errors[0]?.message).toMatch(/\(near position \d+\)\.$/);
    } else {
      expect(result.errors[0]?.message).toMatch(/\.$/);
    }
  });

  it('extracts declaredId resolved against retrievalUri, fragment stripped', () => {
    const result = intakeFiles(
      [
        entry('abs.json', { $id: 'https://example.org/s/abs.json#frag', type: 'array' }),
        entry('rel.json', { $id: 'sub/rel-id.json', type: 'object' }),
        entry('none.json', { type: 'object' }),
      ],
      'upload',
    );
    const byId = new Map(result.files.map((f) => [f.fileId, f]));
    expect(byId.get('abs.json')?.declaredId).toBe('https://example.org/s/abs.json');
    expect(byId.get('rel.json')?.declaredId).toBe('quac-set:/sub/rel-id.json');
    expect(byId.get('none.json')?.declaredId).toBeUndefined();
    expect(result.idIndex.get('https://example.org/s/abs.json')).toBe('abs.json');
    expect(result.pathIndex.get('quac-set:/abs.json')).toBe('abs.json');
  });

  it('extracts drafts and treats missing/unrecognized $schema as unknown', () => {
    const result = intakeFiles(
      [
        entry('a.json', { $schema: 'https://json-schema.org/draft/2020-12/schema' }),
        entry('b.json', { $schema: 'https://json-schema.org/draft/2019-09/schema' }),
        entry('c.json', { $schema: 'http://json-schema.org/draft-07/schema#' }),
        entry('d.json', { type: 'object' }),
        entry('e.json', { $schema: 'http://example.org/custom' }),
      ],
      'upload',
    );
    expect(result.files.map((f) => f.draft)).toEqual([
      '2020-12',
      '2019-09',
      'draft-07',
      'unknown',
      'unknown',
    ]);
  });

  it('reports E_DUP_ID naming both files; first declarer keeps the index (ledger 4)', () => {
    const result = intakeFiles(
      [
        entry('a.json', { $id: 'https://example.org/same.json', type: 'array' }),
        entry('b.json', { $id: 'https://example.org/same.json', type: 'object' }),
      ],
      'upload',
    );
    const error = result.errors.find((e) => e.code === 'E_DUP_ID');
    expect(error?.message).toBe(
      'Two files declare the same `$id` `https://example.org/same.json`: `a.json` and `b.json`. Each schema file needs a unique `$id`.',
    );
    expect(result.idIndex.get('https://example.org/same.json')).toBe('a.json');
    expect(result.files.every((f) => f.declaredId === 'https://example.org/same.json')).toBe(true);
  });

  it('strips the common folder root and classifies the full HESP directory', () => {
    const result = intakeFiles(entriesFromDir(fixtureDir('hesp', 'json_schema')), 'upload');
    const schemas = result.files.filter((f) => f.classification === 'schema');
    expect(schemas).toHaveLength(14);
    expect(result.files.find((f) => f.fileId === 'manifest.json')?.classification).toBe(
      'non-schema',
    );
    expect(result.ignored).toEqual([{ fileId: 'README.md', reason: 'unsupported-extension' }]);
    expect(result.idIndex.get('https://schemas.example.org/hesp/core/core.schema.json')).toBe(
      'core/core.schema.json',
    );
    expect(result.errors).toEqual([]);
  });
});

describe('quacSetUri', () => {
  it('URL-normalizes and escapes URL-hostile characters', () => {
    expect(quacSetUri('core/a.json')).toBe('quac-set:/core/a.json');
    expect(quacSetUri('my dir/a#1.json')).toBe(new URL(quacSetUri('my dir/a#1.json')).href);
    expect(quacSetUri('a#1.json')).not.toContain('#1');
  });

  it('resolves relative refs against a quac-set base like a real URL', () => {
    const resolved = new URL('../../common/defs.json', 'quac-set:/core/categories/income.json');
    expect(resolved.href).toBe('quac-set:/common/defs.json');
  });
});

describe('extractManifestHints', () => {
  it('captures hints in entrypoint order and tolerates dangling entries (mixed/)', () => {
    const result = intakeFiles(entriesFromDir(fixtureDir('synthetic', 'mixed')), 'upload');
    expect(result.files.find((f) => f.fileId === 'manifest.json')?.classification).toBe(
      'non-schema',
    );
    expect(extractManifestHints(result.files)).toEqual(['mini.schema.json']);
  });

  it('orders HESP hints modular-first and skips the absent standalone bundle', () => {
    const result = intakeFiles(entriesFromDir(fixtureDir('hesp', 'json_schema')), 'upload');
    expect(extractManifestHints(result.files)).toEqual(['core/core.schema.json']);
  });

  it('returns nothing when zero or several manifests qualify', () => {
    expect(extractManifestHints([])).toEqual([]);
    const twoManifests = intakeFiles(
      [
        entry('m1.json', { entrypoints: { a: 'a.json' } }),
        entry('m2.json', { entrypoints: { a: 'a.json' } }),
        entry('a.json', { type: 'array' }),
      ],
      'upload',
    );
    expect(extractManifestHints(twoManifests.files)).toEqual([]);
  });
});
