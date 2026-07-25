/**
 * Data-dictionary extraction over the real HESP set (UIX-4 step-0 gate) plus
 * the agreement invariant that keeps QuaC's two descriptions of a schema —
 * `columnDigest` and the dictionary — naming the same variables.
 *
 * The extractor is imported STATICALLY here; the browser injects a dynamically
 * imported one (data-dictionary.ts's `SchemaToTable` port).
 */
import { readdirSync } from 'node:fs';
import { schemaDocumentsToTable } from 'json-schema-data-dictionary';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DICTIONARY_OPTIONS,
  buildDictionaryModel,
  dictionaryModel,
  rootUriOf,
  toSchemaDocuments,
} from '../../../src/core/schema/data-dictionary';
import type { DictionaryModel } from '../../../src/core/schema/data-dictionary';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { applyRootSelection } from '../../../src/core/schema/root-detection';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import type { SchemaSet } from '../../../src/core/schema/types';
import { entriesFromDir, entry, fixtureDir } from './helpers';

const HESP_ROOT_ID = 'core/core.schema.json';

let hesp: SchemaSet;
let model: DictionaryModel;

beforeAll(async () => {
  hesp = await buildSchemaSet(entriesFromDir(fixtureDir('hesp', 'json_schema')), {
    origin: 'upload',
  });
  expect(hesp.root.rootFileId).toBe(HESP_ROOT_ID);
  model = buildDictionaryModel(hesp, schemaDocumentsToTable);
});

const rowsOf = (m: DictionaryModel): DictionaryModel['categories'][number]['rows'] =>
  m.categories.flatMap((c) => [...c.rows]);

const row = (name: string): DictionaryModel['categories'][number]['rows'][number] => {
  const hit = rowsOf(model).find((r) => r.name === name);
  if (hit === undefined) throw new Error(`missing dictionary row ${name}`);
  return hit;
};

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

describe('buildDictionaryModel over HESP', () => {
  it('extracts 265 rows in 12 categories with no warnings', () => {
    expect(model.rowCount).toBe(265);
    expect(model.categories).toHaveLength(12);
    expect(model.warnings).toEqual([]);
  });

  it('keeps categories in items.allOf order with the measured per-category counts', () => {
    expect(model.categories.map((c) => c.title)).toEqual([
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
    expect(model.categories.map((c) => c.rows.length)).toEqual([
      16, 28, 24, 32, 26, 24, 24, 26, 17, 23, 10, 15,
    ]);
  });

  it('household_size: measurement range, two sentinels, x-unit as "Unit"', () => {
    const m = row('household_size');
    expect(m.type).toBe('integer + coded values');
    expect(m.values).toEqual([
      { kind: 'measurement', code: null, label: '1–20' },
      {
        kind: 'sentinel',
        code: '-888',
        label: "Don't know / unavailable",
        note: 'The respondent did not know the value or it could not be determined.',
      },
      {
        kind: 'sentinel',
        code: '-999',
        label: 'Not collected / processing missing',
        note: 'The item was in universe but was not collected or was unavailable after processing.',
      },
    ]);
    expect(m.sentinelStart).toBe(1);
    expect(m.extras).toEqual([{ label: 'Unit', text: 'persons', nested: false }]);
    expect(m.constraints.map((c) => c.text)).toEqual([
      'Required',
      'Measured value: 1 ≤ value ≤ 20',
    ]);
  });

  it('partitions values stably: sentinels last, order preserved within a group', () => {
    for (const r of rowsOf(model)) {
      // The invariant: no substantive value at or after sentinelStart, and no
      // sentinel before it.
      expect(r.values.slice(r.sentinelStart).every((v) => v.kind === 'sentinel')).toBe(true);
      expect(r.values.slice(0, r.sentinelStart).every((v) => v.kind !== 'sentinel')).toBe(true);
    }
    // …and the partition does real work: 2 of 265 rows arrive interleaved.
    let unpartitionedOnInput = 0;
    const table = schemaDocumentsToTable(toSchemaDocuments(hesp), {
      ...DICTIONARY_OPTIONS,
      rootUri: rootUriOf(hesp) ?? '',
    });
    for (const r of table.rows) {
      let seenSentinel = false;
      for (const v of r['Valid values']) {
        if ((v.kind ?? 'value') === 'sentinel') seenSentinel = true;
        else if (seenSentinel) {
          unpartitionedOnInput += 1;
          break;
        }
      }
    }
    expect(unpartitionedOnInput).toBe(2);
  });

  it('builds a lowercased haystack covering values, constraints, extras and the category', () => {
    const m = row('household_size');
    for (const token of ['household_size', 'persons', "don't know", '1 ≤ value ≤ 20', 'x-unit']) {
      expect(m.haystack).toContain(token);
    }
    expect(m.haystack).toContain('hesp core - household composition');
    expect(m.haystack).toBe(m.haystack.toLowerCase());
  });
});

/**
 * QuaC now describes a schema twice — `columnDigest` (validation) and this
 * dictionary (browsing). These tests turn "the two may drift" from a risk into
 * a CI failure.
 */
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
    const dict = buildDictionaryModel(set, schemaDocumentsToTable);
    expect(dict.rowCount, `${label}: row count`).toBe(digest.meta.length);
    expect(new Set(rowsOf(dict).map((r) => r.name)), `${label}: variable names`).toEqual(
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
        expect(
          buildDictionaryModel(set, schemaDocumentsToTable).rowCount,
          `synthetic/${name}: dictionary`,
        ).toBe(divergent.dictionary);
        continue;
      }
      agree(set, `synthetic/${name}`);
      checked += 1;
    }
    expect(checked, 'synthetic sets exercising the invariant').toBe(3); // draft7, mini, mixed
  });
});

