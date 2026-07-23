import { describe, expect, it } from 'vitest';
import { metaValidate } from '../../../src/core/schema/meta-validate';
import { buildSchemaSet, intakeFiles } from '../../../src/core/schema/schema-set';
import { entriesFromDir, entry, fixtureDir } from './helpers';

describe('metaValidate', () => {
  it('passes the full HESP set clean', async () => {
    const intake = intakeFiles(entriesFromDir(fixtureDir('hesp', 'json_schema')), 'upload');
    const schemas = intake.files.filter((f) => f.classification === 'schema');
    expect(await metaValidate(schemas, '2020-12')).toEqual([]);
  });

  it('reports E_META with draft, first Ajv message, and instancePath', async () => {
    const intake = intakeFiles(
      [entry('bad.json', { type: 123, properties: { a: { minimum: 'x' } } })],
      'upload',
    );
    const errors = await metaValidate(intake.files, '2020-12');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('E_META');
    expect(errors[0]?.severity).toBe('fatal');
    expect(errors[0]?.message).toMatch(/^`bad\.json` is not a valid 2020-12 schema: .+ at `.*`\.$/);
  });

  it('collects ALL invalid files, never stopping at the first', async () => {
    const intake = intakeFiles(
      [
        entry('bad1.json', { type: 123 }),
        entry('good.json', { type: 'array', items: {} }),
        entry('bad2.json', { required: 'nope' }),
      ],
      'upload',
    );
    const errors = await metaValidate(intake.files, '2020-12');
    expect(errors.map((e) => e.fileId).sort()).toEqual(['bad1.json', 'bad2.json']);
  });

  it('routes draft-07 sets through the draft-07 meta-schema', async () => {
    const intake = intakeFiles(entriesFromDir(fixtureDir('synthetic', 'draft7')), 'upload');
    expect(await metaValidate(intake.files, 'draft-07')).toEqual([]);
    const bad = intakeFiles(
      [entry('bad7.json', { $schema: 'http://json-schema.org/draft-07/schema#', type: 123 })],
      'upload',
    );
    const errors = await metaValidate(bad.files, 'draft-07');
    expect(errors[0]?.message).toContain('is not a valid draft-07 schema');
  });

  it('skips files of a different known draft (E_MIXED_DRAFT covers them)', async () => {
    const intake = intakeFiles(
      [
        entry('root.json', {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'array',
          items: {},
        }),
        // Invalid, but declares draft-07 on a 2020-12 set: skipped by contract.
        entry('other.json', { $schema: 'http://json-schema.org/draft-07/schema#', type: 123 }),
      ],
      'upload',
    );
    expect(await metaValidate(intake.files, '2020-12')).toEqual([]);
  });

  it('is wired into buildSchemaSet', async () => {
    const set = await buildSchemaSet(
      [entry('root.json', { type: 'array', items: { $ref: 'bad.json' } }), entry('bad.json', { type: 123 })],
      { origin: 'upload' },
    );
    expect(set.errors.filter((e) => e.code === 'E_META')).toHaveLength(1);
  });
});
