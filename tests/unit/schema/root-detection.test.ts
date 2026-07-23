import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRootSelection,
  arrayOfObjects,
  computeIndexFileId,
  resolveIndexParam,
} from '../../../src/core/schema/root-detection';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import type { IntakeEntry } from '../../../src/core/schema/types';
import { entriesFromDir, entry, fixtureDir } from './helpers';

const hespEntries = () => entriesFromDir(fixtureDir('hesp', 'json_schema'));

/** HESP + a copy of core with `$id` set to the manifest's standalone entrypoint (§G.7). */
function hespDualRootEntries(): IntakeEntry[] {
  const coreRaw = readFileSync(
    join(fixtureDir('hesp', 'json_schema'), 'core', 'core.schema.json'),
    'utf8',
  );
  const bundleRaw = coreRaw.replace(
    '"$id": "https://schemas.example.org/hesp/core/core.schema.json"',
    '"$id": "https://schemas.example.org/hesp/core/hesp.core.bundle.schema.json"',
  );
  expect(bundleRaw).not.toBe(coreRaw);
  return [...hespEntries(), { relativePath: 'core/hesp.core.bundle.schema.json', raw: bundleRaw }];
}

describe('arrayOfObjects', () => {
  it('matches array-with-object-items shapes and rejects the rest (§A.3.3)', () => {
    expect(arrayOfObjects({ type: 'array', items: { type: 'object' } })).toBe(true);
    expect(arrayOfObjects({ items: { $ref: 'row.json' } })).toBe(true);
    expect(arrayOfObjects({ type: 'array', items: [{ type: 'object' }] })).toBe(false);
    expect(arrayOfObjects({ type: 'array', items: true })).toBe(false);
    expect(arrayOfObjects({ type: 'array' })).toBe(false);
    expect(arrayOfObjects({ type: 'object', properties: {} })).toBe(false);
    expect(arrayOfObjects(true)).toBe(false);
  });
});

describe('root detection — decisions', () => {
  it('auto-selects a single-file set (mini) with indexFileId = declaredId', async () => {
    const set = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'mini')), {
      origin: 'upload',
    });
    expect(set.root.status).toBe('auto');
    expect(set.root.rootFileId).toBe('mini.schema.json');
    const root = set.files.find((f) => f.fileId === 'mini.schema.json');
    expect(root?.declaredId).toBeDefined();
    expect(set.root.indexFileId).toBe(root?.declaredId);
    expect(set.errors.filter((e) => e.severity === 'fatal')).toEqual([]);
  });

  it('auto-selects core/core.schema.json for the full HESP directory', async () => {
    const set = await buildSchemaSet(hespEntries(), { origin: 'upload' });
    expect(set.root.status).toBe('auto');
    expect(set.root.rootFileId).toBe('core/core.schema.json');
    expect(set.root.indexFileId).toBe('https://schemas.example.org/hesp/core/core.schema.json');
    expect(set.schemas).toHaveLength(14);
    expect(set.ignored).toEqual(
      expect.arrayContaining([
        { fileId: 'README.md', reason: 'unsupported-extension' },
        { fileId: 'manifest.json', reason: 'non-schema' },
      ]),
    );
    expect(set.errors.filter((e) => e.severity === 'fatal')).toEqual([]);
    expect(set.errors.map((e) => e.code)).toEqual(['I_NON_SCHEMA_IGNORED']);
  });

  it('reports the HESP dual-root set ambiguous with manifest-hint ordering', async () => {
    const set = await buildSchemaSet(hespDualRootEntries(), { origin: 'upload' });
    expect(set.root.status).toBe('ambiguous');
    expect(set.root.rootFileId).toBeUndefined();
    expect(set.manifestHints).toEqual([
      'core/core.schema.json',
      'core/hesp.core.bundle.schema.json',
    ]);
    expect(set.root.candidates.map((c) => c.fileId)).toEqual([
      'core/core.schema.json',
      'core/hesp.core.bundle.schema.json',
    ]);
    expect(set.root.candidates.every((c) => c.arrayOfObjects && c.inDegree === 0)).toBe(true);
  });

  it('reports cycle/ as none with every schema as a candidate', async () => {
    const set = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'cycle')), {
      origin: 'upload',
    });
    expect(set.root.status).toBe('none');
    expect(set.root.rootFileId).toBeUndefined();
    expect(set.root.candidates.map((c) => c.fileId).sort()).toEqual(['x.json', 'y.json']);
  });

  it('reports two-roots/ ambiguous, array-shaped before path order', async () => {
    const set = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'two-roots')), {
      origin: 'upload',
    });
    expect(set.root.status).toBe('ambiguous');
    expect(set.root.candidates.map((c) => c.fileId)).toEqual(['a.schema.json', 'b.schema.json']);
  });

  it('auto-prefers the single array-shaped candidate with a dismissible notice', async () => {
    const set = await buildSchemaSet(
      [
        ...entriesFromDir(fixtureDir('synthetic', 'two-roots')).filter(
          (e) => e.relativePath !== 'b.schema.json',
        ),
        entry('config.json', { type: 'object', properties: { x: { type: 'string' } } }),
      ],
      { origin: 'upload' },
    );
    expect(set.root.status).toBe('auto-preferred');
    expect(set.root.rootFileId).toBe('a.schema.json');
    const notice = set.errors.find((e) => e.code === 'I_AUTO_PREFERRED');
    expect(notice?.severity).toBe('info');
    expect(notice?.message).toBe(
      'Using `a.schema.json` as the index; `config.json` is also unreferenced.',
    );
  });

  it('auto-selects the draft-07 fixture', async () => {
    const set = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'draft7')), {
      origin: 'upload',
    });
    expect(set.root.status).toBe('auto');
    expect(set.root.rootFileId).toBe('root.schema.json');
  });

  it('reports E_NO_SCHEMAS when nothing classifies as a schema', async () => {
    const set = await buildSchemaSet([entry('data.json', { name: 'plain', rows: [1, 2] })], {
      origin: 'upload',
    });
    expect(set.root.status).toBe('error');
    expect(set.errors.map((e) => e.code)).toContain('E_NO_SCHEMAS');
  });
});

