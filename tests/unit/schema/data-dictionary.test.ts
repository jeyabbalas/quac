/**
 * Data-dictionary extraction over the real HESP set (UIX-4 step-0 gate) plus
 * the agreement invariant that keeps QuaC's two descriptions of a schema —
 * `columnDigest` and the dictionary — naming the same variables.
 *
 * Since json-schema-data-dictionary 0.7.0 the package renders the panel too,
 * so what is pinned here is the QuaC-side contract only: which documents go
 * in, the root and options the table is built with, the agreement invariant,
 * the guards, and the memoization. How the table reads on screen is the
 * package's to test.
 *
 * The extractor is imported STATICALLY here; the browser injects a dynamically
 * imported one (data-dictionary.ts's `SchemaToTable` port).
 */
import { readdirSync } from 'node:fs';
import { schemaDocumentsToTable } from 'json-schema-data-dictionary';
import type { DataDictionaryTable } from 'json-schema-data-dictionary';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DICTIONARY_OPTIONS,
  buildDictionaryTable,
  dictionaryTable,
  rootUriOf,
  toSchemaDocuments,
} from '../../../src/core/schema/data-dictionary';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { applyRootSelection } from '../../../src/core/schema/root-detection';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import type { SchemaSet } from '../../../src/core/schema/types';
import { entriesFromDir, entry, fixtureDir } from './helpers';

const HESP_ROOT_ID = 'core/core.schema.json';

let hesp: SchemaSet;
let table: DataDictionaryTable;

/** A table QuaC's options build, for a set that must have one. */
function tableOf(set: SchemaSet): DataDictionaryTable {
  const built = buildDictionaryTable(set, schemaDocumentsToTable);
  if (built === null) throw new Error('expected a dictionary table');
  return built;
}

const namesOf = (t: DataDictionaryTable): string[] => t.rows.map((r) => r['Variable name']);

beforeAll(async () => {
  hesp = await buildSchemaSet(entriesFromDir(fixtureDir('hesp', 'json_schema')), {
    origin: 'upload',
  });
  expect(hesp.root.rootFileId).toBe(HESP_ROOT_ID);
  table = tableOf(hesp);
});

describe('toSchemaDocuments / rootUriOf', () => {
  it('maps set.schemas to {uri, name} in set order — never set.files', () => {
    const docs = toSchemaDocuments(hesp);
    expect(docs).toHaveLength(hesp.schemas.length);
    // manifest.json is classified non-schema and must not reach the extractor.
    expect(docs.map((d) => d.name)).not.toContain('manifest.json');
    expect(hesp.files.map((f) => f.relativePath)).toContain('manifest.json');
    docs.forEach((doc, i) => {
      const file = hesp.schemas[i];
      expect(doc.uri).toBe(file?.retrievalUri);
      expect(doc.name).toBe(file?.relativePath);
      expect(doc.schema).toBe(file?.json);
    });
  });

  it('rootUriOf returns the root file retrievalUri, undefined when unresolved', () => {
    const root = hesp.schemas.find((f) => f.fileId === HESP_ROOT_ID);
    expect(rootUriOf(hesp)).toBe(root?.retrievalUri);
    expect(rootUriOf(hesp)).toBe(`quac-set:/${HESP_ROOT_ID}`);
    const unresolved: SchemaSet = { ...hesp, root: { ...hesp.root, rootFileId: undefined } };
    expect(rootUriOf(unresolved)).toBeUndefined();
  });
});

