/**
 * §B Ajv engine setup (phase-09): HESP registration, `#/items` pointer
 * compile, the unevaluatedProperties smoke (§B.3 — one extra property ⇒
 * exactly ONE error through the pointer-compiled validator), draft-07 class
 * routing, and §B.2 E_META collection (ALL failures before any addSchema).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  buildAjv,
  collectMetaErrors,
  compileRowValidator,
  registerSchemaFiles,
  schemaDraftOf,
} from '../../../src/core/schema/ajv-engine';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { parseDelimited } from '../../../src/core/ingest/csv';
import { entriesFromDir, fixtureDir } from './helpers';
import type AjvCore from 'ajv/dist/core';
import type { RegisterableFile } from '../../../src/core/schema/ajv-engine';
import type { SchemaSet } from '../../../src/core/schema/types';

async function loadHespSet(): Promise<SchemaSet> {
  const entries = entriesFromDir(fixtureDir('hesp', 'json_schema'));
  return buildSchemaSet(entries, { origin: 'upload' });
}

function registerables(set: SchemaSet): RegisterableFile[] {
  return set.schemas.map((f) => ({ uri: f.retrievalUri, json: f.json }));
}

/** Register the whole set on a fresh root-draft instance (§B.1/§B.2). */
function engineFor(set: SchemaSet): { ajv: AjvCore; rootBase: string } {
  const root = set.schemas.find((f) => f.fileId === set.root.rootFileId);
  if (!root) throw new Error('fixture set has no resolved root');
  const ajv = buildAjv(root.draft);
  registerSchemaFiles(ajv, registerables(set), root.draft);
  return { ajv, rootBase: root.declaredId ?? root.retrievalUri };
}

/** First hesp_valid_100.csv record shaped per §C.3 (empty → absent, numerics → Number). */
async function firstValidHespRow(set: SchemaSet): Promise<Record<string, unknown>> {
  const digest = columnDigest(set);
  if (!digest) throw new Error('HESP digest unavailable');
  const text = readFileSync(fixtureDir('hesp', 'data', 'hesp_valid_100.csv'), 'utf8');
  const parsed = await parseDelimited(text, ',');
  const first = parsed.rows[0];
  if (!first) throw new Error('hesp_valid_100.csv has no data rows');
  const byName = new Map(digest.meta.map((m) => [m.name, m]));
  const record: Record<string, unknown> = {};
  parsed.headers.forEach((name, i) => {
    const raw = first[i];
    if (raw === null || raw === '') return;
    const storage = byName.get(name)?.storageType;
    record[name] = storage === 'BIGINT' || storage === 'DOUBLE' ? Number(raw) : raw;
  });
  return record;
}

describe('HESP registration + pointer compile (§B.2/§B.3)', () => {
  test('all 14 files register and the #/items pointer compiles', async () => {
    const set = await loadHespSet();
    expect(collectMetaErrors(buildAjv('2020-12'), registerables(set), '2020-12')).toEqual([]);
    const { ajv, rootBase } = engineFor(set);
    expect(rootBase).toBe('https://schemas.example.org/hesp/core/core.schema.json');
    const validate = compileRowValidator(ajv, rootBase);
    const row = await firstValidHespRow(set);
    expect(Object.keys(row)).toHaveLength(265);
    expect(validate(row)).toBe(true);
    expect(validate.errors ?? null).toBeNull();
  });

  test('unevaluatedProperties smoke: one extra property ⇒ exactly one error', async () => {
    const set = await loadHespSet();
    const { ajv, rootBase } = engineFor(set);
    const validate = compileRowValidator(ajv, rootBase);
    const row = { ...(await firstValidHespRow(set)), zzz_unexpected: 1 };
    expect(validate(row)).toBe(false);
    const errors = validate.errors ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.keyword).toBe('unevaluatedProperties');
    expect(errors[0]?.params).toMatchObject({ unevaluatedProperty: 'zzz_unexpected' });
  });

  test('unknown pointer target throws a typed compile error', async () => {
    const set = await loadHespSet();
    const { ajv } = engineFor(set);
    expect(() => compileRowValidator(ajv, 'https://example.org/nope')).toThrow(
      /failed to compile/,
    );
  });
});

describe('draft routing (§B.1)', () => {
  test('draft-07 fixture routes to the draft-07 class and validates', async () => {
    const entries = entriesFromDir(fixtureDir('synthetic', 'draft7'));
    const set = await buildSchemaSet(entries, { origin: 'upload' });
    const root = set.schemas.find((f) => f.fileId === set.root.rootFileId);
    expect(root?.draft).toBe('draft-07');
    const ajv = buildAjv('draft-07');
    expect(ajv).toBeInstanceOf(Ajv);
    expect(ajv).not.toBeInstanceOf(Ajv2020);
    registerSchemaFiles(ajv, registerables(set), 'draft-07');
    if (!root) throw new Error('draft7 fixture has no resolved root');
    const validate = compileRowValidator(ajv, root.declaredId ?? root.retrievalUri);
    expect(validate({ id: 'a', val: 1 })).toBe(true);
    expect(validate({ id: 'a', val: -1 })).toBe(false);
  });

  test('2020-12 and unknown drafts route to Ajv2020', () => {
    expect(buildAjv('2020-12')).toBeInstanceOf(Ajv2020);
    expect(buildAjv('unknown')).toBeInstanceOf(Ajv2020);
  });

  test('schemaDraftOf reads $schema suffixes', () => {
    expect(schemaDraftOf({ $schema: 'https://json-schema.org/draft/2020-12/schema' })).toBe(
      '2020-12',
    );
    expect(schemaDraftOf({ $schema: 'https://json-schema.org/draft/2019-09/schema' })).toBe(
      '2019-09',
    );
    expect(schemaDraftOf({ $schema: 'http://json-schema.org/draft-07/schema#' })).toBe('draft-07');
    expect(schemaDraftOf({})).toBe('unknown');
    expect(schemaDraftOf(null)).toBe('unknown');
  });
});

describe('E_META collection (§B.2)', () => {
  const bad1 = { uri: 'quac-set:/bad1.json', json: { type: 123 } };
  const bad2 = { uri: 'quac-set:/bad2.json', json: { properties: 5 } };
  const good = { uri: 'quac-set:/good.json', json: { type: 'object' } };

  test('collects ALL failures, not just the first', () => {
    const ajv = buildAjv('2020-12');
    const errors = collectMetaErrors(ajv, [bad1, good, bad2], '2020-12');
    expect(errors.map((e) => e.uri)).toEqual(['quac-set:/bad1.json', 'quac-set:/bad2.json']);
    for (const e of errors) expect(e.message.length).toBeGreaterThan(0);
  });

  test('different-known-draft files are skipped (E_MIXED_DRAFT covers them)', () => {
    const ajv = buildAjv('2020-12');
    const draft7File = {
      uri: 'quac-set:/d7.json',
      json: { $schema: 'http://json-schema.org/draft-07/schema#', type: 123 },
    };
    expect(collectMetaErrors(ajv, [draft7File], '2020-12')).toEqual([]);
  });

  test('registerSchemaFiles also skips different-known-draft files', () => {
    const ajv = buildAjv('2020-12');
    const draft7File = {
      uri: 'quac-set:/d7.json',
      json: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
    };
    registerSchemaFiles(ajv, [draft7File, good], '2020-12');
    expect(ajv.getSchema('quac-set:/d7.json')).toBeUndefined();
    expect(ajv.getSchema('quac-set:/good.json')).toBeDefined();
  });
});
