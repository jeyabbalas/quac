/**
 * §D golden-message suite (phase-08 verification): the ten §D.7 examples
 * render CHARACTER-EXACT (golden #2 replaced per Verified fact V15), ≥1
 * golden per §D.6 keyword row incl. the generic fallback, trailer scoping,
 * suppression paths, and byte-identity with the P02 mini expected-flag
 * manifest. All Ajv input is recorded (scripts/record-ajv-errors.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { ColumnDigest } from '../../../src/core/schema/column-meta';
import {
  castNonIntegralMessage,
  castNonNumericMessage,
  createTranslateCtx,
  duplicateRecordsMessage,
  minItemsMessage,
  missingColumnMessage,
  translateRowErrors,
  unexpectedColumnMessage,
} from '../../../src/core/schema/translator';
import type { AjvErrorLike, TranslateCtx } from '../../../src/core/schema/translator';
import { fixtureDir } from './helpers';
import { hespDigest, loadRecorded, miniDigest, scenario, shuffled } from './translator-fixtures';
import type { RecordedScenario } from './translator-fixtures';

let hesp: ColumnDigest;
let mini: ColumnDigest;
let hespCtx: TranslateCtx;
let miniCtx: TranslateCtx;
const hespRec = loadRecorded('hesp');
const miniRec = loadRecorded('mini');

beforeAll(async () => {
  hesp = await hespDigest();
  mini = await miniDigest();
  hespCtx = createTranslateCtx(hesp.meta, hesp.conditionals);
  miniCtx = createTranslateCtx(mini.meta, mini.conditionals);
});

function translate(rec: RecordedScenario, ctx: TranslateCtx): QCFlag[] {
  return translateRowErrors(rec.errors, rec.row, ctx);
}

function onlyFlag(rec: RecordedScenario, ctx: TranslateCtx): QCFlag {
  const flags = translate(rec, ctx);
  expect(flags).toHaveLength(1);
  const flag = flags[0];
  if (flag === undefined) throw new Error('expected one flag');
  return flag;
}

describe('§D.7 goldens (character-exact)', () => {
  it('#1 anyOf collapse with range + sentinels (wage_income_annual = 75000000)', () => {
    const flag = onlyFlag(scenario(hespRec, 'wage-above-max'), hespCtx);
    expect(flag.ruleId).toBe('schema:prop:wage_income_annual:value');
    expect(flag.message).toBe(
      '75000000 exceeds the maximum 50,000,000 — expected an integer 0–50,000,000, or a ' +
        "missing-value code (-666 Not applicable / structural skip, -777 Refused, -888 Don't " +
        'know / unavailable, -999 Not collected / processing missing). ' +
        '[Unit: currency units per year] ' +
        '[Universe: Households reporting wages, salaries, commissions, and tips.]',
    );
    expect(flag.value).toBe(75000000);
  });

  it('#2 (V15 replacement) collapse with sentinel exclusions (selfemp_income_annual = -6000000)', () => {
    const flag = onlyFlag(scenario(hespRec, 'selfemp-below-min'), hespCtx);
    expect(flag.message).toBe(
      '-6000000 is below the minimum -5,000,000 — expected an integer -5,000,000–50,000,000 ' +
        '(sentinel codes are not valid substantive values), or a missing-value code ' +
        "(-666 Not applicable / structural skip, -777 Refused, -888 Don't know / unavailable, " +
        '-999 Not collected / processing missing). [Unit: currency units per year] ' +
        '[Universe: Households reporting net self-employment income.]',
    );
  });

  it('#3 if/then const (baseline_record = 1, move_reason = 3)', () => {
    const flag = onlyFlag(scenario(hespRec, 'ifthen-const-break'), hespCtx);
    expect(flag.ruleId).toBe('schema:cond:12:move_reason');
    expect(flag.message).toBe(
      'when baseline_record = 1, move_reason must be -666 (Not applicable / structural skip). ' +
        'Found 3. [Schema note: Skip pattern: baseline records have no prior-wave move comparison.]',
    );
    expect(flag.meta?.conditionalIndex).toBe(12);
  });

  it('#4 if/then not-const (moved_since_last_wave = 1, move_reason = -666)', () => {
    const flag = onlyFlag(scenario(hespRec, 'ifthen-notconst-break'), hespCtx);
    expect(flag.ruleId).toBe('schema:cond:14:move_reason');
    expect(flag.message).toBe(
      'when moved_since_last_wave = 1, move_reason must not be -666 (Not applicable / ' +
        'structural skip) — a substantive or item-missing value is required. ' +
        '[Schema note: Applicability: households that moved must provide a substantive or ' +
        'item-missing move reason, not structural NA.]',
    );
  });

  it("#5 pattern (record_id = 'HH1234_W01')", () => {
    const flag = onlyFlag(scenario(hespRec, 'pattern-break'), hespCtx);
    expect(flag.ruleId).toBe('schema:prop:record_id:value');
    expect(flag.message).toBe(
      "'HH1234_W01' does not match the expected format (pattern " +
        "^HH[0-9]{8}_W(0[1-9]|1[0-9]|20)$ — Household identifier followed by '_W' and a " +
        'two-digit wave number).',
    );
  });

  it("#6 oneOf with string sentinels (split_origin_household_id = 'HH12')", () => {
    const flag = onlyFlag(scenario(hespRec, 'split-origin-malformed'), hespCtx);
    expect(flag.message).toBe(
      "'HH12' is not valid — expected a Household identifier ('HH' followed by eight digits), " +
        "or one of: 'NA' Not applicable / not a split-off household; 'REFUSED' Refused; " +
        "'DONT_KNOW' Don't know; 'NOT_COLLECTED' Not collected. [Universe: Split-off households.]",
    );
  });

  it('#7 required cell (empty partner_age) — no trailers despite unit+universe metadata', () => {
    const flag = onlyFlag(scenario(hespRec, 'required-missing-cell'), hespCtx);
    expect(flag.ruleId).toBe('schema:prop:partner_age:required');
    expect(flag.message).toBe('value is missing — this variable is required for every record.');
  });

  it('#8 missing column (net_worth)', () => {
    // Spec golden #8 says title "Net worth"; the committed HESP schema titles
    // the column "Household net worth" — the template is the golden, the
    // title comes from the schema (same drift class as V15).
    const netWorth = hesp.meta.find((m) => m.name === 'net_worth');
    expect(netWorth?.title).toBe('Household net worth');
    expect(missingColumnMessage('net_worth', netWorth?.title)).toBe(
      "Variable 'net_worth' (Household net worth) is required by the schema but not present in the dataset.",
    );
  });

  it('#9 cast failures', () => {
    expect(castNonNumericMessage('twelve hundred')).toBe("'twelve hundred' is not a valid integer.");
    expect(castNonIntegralMessage('412.75')).toBe(
      '412.75 is not a whole number — this variable takes integer values.',
    );
  });

  it('#10 dataset duplicate', () => {
    expect(duplicateRecordsMessage(41, 87)).toBe(
      'Rows 41 and 87 are identical records — the schema requires all records to be unique.',
    );
  });
});

describe('§D.6 keyword table (remaining rows)', () => {
  const err = (partial: Partial<AjvErrorLike>): AjvErrorLike => ({
    keyword: 'type',
    instancePath: '/age',
    schemaPath: '#/properties/age/type',
    params: {},
    ...partial,
  });

  it('type', () => {
    const flags = translateRowErrors(
      [err({ keyword: 'type', params: { type: 'integer' }, data: 'abc' })],
      0,
      miniCtx,
    );
    expect(flags[0]?.message).toBe('must be an integer, got string.');
  });

  it('minimum / maximum standalone (bare numeric column, no collapse)', () => {
    const min = err({
      keyword: 'minimum',
      instancePath: '/cross_section_weight',
      schemaPath: '#/properties/cross_section_weight/minimum',
      params: { comparison: '>=', limit: 0 },
      data: -2,
    });
    const max = err({
      keyword: 'maximum',
      instancePath: '/cross_section_weight',
      schemaPath: '#/properties/cross_section_weight/maximum',
      params: { comparison: '<=', limit: 100000000 },
      data: 200000000,
    });
    const flags = translateRowErrors([min, max], 3, hespCtx);
    expect(flags.map((f) => f.message)).toEqual([
      '-2 is below the minimum 0.',
      '200000000 exceeds the maximum 100,000,000.',
    ]);
    expect(new Set(flags.map((f) => f.ruleId))).toEqual(
      new Set(['schema:prop:cross_section_weight:value']),
    );
  });

  it('enum standalone', () => {
    const flags = translateRowErrors(
      [err({ keyword: 'enum', params: { allowedValues: [1, 2, 3] }, data: 9 })],
      0,
      miniCtx,
    );
    expect(flags[0]?.message).toBe('9 is not an allowed value — expected one of 1, 2, 3.');
  });

  it('const standalone resolves the code label from the ValueSpec', () => {
    const flags = translateRowErrors(
      [
        err({
          keyword: 'const',
          instancePath: '/consent',
          schemaPath: '#/properties/consent/const',
          params: { allowedValue: 1 },
          data: 5,
        }),
      ],
      0,
      miniCtx,
    );
    expect(flags[0]?.message).toBe('must be 1 (Yes).');
  });

  it('generic fallback keeps keyword, params summary, and schemaPath', () => {
    const flags = translateRowErrors(
      [
        err({
          keyword: 'multipleOf',
          instancePath: '/score',
          schemaPath: '#/properties/score/multipleOf',
          params: { multipleOf: 5 },
          data: 7,
        }),
      ],
      0,
      miniCtx,
    );
    expect(flags[0]?.message).toBe(
      'value fails the \'multipleOf\' constraint {"multipleOf":5} (schema: #/properties/score/multipleOf)',
    );
    expect(flags[0]?.ruleId).toBe('schema:prop:score:value');
  });

  it('generic fallback omits the params summary when params are empty', () => {
    const flags = translateRowErrors(
      [err({ keyword: 'contains', instancePath: '/score', schemaPath: '#/properties/score/contains' })],
      0,
      miniCtx,
    );
    expect(flags[0]?.message).toBe(
      "value fails the 'contains' constraint (schema: #/properties/score/contains)",
    );
  });

  it('unattributable root-level error → row-scope generic flag', () => {
    const flags = translateRowErrors(
      [err({ keyword: 'type', instancePath: '', schemaPath: '#/type', params: { type: 'object' } })],
      4,
      miniCtx,
    );
    expect(flags[0]).toMatchObject({ scope: 'row', row: 4, ruleId: 'schema:row:type' });
  });

  it('deep instancePath attributes to the top segment with an (at `…`) suffix', () => {
    const flags = translateRowErrors(
      [
        err({
          keyword: 'type',
          instancePath: '/age/2',
          schemaPath: '#/properties/age/items/type',
          params: { type: 'integer' },
          data: 'x',
        }),
      ],
      0,
      miniCtx,
    );
    expect(flags[0]?.column).toBe('age');
    expect(flags[0]?.message).toBe('must be an integer, got string. (at `/2`)');
  });

  it('minItems message builder (§D.6 dataset row)', () => {
    expect(minItemsMessage(0, 1)).toBe('The dataset has 0 records; the schema requires at least 1.');
  });
});

describe('suppression paths', () => {
  it('castFailures silences the whole bucket (§D.3a)', () => {
    const rec = scenario(miniRec, 'cast-failure-absent'); // age absent post-cast-failure
    const withCast = createTranslateCtx(mini.meta, mini.conditionals, {
      castFailures: [`${String(rec.row)} age`],
    });
    expect(translate(rec, withCast)).toEqual([]);
    // Without the cast marker the same recording yields the required flag.
    expect(translate(rec, miniCtx).map((f) => f.ruleId)).toEqual(['schema:prop:age:required']);
  });

  it('missingColumns silences per-row required errors (§D.3b)', () => {
    const rec = scenario(hespRec, 'required-missing-cell');
    const ctx = createTranslateCtx(hesp.meta, hesp.conditionals, {
      missingColumns: ['partner_age'],
    });
    expect(translate(rec, ctx)).toEqual([]);
  });
});

describe('mini manifest parity', () => {
  it('reproduces every translator-scope flag of mini_expected_flags.json verbatim', () => {
    const manifest = JSON.parse(
      readFileSync(join(fixtureDir('synthetic', 'mini'), 'mini_expected_flags.json'), 'utf8'),
    ) as { flags: (QCFlag & { row?: number })[] };
    // Translator scope: everything except cast flags (P09 SQL scan) and
    // dataset-scope flags (P09 SQL checks).
    const expected = manifest.flags.filter(
      (f) => !f.ruleId.endsWith(':cast') && f.scope !== 'dataset',
    );
    const byScenario: Record<string, string> = {
      pattern: 'schema:prop:id:value',
      'anyof-range': 'schema:prop:age:value',
      'anyof-range-number': 'schema:prop:score:value',
      'oneof-codes': 'schema:prop:consent:value',
      'conditional-const': 'schema:cond:0:score',
      'required-missing-cell': 'schema:prop:age:required',
      'unevaluated-extra-column': 'schema:column:notes:unexpected',
    };
    const produced = Object.keys(byScenario).flatMap((name) =>
      translate(scenario(miniRec, name), miniCtx).map((f) => {
        const rest: Partial<QCFlag> = { ...f };
        delete rest.meta;
        return rest;
      }),
    );
    expect(produced).toHaveLength(expected.length);
    for (const want of expected) {
      expect(produced).toContainEqual(want);
    }
  });
});

describe('determinism', () => {
  it('shuffled error input yields identical output for every recorded scenario', () => {
    const cases: { rec: RecordedScenario; ctx: () => TranslateCtx }[] = [
      ...[...hespRec.values()].map((rec) => ({ rec, ctx: () => hespCtx })),
      ...[...miniRec.values()].map((rec) => ({ rec, ctx: () => miniCtx })),
    ];
    for (const { rec, ctx } of cases) {
      const baseline = translate(rec, ctx());
      for (const seed of [1, 7, 42]) {
        expect(translateRowErrors(shuffled(rec.errors, seed), rec.row, ctx())).toEqual(baseline);
      }
    }
  });
});

describe('unexpectedColumnMessage', () => {
  it('matches the §D.6 unevaluatedProperties template', () => {
    expect(unexpectedColumnMessage('notes')).toBe(
      "Column 'notes' is not defined in the schema, which does not allow unexpected variables.",
    );
  });
});
