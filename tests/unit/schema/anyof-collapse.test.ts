/**
 * §D.3e collapse behavior on recorded Ajv error arrays: exactly ONE flag per
 * bad cell, branch sub-error suppression, and the oneOf multi-match note
 * (phase-08 verification).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ColumnDigest } from '../../../src/core/schema/column-meta';
import { createTranslateCtx, translateRowErrors } from '../../../src/core/schema/translator';
import type { TranslateCtx } from '../../../src/core/schema/translator';
import { hespDigest, loadRecorded, miniDigest, scenario } from './translator-fixtures';

let hesp: ColumnDigest;
let hespCtx: TranslateCtx;
let miniCtx: TranslateCtx;
const hespRec = loadRecorded('hesp');
const miniRec = loadRecorded('mini');
const multiRec = loadRecorded('oneof-multimatch');

beforeAll(async () => {
  hesp = await hespDigest();
  const mini = await miniDigest();
  hespCtx = createTranslateCtx(hesp.meta, hesp.conditionals);
  miniCtx = createTranslateCtx(mini.meta, mini.conditionals);
});

describe('anyOf/oneOf collapse', () => {
  it('a 6-error anyOf storm (wage -555, V15 injection) collapses to ONE flag', () => {
    const rec = scenario(hespRec, 'sentinel-in-numeric-branch');
    expect(rec.errors.length).toBeGreaterThanOrEqual(6); // minimum + 4 consts + anyOf
    const flags = translateRowErrors(rec.errors, rec.row, hespCtx);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.ruleId).toBe('schema:prop:wage_income_annual:value');
    expect(flags[0]?.value).toBe(-555);
    // Branch sub-errors (minimum, sentinel consts) are suppressed, and the
    // collapse renders the below-minimum lead — not the raw branch messages.
    expect(flags[0]?.message).toMatch(/^-555 is below the minimum 0 — expected an integer/);
    expect(flags[0]?.meta?.keyword).toBe('anyOf');
  });

  it('mini anyOf (age 150) and oneOf (consent 5) each yield exactly one flag', () => {
    for (const name of ['anyof-range', 'oneof-codes']) {
      const rec = scenario(miniRec, name);
      expect(rec.errors.length).toBeGreaterThan(1);
      const flags = translateRowErrors(rec.errors, rec.row, miniCtx);
      expect(flags, name).toHaveLength(1);
    }
  });

  it('suppression only applies to the collapsed bucket — other columns keep their flags', () => {
    const range = scenario(hespRec, 'range-break');
    const pattern = scenario(hespRec, 'pattern-break');
    const flags = translateRowErrors([...range.errors, ...pattern.errors], 0, hespCtx);
    expect(flags.map((f) => f.ruleId).sort()).toEqual([
      'schema:prop:record_id:value',
      'schema:prop:reference_year:value',
    ]);
  });

  it('oneOf multi-match appends the exclusive-option note (params.passingSchemas)', () => {
    const rec = scenario(multiRec, 'oneof-multi-match');
    expect(rec.errors[0]?.params.passingSchemas).toEqual([0, 1]);
    // The synthetic multi-match schema is not part of any digest → empty ctx.
    const flags = translateRowErrors(rec.errors, rec.row, createTranslateCtx([], []));
    expect(flags).toHaveLength(1);
    expect(flags[0]?.message).toBe(
      '5 is not valid — expected a value satisfying the schema (matches more than one exclusive option).',
    );
  });

  it('a failed oneOf (passingSchemas null) does NOT get the multi-match note', () => {
    const rec = scenario(miniRec, 'oneof-codes');
    const oneOf = rec.errors.find((e) => e.keyword === 'oneOf');
    expect(oneOf?.params.passingSchemas).toBeNull();
    const flags = translateRowErrors(rec.errors, rec.row, miniCtx);
    expect(flags[0]?.message).not.toContain('exclusive option');
  });
});
