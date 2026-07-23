import { describe, expect, it } from 'vitest';
import { checkFragment, resolveRefGraph, scanRefs } from '../../../src/core/schema/ref-graph';
import { intakeEntry, intakeFiles } from '../../../src/core/schema/schema-set';
import type { IntakeResult } from '../../../src/core/schema/schema-set';
import type { FetchJson, IntakeEntry } from '../../../src/core/schema/types';
import { entriesFromDir, entry, fixtureDir } from './helpers';

async function graphFor(
  entries: IntakeEntry[],
  origin: 'upload' | 'url' = 'upload',
  fetchJson?: FetchJson,
  caps?: { maxFiles?: number; maxDepth?: number },
) {
  const intake = intakeFiles(entries, origin);
  const result = await resolveRefGraph({
    intake,
    origin,
    ...(fetchJson ? { fetchJson, intakeFetched: (e: IntakeEntry) => intakeEntry(e, 'url', intake) } : {}),
    ...(caps ? { caps } : {}),
  });
  return { intake, ...result };
}

function refsOf(intake: IntakeResult, fileId: string) {
  return intake.files.find((f) => f.fileId === fileId)?.refs ?? [];
}

describe('scanRefs', () => {
  it('records $ref and $dynamicRef with pointers, walks $ref siblings', () => {
    const refs = scanRefs(
      {
        $ref: 'other.json',
        title: 'sibling walked',
        items: { $dynamicRef: '#meta' },
        $defs: { a: { $ref: '#/$defs/b' }, b: { type: 'string' } },
      },
      'quac-set:/root.json',
    );
    expect(refs.map((r) => r.fromPointer)).toEqual([
      '/$ref',
      '/items/$dynamicRef',
      '/$defs/a/$ref',
    ]);
  });

  it('ignores $ref-shaped data inside const/enum/default/examples', () => {
    const refs = scanRefs(
      {
        const: { $ref: 'data.json' },
        enum: [{ $ref: 'data.json' }],
        default: { $ref: 'data.json' },
        examples: [{ $ref: 'data.json' }],
        properties: { $ref: { type: 'string' } },
      },
      'quac-set:/root.json',
    );
    expect(refs).toEqual([]);
  });

  it('applies the nearest-ancestor $id chain as base', () => {
    const refs = scanRefs(
      {
        $defs: {
          inner: { $id: 'https://example.org/nested/inner.json', $ref: 'sibling.json' },
        },
        $ref: 'top.json',
      },
      'quac-set:/root.json',
    );
    expect(refs.find((r) => r.fromPointer === '/$defs/inner/$ref')?.base).toBe(
      'https://example.org/nested/inner.json',
    );
    expect(refs.find((r) => r.fromPointer === '/$ref')?.base).toBe('quac-set:/root.json');
  });
});

describe('checkFragment', () => {
  const target = { $defs: { 'a/b': { ok: 1 }, 'ti~lde': { ok: 2 } }, list: [{ x: 1 }] };

  it('dereferences pointers with ~0/~1 unescaping and array indices', () => {
    expect(checkFragment(target, '/$defs/a~1b', 'pointer')).toBe(true);
    expect(checkFragment(target, '/$defs/ti~0lde', 'pointer')).toBe(true);
    expect(checkFragment(target, '/list/0/x', 'pointer')).toBe(true);
    expect(checkFragment(target, '/list/1', 'pointer')).toBe(false);
    expect(checkFragment(target, '/$defs/nope', 'pointer')).toBe(false);
  });

  it('finds $anchor and $dynamicAnchor declarations', () => {
    const anchored = { $defs: { a: { $anchor: 'here' }, b: { $dynamicAnchor: 'meta' } } };
    expect(checkFragment(anchored, 'here', 'anchor')).toBe(true);
    expect(checkFragment(anchored, 'meta', 'anchor')).toBe(true);
    expect(checkFragment(anchored, 'gone', 'anchor')).toBe(false);
  });
});

