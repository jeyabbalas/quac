/**
 * §D.3d conditional attribution on recorded Ajv error arrays: then-target
 * attribution via the `#/allOf/(i)/(then|else)/` schemaPath match,
 * per-(index,column) grouping, `if`-wrapper dropping, and coexistence with a
 * base value flag on the same cell (phase-08 verification).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ColumnDigest } from '../../../src/core/schema/column-meta';
import { createTranslateCtx, translateRowErrors } from '../../../src/core/schema/translator';
import type { AjvErrorLike, TranslateCtx } from '../../../src/core/schema/translator';
import { hespDigest, loadRecorded, scenario } from './translator-fixtures';

let hesp: ColumnDigest;
let hespCtx: TranslateCtx;
const hespRec = loadRecorded('hesp');

beforeAll(async () => {
  hesp = await hespDigest();
  hespCtx = createTranslateCtx(hesp.meta, hesp.conditionals);
});

describe('conditional attribution', () => {
  it('attributes then-side errors to the target column with the allOf index', () => {
    const rec = scenario(hespRec, 'ifthen-const-break');
    const flags = translateRowErrors(rec.errors, rec.row, hespCtx);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      ruleId: 'schema:cond:12:move_reason',
      scope: 'cell',
      column: 'move_reason',
      value: 3,
      meta: { conditionalIndex: 12 },
    });
  });

  it('drops `if` wrapper errors (they never become flags)', () => {
    const rec = scenario(hespRec, 'ifthen-notconst-break');
    expect(rec.errors.some((e) => e.keyword === 'if')).toBe(true);
    const flags = translateRowErrors(rec.errors, rec.row, hespCtx);
    expect(flags.map((f) => f.ruleId)).toEqual(['schema:cond:14:move_reason']);
  });

  it('dedupes multiple then-errors of one (index, column) group into a single flag', () => {
    const rec = scenario(hespRec, 'ifthen-const-break');
    const condError = rec.errors.find((e) => e.schemaPath.startsWith('#/allOf/12/then/'));
    if (condError === undefined) throw new Error('expected a cond-12 then error');
    const duplicated = [...rec.errors, { ...condError }];
    const flags = translateRowErrors(duplicated, rec.row, hespCtx);
    expect(flags).toHaveLength(1);
  });

  it('coexists with the base value flag on the same cell (baseline row, move_reason -555)', () => {
    const rec = scenario(hespRec, 'coexistence-value-and-conditional');
    const flags = translateRowErrors(rec.errors, rec.row, hespCtx);
    // One conditional flag + one collapsed value flag, both on move_reason —
    // the collapse suppresses branch noise but never conditional flags.
    expect(flags.map((f) => f.ruleId)).toEqual([
      'schema:cond:12:move_reason',
      'schema:prop:move_reason:value',
    ]);
    expect(flags.every((f) => f.column === 'move_reason' && f.row === rec.row)).toBe(true);
  });

  it('two different conditionals on one column yield two distinct flags', () => {
    // Hand-crafted: cond 12 (const -666) and cond 14 (not -666) can never fire
    // together in real data, so synthesize both groups to pin per-index grouping.
    const errors: AjvErrorLike[] = [
      {
        keyword: 'const',
        instancePath: '/move_reason',
        schemaPath: '#/allOf/12/then/properties/move_reason/const',
        params: { allowedValue: -666 },
        data: 3,
      },
      {
        keyword: 'not',
        instancePath: '/move_reason',
        schemaPath: '#/allOf/14/then/properties/move_reason/not',
        params: {},
        data: 3,
      },
    ];
    const flags = translateRowErrors(errors, 9, hespCtx);
    expect(flags.map((f) => f.ruleId)).toEqual([
      'schema:cond:12:move_reason',
      'schema:cond:14:move_reason',
    ]);
  });

  it('an unknown allOf index falls back to per-keyword flags instead of dropping errors', () => {
    const errors: AjvErrorLike[] = [
      {
        keyword: 'const',
        instancePath: '/move_reason',
        schemaPath: '#/allOf/9999/then/properties/move_reason/const',
        params: { allowedValue: -666 },
        data: 3,
      },
    ];
    const flags = translateRowErrors(errors, 0, hespCtx);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.ruleId).toBe('schema:prop:move_reason:value');
  });
});