describe('buildDictionaryTable over HESP', () => {
  it('extracts 265 rows in 12 categories with no warnings', () => {
    expect(table.rows).toHaveLength(265);
    expect(table.categories).toHaveLength(12);
    expect(table.warnings).toEqual([]);
  });

  it('keeps categories in items.allOf order with the measured per-category counts', () => {
    expect(table.categories.map((c) => c.title)).toEqual([
      'HESP CORE - Identification and survey administration',
      'HESP CORE - Household composition',
      'HESP CORE - Housing and housing costs',
      'HESP CORE - Employment',
      'HESP CORE - Household income',
      'HESP CORE - Social program participation',
      'HESP CORE - Household assets',
      'HESP CORE - Debts and credit access',
      'HESP CORE - Financial services',
      'HESP CORE - Economic shocks and hardship',
      'HESP CORE - Panel status and follow-up',
      'HESP CORE - Derived financial measures',
    ]);
    expect(table.categories.map((c) => c.rows.length)).toEqual([
      16, 28, 24, 32, 26, 24, 24, 26, 17, 23, 10, 15,
    ]);
  });

  it('carries the 171 skip patterns the panel lets you follow', () => {
    // The component's Skip logic panel and its "Skips N" chips are built from
    // these; HESP's count is the one the schema-subsystem goldens pin (P07).
    expect(table.conditionalRules).toHaveLength(171);
  });
});

describe('the agreement invariant with columnDigest', () => {
  /**
   * Sets whose ROOT SHAPE §E.1 does not model, so the two are expected to
   * disagree. §E.1 (json-schema-subsystem.md:403) walks `items.allOf` category
   * refs and properties declared directly on `items`; `no-ids` puts the row
   * object behind a `$ref` ON `items` itself, which `buildColumnMeta` does not
   * follow — so the digest sees 0 variables there while the package sees 2.
   * That is a pre-existing §E.1 scope limit, not a dictionary bug: widening it
   * would newly subject those columns to casting, translation and Ajv
   * attribution, which is a validation-path change, not a UI one.
   *
   * If §E.1 ever grows to follow `items.$ref`, this list is what tells you to
   * delete the entry rather than silently keeping a skip.
   */
  const KNOWN_DIVERGENT = new Map<string, { digest: number; dictionary: number }>([
    ['no-ids', { digest: 0, dictionary: 2 }],
  ]);

  const agree = (set: SchemaSet, label: string): void => {
    const digest = columnDigest(set);
    if (digest === null) return; // digest blocks on fatals; the dictionary does not
    const dict = tableOf(set);
    expect(dict.rows.length, `${label}: row count`).toBe(digest.meta.length);
    expect(new Set(namesOf(dict)), `${label}: variable names`).toEqual(
      new Set(digest.meta.map((m) => m.name)),
    );
  };

  it('HESP: same count and the same variable names', () => {
    agree(hesp, 'hesp');
  });

  it('the tiny people set agrees', async () => {
    const entries = entriesFromDir(fixtureDir('tiny')).filter((e) =>
      e.relativePath.endsWith('.json'),
    );
    const set = await buildSchemaSet(entries, { origin: 'upload' });
    expect(columnDigest(set)?.meta).toHaveLength(5);
    agree(set, 'tiny');
  });

  it('every synthetic fixture set with a resolved root agrees, bar the pinned divergence', async () => {
    const dir = fixtureDir('synthetic');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(names.length).toBeGreaterThan(0);
    let checked = 0;
    for (const name of names) {
      const entries = entriesFromDir(fixtureDir('synthetic', name));
      const set = await buildSchemaSet(entries, { origin: 'upload' });
      const digest = columnDigest(set);
      if (set.root.rootFileId === undefined || digest === null) continue;
      const divergent = KNOWN_DIVERGENT.get(name);
      if (divergent !== undefined) {
        // Pinned, not skipped: assert the exact disagreement so a fix breaks here.
        expect(digest.meta.length, `synthetic/${name}: digest`).toBe(divergent.digest);
        expect(tableOf(set).rows.length, `synthetic/${name}: dictionary`).toBe(
          divergent.dictionary,
        );
        continue;
      }
      agree(set, `synthetic/${name}`);
      checked += 1;
    }
    expect(checked, 'synthetic sets exercising the invariant').toBe(3); // draft7, mini, mixed
  });
});

