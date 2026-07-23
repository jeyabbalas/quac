/**
 * §E.1/§E.3 golden digests over the real HESP schema set (phase-07
 * verification): counts, the five named golden columns, missing-variables
 * ordering, and §D.4 expectation rendering.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildColumnMeta, columnDigest, missingVariables } from '../../../src/core/schema/column-meta';
import type { ColumnMeta } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { renderExpectation } from '../../../src/core/schema/value-spec';
import type { SchemaSet } from '../../../src/core/schema/types';
import { entriesFromDir, entry, fixtureDir } from './helpers';

let set: SchemaSet;
let meta: ColumnMeta[];
const byName = new Map<string, ColumnMeta>();

beforeAll(async () => {
  set = await buildSchemaSet(entriesFromDir(fixtureDir('hesp', 'json_schema')), {
    origin: 'upload',
  });
  expect(set.root.rootFileId).toBe('core/core.schema.json');
  meta = buildColumnMeta(set, 'core/core.schema.json');
  for (const m of meta) byName.set(m.name, m);
});

const get = (name: string): ColumnMeta => {
  const m = byName.get(name);
  if (m === undefined) throw new Error(`missing column ${name}`);
  return m;
};

describe('buildColumnMeta over HESP', () => {
  it('digests 265 columns, all required', () => {
    expect(meta).toHaveLength(265);
    expect(meta.every((m) => m.required)).toBe(true);
  });

  it('wage_income_annual: range + 4 labeled sentinels + unit + universe (BIGINT)', () => {
    const m = get('wage_income_annual');
    expect(m.title).toBe('Annual amount: wages, salaries, commissions, and tips');
    expect(m.group).toBe('income');
    expect(m.unit).toBe('currency units per year');
    expect(m.universe).toBe('Households reporting wages, salaries, commissions, and tips.');
    expect([...m.jsonTypes]).toEqual(['integer']);
    expect(m.storageType).toBe('BIGINT');
    expect(m.mixed).toBe(false);
    expect(m.valueSpec).toEqual({
      kind: 'numeric',
      numType: 'integer',
      min: 0,
      max: 50000000,
      exclusions: [],
      sentinels: [
        { value: -666, label: 'Not applicable / structural skip' },
        { value: -777, label: 'Refused' },
        { value: -888, label: "Don't know / unavailable" },
        { value: -999, label: 'Not collected / processing missing' },
      ],
    });
    expect(renderExpectation(m.valueSpec)).toBe(
      'an integer 0–50,000,000, or a missing-value code (-666 Not applicable / structural skip, ' +
        "-777 Refused, -888 Don't know / unavailable, -999 Not collected / processing missing)",
    );
  });

  it('selfemp_income_annual: signed range + sentinel exclusions', () => {
    const m = get('selfemp_income_annual');
    const spec = m.valueSpec;
    if (spec.kind !== 'numeric') throw new Error('expected numeric spec');
    expect(spec.min).toBe(-5000000);
    expect(spec.max).toBe(50000000);
    expect(spec.exclusions.map((e) => e.value)).toEqual([-666, -777, -888, -999]);
    expect(spec.exclusions[0]?.label).toBe('Not applicable / structural skip');
    expect(renderExpectation(spec)).toBe(
      'an integer -5,000,000–50,000,000 (sentinel codes are not valid substantive values), ' +
        'or a missing-value code (-666 Not applicable / structural skip, -777 Refused, ' +
        "-888 Don't know / unavailable, -999 Not collected / processing missing)",
    );
  });

  it('a yes_no column: inline codes vs $ref-derived sentinels', () => {
    const m = get('resp_laid_off_12m');
    // Sibling title on the $ref wins over the shared def.
    expect(m.title).toBe(
      'Respondent experienced a layoff or involuntary job separation in past 12 months',
    );
    expect(m.storageType).toBe('BIGINT');
    expect(m.valueSpec).toEqual({
      kind: 'codes',
      codes: [
        { value: 0, label: 'No' },
        { value: 1, label: 'Yes' },
      ],
      sentinels: [
        { value: -777, label: 'Refused' },
        { value: -888, label: "Don't know / unavailable" },
        { value: -999, label: 'Not collected / processing missing' },
      ],
    });
    expect(renderExpectation(m.valueSpec)).toBe(
      "one of: 0 No; 1 Yes; -777 Refused; -888 Don't know / unavailable; " +
        '-999 Not collected / processing missing',
    );
  });

  it('split_origin_household_id: pattern def + string sentinels (VARCHAR)', () => {
    const m = get('split_origin_household_id');
    expect(m.universe).toBe('Split-off households.');
    expect([...m.jsonTypes]).toEqual(['string']);
    expect(m.storageType).toBe('VARCHAR');
    expect(m.mixed).toBe(false);
    expect(m.valueSpec).toEqual({
      kind: 'string-pattern',
      pattern: '^HH[0-9]{8}$',
      patternTitle: 'Household identifier',
      patternDescription: "Stable household identifier formatted 'HH' followed by eight digits.",
      sentinels: [
        { value: 'NA', label: 'Not applicable / not a split-off household' },
        { value: 'REFUSED', label: 'Refused' },
        { value: 'DONT_KNOW', label: "Don't know" },
        { value: 'NOT_COLLECTED', label: 'Not collected' },
      ],
    });
  });

  it('cross_section_weight: number def via $ref with sibling overrides (DOUBLE)', () => {
    const m = get('cross_section_weight');
    expect(m.title).toBe('Cross-sectional household weight');
    expect(m.role).toBe('analysis weight');
    expect([...m.jsonTypes]).toEqual(['number']);
    expect(m.storageType).toBe('DOUBLE');
    expect(m.valueSpec).toEqual({
      kind: 'numeric',
      numType: 'number',
      min: 0,
      max: 100000000,
      exclusions: [],
      sentinels: [],
    });
    expect(renderExpectation(m.valueSpec)).toBe('a number 0–100,000,000');
  });

  it('records provenance and conditional cross-indexes', () => {
    const wage = get('wage_income_annual');
    expect(wage.source.fileId).toBe('core/categories/income.json');
    expect(wage.source.pointer).toBe('/properties/wage_income_annual');
    const moveReason = get('move_reason');
    expect(moveReason.conditionals.asTarget.length).toBeGreaterThanOrEqual(2);
    const baselineRecord = get('baseline_record');
    expect(baselineRecord.conditionals.asCondition.length).toBeGreaterThanOrEqual(1);
  });
});

describe('columnDigest memoization', () => {
  it('returns the same digest object per set and null without a root', async () => {
    const first = columnDigest(set);
    expect(first).not.toBeNull();
    expect(columnDigest(set)).toBe(first);
    expect(first?.meta).toHaveLength(265);
    expect(first?.conditionals).toHaveLength(171);

    const cycle = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'cycle')), {
      origin: 'upload',
    });
    expect(cycle.root.rootFileId).toBeUndefined();
    expect(columnDigest(cycle)).toBeNull();
  });

  it('digests items-level properties of generic schemas (tiny/people)', async () => {
    const raw = readFileSync(join(fixtureDir('tiny'), 'people.schema.json'), 'utf8');
    const tiny = await buildSchemaSet([entry('people.schema.json', raw)], { origin: 'upload' });
    const digest = columnDigest(tiny);
    expect(digest?.meta.map((m) => m.name)).toEqual(['person_id', 'name', 'age', 'city', 'score']);
  });
});

describe('missingVariables (§E.3)', () => {
  it('lists absent variables, required first, schema declaration order', () => {
    const names = meta.map((m) => m.name);
    const datasetColumns = names.filter(
      (n) => n !== 'wage_income_annual' && n !== 'move_reason',
    );
    const missing = missingVariables(meta, datasetColumns);
    // Both required; declaration order: move_reason (housing) precedes
    // wage_income_annual only if housing's category comes first — assert
    // against the digest's own order instead of hardcoding.
    const expectedOrder = names.filter((n) => n === 'wage_income_annual' || n === 'move_reason');
    expect(missing.map((m) => m.name)).toEqual(expectedOrder);
    expect(missing.every((m) => m.required)).toBe(true);
    expect(missing[0]?.title).toBeDefined();
  });

  it('sorts required before optional', () => {
    const fake: ColumnMeta[] = [
      { ...get('wage_income_annual'), name: 'opt_a', required: false },
      { ...get('wage_income_annual'), name: 'req_b', required: true },
    ];
    expect(missingVariables(fake, []).map((m) => m.name)).toEqual(['req_b', 'opt_a']);
  });
});