describe('root detection — post-selection checks', () => {
  it('warns on a non-array sole candidate but keeps it selected', async () => {
    const set = await buildSchemaSet(
      [entry('odd.json', { type: 'object', properties: {}, items: { type: 'object' } })],
      { origin: 'upload' },
    );
    expect(set.root.status).toBe('auto');
    expect(set.root.rootFileId).toBe('odd.json');
    expect(set.errors.map((e) => e.code)).toContain('W_ROOT_NOT_ARRAY');
    expect(set.errors.filter((e) => e.severity === 'fatal')).toEqual([]);
  });

  it('reports E_ROOT_NOT_TABULAR when the root lacks items entirely', async () => {
    const set = await buildSchemaSet([entry('flat.json', { type: 'array' })], {
      origin: 'upload',
    });
    const fatal = set.errors.find((e) => e.code === 'E_ROOT_NOT_TABULAR');
    expect(fatal?.message).toBe(
      'The index schema `flat.json` does not describe a table (expected `type: "array"` with `items`).',
    );
  });

  it('applyRootSelection replaces prior post-selection findings instead of stacking them', async () => {
    const set = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'two-roots')), {
      origin: 'upload',
    });
    const once = applyRootSelection(set, 'a.schema.json');
    const twice = applyRootSelection(once, 'b.schema.json');
    expect(twice.root.rootFileId).toBe('b.schema.json');
    expect(twice.errors.filter((e) => e.code === 'W_ROOT_NOT_ARRAY')).toEqual([]);
    expect(twice.errors).toHaveLength(set.errors.length);
  });
});

describe('index= resolution (§A.4)', () => {
  it('matches by declaredId, then relativePath', async () => {
    const set = await buildSchemaSet(hespEntries(), { origin: 'upload' });
    expect(resolveIndexParam(set, 'https://schemas.example.org/hesp/common/defs.json')).toEqual({
      fileId: 'common/defs.json',
      matchedBy: 'declaredId',
    });
    expect(resolveIndexParam(set, 'core/categories/income.json')).toMatchObject({
      fileId: 'core/categories/income.json',
      matchedBy: 'relativePath',
    });
  });

  it('matches a unique basename with a warning', async () => {
    const set = await buildSchemaSet(hespEntries(), { origin: 'upload' });
    const match = resolveIndexParam(set, 'core.schema.json');
    expect(match.fileId).toBe('core/core.schema.json');
    expect(match).toMatchObject({ matchedBy: 'basename' });
    expect(match.warning?.code).toBe('W_INDEX_BASENAME');
  });

  it('refuses a non-unique basename with a warning (ledger 3)', async () => {
    const set = await buildSchemaSet(
      [
        entry('root.json', {
          type: 'array',
          items: { allOf: [{ $ref: 'x/defs.json' }, { $ref: 'y/defs.json' }] },
        }),
        entry('x/defs.json', { type: 'object' }),
        entry('y/defs.json', { type: 'object' }),
      ],
      { origin: 'upload' },
    );
    const match = resolveIndexParam(set, 'defs.json');
    expect(match.fileId).toBeNull();
    expect(match.warning?.code).toBe('W_INDEX_NO_MATCH');
    expect(match.warning?.message).toBe(
      "The shared index reference didn't match any loaded file.",
    );
  });

  it('a matched index= suppresses the modal even for an ambiguous set', async () => {
    const set = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'two-roots')), {
      origin: 'upload',
      indexParam: 'b.schema.json',
    });
    expect(set.root.status).toBe('ambiguous');
    expect(set.root.rootFileId).toBe('b.schema.json');
    expect(set.root.indexFileId).toBe(
      'https://example.org/quac/synthetic/two-roots/b.schema.json',
    );
  });

  it('an unmatched index= warns and leaves the modal to open', async () => {
    const set = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'two-roots')), {
      origin: 'upload',
      indexParam: 'nope.schema.json',
    });
    expect(set.root.status).toBe('ambiguous');
    expect(set.root.rootFileId).toBeUndefined();
    expect(set.errors.map((e) => e.code)).toContain('W_INDEX_NO_MATCH');
  });

  it('computeIndexFileId falls back declaredId → URL → relativePath', () => {
    const withId = { declaredId: 'https://x.org/a.json', fileId: 'a.json', relativePath: 'a.json' };
    const urlNoId = { fileId: 'https://x.org/b.json', relativePath: 'b.json' };
    const uploadNoId = { fileId: 'c.json', relativePath: 'c.json' };
    expect(computeIndexFileId(withId as never, 'upload')).toBe('https://x.org/a.json');
    expect(computeIndexFileId(urlNoId as never, 'url')).toBe('https://x.org/b.json');
    expect(computeIndexFileId(uploadNoId as never, 'upload')).toBe('c.json');
  });
});