describe('resolveRefGraph — HESP', () => {
  it('resolves all 3 HESP ref styles with zero errors', async () => {
    const { intake, errors, schemaIds } = await graphFor(
      entriesFromDir(fixtureDir('hesp', 'json_schema')),
    );
    expect(errors).toEqual([]);
    expect(schemaIds.size).toBe(14);

    const rootRefs = refsOf(intake, 'core/core.schema.json');
    const categoryEdges = rootRefs.filter((r) => r.refValue.startsWith('categories/'));
    expect(new Set(categoryEdges.map((r) => r.targetFileId)).size).toBe(12);
    expect(categoryEdges.every((r) => r.fragment === null)).toBe(true);

    const incomeRefs = refsOf(intake, 'core/categories/income.json');
    const defsEdges = incomeRefs.filter((r) => r.refValue.startsWith('../../common/defs.json#'));
    expect(defsEdges.length).toBeGreaterThan(0);
    expect(defsEdges.every((r) => r.targetFileId === 'common/defs.json')).toBe(true);
    expect(defsEdges.every((r) => r.fragmentKind === 'pointer')).toBe(true);

    const defsInternal = refsOf(intake, 'common/defs.json');
    expect(defsInternal.every((r) => r.targetFileId === 'common/defs.json')).toBe(true);
  });

  it('resolves the flat 14-file selection through the $id index', async () => {
    const flat = entriesFromDir(fixtureDir('hesp', 'json_schema'))
      .filter((e) => e.relativePath.endsWith('.json') && e.relativePath !== 'manifest.json')
      .map((e) => ({ ...e, relativePath: e.relativePath.split('/').pop() ?? e.relativePath }));
    expect(flat).toHaveLength(14);
    const { errors, schemaIds, intake } = await graphFor(flat);
    expect(errors).toEqual([]);
    expect(schemaIds.size).toBe(14);
    const rootRefs = refsOf(intake, 'core.schema.json');
    expect(
      rootRefs.filter((r) => r.refValue.startsWith('categories/')).every((r) => r.targetFileId !== null),
    ).toBe(true);
  });

  it('lists both tried URIs when a target file is missing', async () => {
    const withoutDefs = entriesFromDir(fixtureDir('hesp', 'json_schema')).filter(
      (e) => !e.relativePath.endsWith('common/defs.json'),
    );
    const { errors } = await graphFor(withoutDefs);
    const unresolved = errors.filter((e) => e.code === 'E_UNRESOLVED_REF');
    expect(unresolved.length).toBeGreaterThan(0);
    const first = unresolved[0];
    expect(first?.message).toContain('Upload the folder containing `defs.json`');
    expect(first?.meta?.triedUris).toEqual([
      'https://schemas.example.org/hesp/common/defs.json',
      'quac-set:/common/defs.json',
    ]);
  });
});

describe('resolveRefGraph — synthetic sets', () => {
  it('resolves no-ids/ purely through quac-set: synthetic URIs', async () => {
    const { intake, errors } = await graphFor(entriesFromDir(fixtureDir('synthetic', 'no-ids')));
    expect(errors).toEqual([]);
    const rootRefs = refsOf(intake, 'root.json');
    expect(rootRefs[0]?.resolvedUri).toBe('quac-set:/sub/defs.json');
    expect(rootRefs[0]?.targetFileId).toBe('sub/defs.json');
  });

  it('classifies mixed/ manifest as non-schema and keeps it out of the graph', async () => {
    const { intake, errors, schemaIds } = await graphFor(
      entriesFromDir(fixtureDir('synthetic', 'mixed')),
    );
    expect(errors).toEqual([]);
    expect(schemaIds).toEqual(new Set(['mini.schema.json']));
    expect(intake.files.find((f) => f.fileId === 'manifest.json')?.refs).toEqual([]);
  });

  it('reports E_BAD_FRAGMENT for missing pointers and anchors', async () => {
    const { errors } = await graphFor([
      entry('root.json', {
        type: 'array',
        items: { $ref: 'defs.json#/$defs/nope' },
        $defs: { anchored: { $ref: 'defs.json#missing-anchor' } },
      }),
      entry('defs.json', { $defs: { yes: { type: 'string' } } }),
    ]);
    const fragments = errors.filter((e) => e.code === 'E_BAD_FRAGMENT');
    expect(fragments).toHaveLength(2);
    expect(fragments[0]?.message).toBe(
      '`root.json` references `defs.json#/$defs/nope`, but `#/$defs/nope` does not exist in `defs.json`.',
    );
  });

  it('falls back to the retrieval base when a stale $id misses (ledger 5)', async () => {
    const { intake, errors } = await graphFor([
      entry('a.json', {
        $id: 'https://example.org/moved/a.json',
        type: 'array',
        items: { $ref: 'b.json' },
      }),
      entry('b.json', { type: 'object' }),
    ]);
    expect(refsOf(intake, 'a.json')[0]?.targetFileId).toBe('b.json');
    expect(errors.map((e) => e.code)).toEqual(['W_RETRIEVAL_FALLBACK']);
    expect(errors[0]?.severity).toBe('warning');
  });

  it('promotes ref targets that do not look like schemas', async () => {
    const { schemaIds, errors } = await graphFor([
      entry('root.json', { type: 'array', items: { $ref: 'weird.json' } }),
      entry('weird.json', { looksLike: 'plain data' }),
    ]);
    expect(errors).toEqual([]);
    expect(schemaIds).toEqual(new Set(['root.json', 'weird.json']));
  });
});