describe('DICTIONARY_OPTIONS', () => {
  it('pins all three extra-row flags off', () => {
    expect(DICTIONARY_OPTIONS.includePatternProperties).toBe(false);
    expect(DICTIONARY_OPTIONS.includeOpenContentRows).toBe(false);
    expect(DICTIONARY_OPTIONS.expandNested).toBe(false);
  });

  it('emits no /regex/ pseudo-row for a patternProperties schema', async () => {
    const set = await buildSchemaSet(
      [
        entry('root.json', {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: 'https://example.org/root.json',
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' } },
            patternProperties: { '^q_[0-9]+$': { type: 'integer' } },
            additionalProperties: true,
          },
        }),
      ],
      { origin: 'upload' },
    );
    expect(namesOf(tableOf(set))).toEqual(['id']);

    // …and the flags are what suppress them: with the package defaults they appear.
    const loose = schemaDocumentsToTable(toSchemaDocuments(set), { rootUri: rootUriOf(set) ?? '' });
    expect(loose.rows.length).toBeGreaterThan(1);
  });

  // 0.6.0 expands an object-valued column into a row per field by default.
  // The dataset — and columnDigest — has ONE column there, so the dictionary
  // keeps one row, which names what is inside it.
  it('keeps an object-valued column as one row, as the digest does', async () => {
    const set = await buildSchemaSet(
      [
        entry('root.json', {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $id: 'https://example.org/root.json',
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              address: {
                type: 'object',
                properties: { city: { type: 'string' }, zip: { type: 'string' } },
              },
            },
          },
        }),
      ],
      { origin: 'upload' },
    );
    expect(namesOf(tableOf(set))).toEqual(['id', 'address']);
    expect(columnDigest(set)?.meta.map((m) => m.name)).toEqual(['id', 'address']);

    // …and the flag is what keeps it one row: with the package default it splits.
    const expanded = schemaDocumentsToTable(toSchemaDocuments(set), {
      rootUri: rootUriOf(set) ?? '',
    });
    expect(namesOf(expanded)).toEqual(['id', 'address', 'address.city', 'address.zip']);
  });
});

describe('guards', () => {
  it('an empty schema list yields no table instead of throwing', async () => {
    const set = await buildSchemaSet([entry('notes.txt', 'not json at all')], { origin: 'upload' });
    expect(set.schemas).toHaveLength(0);
    expect(() => buildDictionaryTable(set, schemaDocumentsToTable)).not.toThrow();
    expect(buildDictionaryTable(set, schemaDocumentsToTable)).toBeNull();
  });
});

describe('dictionaryTable memoization', () => {
  it('returns null without a resolved root', () => {
    const unresolved: SchemaSet = { ...hesp, root: { ...hesp.root, rootFileId: undefined } };
    expect(dictionaryTable(unresolved)).toBeNull();
  });

  it('returns null when the set has no schemas', async () => {
    const set = await buildSchemaSet([entry('notes.txt', 'nope')], { origin: 'upload' });
    expect(dictionaryTable(set)).toBeNull();
  });

  it('returns the SAME promise twice for one set', () => {
    const first = dictionaryTable(hesp);
    expect(first).not.toBeNull();
    expect(dictionaryTable(hesp)).toBe(first);
  });

  it('returns a DIFFERENT promise after applyRootSelection — the setId regression', async () => {
    const two = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'two-roots')), {
      origin: 'upload',
    });
    const chosen = applyRootSelection(two, 'a.schema.json');
    // The regression this pins: same setId, different set.
    expect(chosen.setId).toBe(two.setId);
    expect(chosen).not.toBe(two);
    expect(dictionaryTable(chosen)).not.toBe(dictionaryTable(two));
  });

  it('resolves to a real table through the dynamic import', async () => {
    const resolved = await dictionaryTable(hesp);
    expect(resolved?.rows).toHaveLength(265);
  });
});