describe('DICTIONARY_OPTIONS', () => {
  it('pins both pseudo-row flags off', () => {
    expect(DICTIONARY_OPTIONS.includePatternProperties).toBe(false);
    expect(DICTIONARY_OPTIONS.includeOpenContentRows).toBe(false);
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
    const dict = buildDictionaryModel(set, schemaDocumentsToTable);
    expect(rowsOf(dict).map((r) => r.name)).toEqual(['id']);

    // …and the flags are what suppress them: with the package defaults they appear.
    const loose = schemaDocumentsToTable(toSchemaDocuments(set), { rootUri: rootUriOf(set) ?? '' });
    expect(loose.rows.length).toBeGreaterThan(1);
  });
});

describe('guards', () => {
  it('an empty schema list yields an empty model instead of throwing', async () => {
    const set = await buildSchemaSet([entry('notes.txt', 'not json at all')], { origin: 'upload' });
    expect(set.schemas).toHaveLength(0);
    expect(() => buildDictionaryModel(set, schemaDocumentsToTable)).not.toThrow();
    expect(buildDictionaryModel(set, schemaDocumentsToTable)).toEqual({
      categories: [],
      rowCount: 0,
      warnings: [],
    });
  });
});

describe('dictionaryModel memoization', () => {
  it('returns null without a resolved root', () => {
    const unresolved: SchemaSet = { ...hesp, root: { ...hesp.root, rootFileId: undefined } };
    expect(dictionaryModel(unresolved)).toBeNull();
  });

  it('returns null when the set has no schemas', async () => {
    const set = await buildSchemaSet([entry('notes.txt', 'nope')], { origin: 'upload' });
    expect(dictionaryModel(set)).toBeNull();
  });

  it('returns the SAME promise twice for one set', () => {
    const first = dictionaryModel(hesp);
    expect(first).not.toBeNull();
    expect(dictionaryModel(hesp)).toBe(first);
  });

  it('returns a DIFFERENT promise after applyRootSelection — the setId regression', async () => {
    const two = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'two-roots')), {
      origin: 'upload',
    });
    const chosen = applyRootSelection(two, 'a.schema.json');
    // The regression this pins: same setId, different set.
    expect(chosen.setId).toBe(two.setId);
    expect(chosen).not.toBe(two);
    expect(dictionaryModel(chosen)).not.toBe(dictionaryModel(two));
  });

  it('resolves to a real model through the dynamic import', async () => {
    const resolved = await dictionaryModel(hesp);
    expect(resolved?.rowCount).toBe(265);
  });
});
