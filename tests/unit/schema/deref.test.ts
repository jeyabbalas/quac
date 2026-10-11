/**
 * Read-side ref resolution (deref.ts): pointer fragments, and plain-name
 * fragments that find an `$anchor` / `$dynamicAnchor`.
 */
import { describe, expect, it } from 'vitest';
import { createRefResolver, findAnchor } from '../../../src/core/schema/deref';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { entry } from './helpers';

describe('findAnchor', () => {
  it('finds the first $anchor or $dynamicAnchor in document order, never inside data', () => {
    const json = {
      enum: [{ $anchor: 'row' }],
      $defs: { a: { $anchor: 'row' }, b: { items: [{ $dynamicAnchor: 'node' }] } },
    };
    expect(findAnchor(json, 'row')).toBe('/$defs/a');
    expect(findAnchor(json, 'node')).toBe('/$defs/b/items/0');
    expect(findAnchor(json, 'gone')).toBeNull();
  });
});

describe('createRefResolver', () => {
  it('follows pointer and anchor refs, across files', async () => {
    const set = await buildSchemaSet(
      [
        entry('root.json', {
          type: 'array',
          items: { allOf: [{ $ref: '#/$defs/local' }, { $ref: 'defs.json#row' }] },
          $defs: { local: { title: 'local' } },
        }),
        entry('defs.json', { $defs: { row: { $anchor: 'row', title: 'anchored' } } }),
      ],
      { origin: 'upload' },
    );
    const resolver = createRefResolver(set);
    const root = resolver.fileById('root.json');
    if (root === undefined) throw new Error('no root');
    expect(resolver.resolve(root, '/items/allOf/0/$ref')).toMatchObject({
      pointer: '/$defs/local',
      node: { title: 'local' },
    });
    expect(resolver.resolve(root, '/items/allOf/1/$ref')).toMatchObject({
      file: { fileId: 'defs.json' },
      pointer: '/$defs/row',
      node: { title: 'anchored' },
    });
    expect(resolver.resolve(root, '/items/nothing/$ref')).toBeNull();
  });
});