describe('resolveRefGraph — URL crawl', () => {
  const stub =
    (routes: Record<string, string | { redirect: string } | { status: number }>): FetchJson =>
    (url) => {
      const route = routes[url];
      if (route === undefined) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if (typeof route === 'object' && 'status' in route) {
        return Promise.reject(Object.assign(new Error(`HTTP ${String(route.status)}`), route));
      }
      if (typeof route === 'object' && 'redirect' in route) {
        const body = routes[route.redirect];
        return Promise.resolve({
          finalUrl: route.redirect,
          text: typeof body === 'string' ? body : '{}',
        });
      }
      return Promise.resolve({ finalUrl: url, text: route });
    };

  const rootEntry = (json: unknown): IntakeEntry => ({
    relativePath: 'https://example.com/s/root.json',
    retrievalUri: 'https://example.com/s/root.json',
    raw: JSON.stringify(json),
  });

  it('crawls relative refs against the retrieval base, never $id hosts', async () => {
    const requested: string[] = [];
    const fetchJson: FetchJson = (url) => {
      requested.push(url);
      return stub({
        'https://example.com/s/defs.json': JSON.stringify({ $defs: { a: { type: 'string' } } }),
      })(url);
    };
    const { errors, schemaIds } = await graphFor(
      [
        rootEntry({
          $id: 'https://schemas.example.org/other/root.json',
          type: 'array',
          items: { $ref: 'defs.json#/$defs/a' },
        }),
      ],
      'url',
      fetchJson,
    );
    expect(requested).toEqual(['https://example.com/s/defs.json']);
    expect(errors.filter((e) => e.code === 'E_FETCH')).toEqual([]);
    expect(schemaIds.has('https://example.com/s/defs.json')).toBe(true);
  });

  it('records the post-redirect URL as retrievalUri', async () => {
    const { intake, errors } = await graphFor(
      [rootEntry({ type: 'array', items: { $ref: 'defs.json' } })],
      'url',
      stub({
        'https://example.com/s/defs.json': { redirect: 'https://example.com/v2/defs.json' },
        'https://example.com/v2/defs.json': JSON.stringify({ type: 'object' }),
      }),
    );
    expect(errors).toEqual([]);
    const crawled = intake.files.find((f) => f.fileId === 'https://example.com/v2/defs.json');
    expect(crawled?.retrievalUri).toBe('https://example.com/v2/defs.json');
  });

  it('maps CORS-shaped failures to the §A.2.7 copy and HTTP failures to status copy', async () => {
    const { errors } = await graphFor(
      [
        rootEntry({
          type: 'array',
          items: { $ref: 'cors.json' },
          $defs: { h: { $ref: 'http404.json' } },
        }),
      ],
      'url',
      stub({ 'https://example.com/s/http404.json': { status: 404 } }),
    );
    const fetches = errors.filter((e) => e.code === 'E_FETCH');
    expect(fetches).toHaveLength(2);
    expect(fetches.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        "Couldn't fetch `https://example.com/s/cors.json`. The server may not allow cross-origin access. Download the file and upload it instead.",
        "Couldn't fetch `https://example.com/s/http404.json`: the server responded 404.",
      ]),
    );
    expect(errors.filter((e) => e.code === 'E_UNRESOLVED_REF')).toHaveLength(2);
  });

  it('stops at the depth cap and reports the leftovers unresolved', async () => {
    const routes: Record<string, string> = {};
    for (let i = 1; i <= 12; i += 1) {
      routes[`https://example.com/s/f${String(i)}.json`] = JSON.stringify(
        i < 12 ? { $ref: `f${String(i + 1)}.json` } : { type: 'object' },
      );
    }
    const { errors, intake } = await graphFor(
      [rootEntry({ type: 'array', items: { $ref: 'f1.json' } })],
      'url',
      stub(routes),
    );
    expect(intake.files.length).toBe(9); // root + depth 1..8
    expect(errors.filter((e) => e.code === 'E_UNRESOLVED_REF')).toHaveLength(1);
  });

  it('stops at the file-count cap', async () => {
    const routes: Record<string, string> = {};
    const fanout = Array.from({ length: 10 }, (_, i) => ({ $ref: `leaf${String(i)}.json` }));
    for (let i = 0; i < 10; i += 1) {
      routes[`https://example.com/s/leaf${String(i)}.json`] = JSON.stringify({ type: 'object' });
    }
    const { errors, intake } = await graphFor(
      [rootEntry({ type: 'array', items: { anyOf: fanout } })],
      'url',
      stub(routes),
      { maxFiles: 5 },
    );
    expect(intake.files.length).toBe(5);
    expect(errors.filter((e) => e.code === 'E_UNRESOLVED_REF')).toHaveLength(6);
  });

  it('never fetches quac-set: bases (upload origin)', async () => {
    const requested: string[] = [];
    const fetchJson: FetchJson = (url) => {
      requested.push(url);
      return Promise.reject(new TypeError('should not happen'));
    };
    const { errors } = await graphFor(
      [entry('root.json', { type: 'array', items: { $ref: 'missing.json' } })],
      'upload',
      fetchJson,
    );
    expect(requested).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(['E_UNRESOLVED_REF']);
  });
});
