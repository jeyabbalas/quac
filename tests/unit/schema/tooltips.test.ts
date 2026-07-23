/**
 * §E.2 tooltip content + §E.4 rule summaries: item set/order, chip rendering,
 * and the 12-code / 5-conditional caps.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { columnDigest } from '../../../src/core/schema/column-meta';
import type { ColumnDigest, ColumnMeta } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { buildTooltip, summarizeColumnRules } from '../../../src/core/schema/tooltips';
import { entriesFromDir, fixtureDir } from './helpers';

let digest: ColumnDigest;

beforeAll(async () => {
  const set = await buildSchemaSet(entriesFromDir(fixtureDir('hesp', 'json_schema')), {
    origin: 'upload',
  });
  const d = columnDigest(set);
  if (d === null) throw new Error('HESP digest unexpectedly null');
  digest = d;
});

const get = (name: string): ColumnMeta => {
  const m = digest.meta.find((c) => c.name === name);
  if (m === undefined) throw new Error(`missing column ${name}`);
  return m;
};

describe('buildTooltip', () => {
  it('renders the full §E.2 item set in order for wage_income_annual', () => {
    const tooltip = buildTooltip(get('wage_income_annual'), digest.conditionals);
    expect(tooltip.title).toBe('Annual amount: wages, salaries, commissions, and tips');
    const labels = tooltip.items?.map((i) => i.label);
    expect(labels).toEqual([
      'Type',
      'Allowed',
      'Missing-value codes',
      'Unit',
      'Universe',
      'Group',
      'Conditional rules',
      'Required',
    ]);
    const byLabel = new Map(tooltip.items?.map((i) => [i.label, i.value]));
    expect(byLabel.get('Type')).toBe('integer');
    expect(byLabel.get('Allowed')).toContain('an integer 0–50,000,000');
    expect(byLabel.get('Missing-value codes')).toEqual([
      '-666 — Not applicable / structural skip',
      '-777 — Refused',
      "-888 — Don't know / unavailable",
      '-999 — Not collected / processing missing',
    ]);
    expect(byLabel.get('Unit')).toBe('currency units per year');
    expect(byLabel.get('Required')).toBe('yes');
  });

  it('renders codes as chips and conditional one-liners', () => {
    const tooltip = buildTooltip(get('move_reason'), digest.conditionals);
    const byLabel = new Map(tooltip.items?.map((i) => [i.label, i.value]));
    const conditionalLines = byLabel.get('Conditional rules');
    expect(Array.isArray(conditionalLines)).toBe(true);
    expect(conditionalLines?.[0]).toBe(
      'when baseline_record = 1, must be -666 (Not applicable / structural skip)',
    );
    const codes = buildTooltip(get('resp_laid_off_12m'), digest.conditionals);
    const allowed = codes.items?.find((i) => i.label === 'Allowed')?.value;
    expect(allowed).toEqual(['0 — No', '1 — Yes']);
  });

  it('caps codes at 12 and conditionals at 5 with "+n more"', () => {
    const base = get('resp_laid_off_12m');
    const spec = base.valueSpec;
    if (spec.kind !== 'codes') throw new Error('expected codes spec');
    const wide: ColumnMeta = {
      ...base,
      valueSpec: {
        kind: 'codes',
        codes: Array.from({ length: 15 }, (_, i) => ({ value: i, label: `Code ${String(i)}` })),
        sentinels: spec.sentinels,
      },
      conditionals: { asTarget: [0, 1, 2, 3, 4, 5, 6], asCondition: [] },
    };
    // Point asTarget at real rules that target this synthetic column name.
    const rules = digest.conditionals.slice(0, 7).map((r) => ({
      ...r,
      targets: [{ column: base.name, kind: 'schema' as const, text: 't' }],
    }));
    const tooltip = buildTooltip(wide, rules);
    const byLabel = new Map(tooltip.items?.map((i) => [i.label, i.value]));
    const allowed = byLabel.get('Allowed');
    expect(Array.isArray(allowed) && allowed.length).toBe(13);
    expect(Array.isArray(allowed) ? allowed[12] : '').toBe('+3 more');
    const conds = byLabel.get('Conditional rules');
    expect(Array.isArray(conds) && conds.length).toBe(6);
    expect(Array.isArray(conds) ? conds[5] : '').toBe('+2 more');
  });

  it('falls back to the column name and omits empty items', () => {
    const base = get('wage_income_annual');
    const bare: ColumnMeta = {
      name: 'mystery',
      required: false,
      jsonTypes: base.jsonTypes,
      storageType: base.storageType,
      mixed: false,
      valueSpec: { kind: 'opaque' },
      conditionals: { asTarget: [], asCondition: [] },
      source: base.source,
    };
    const tooltip = buildTooltip(bare, []);
    expect(tooltip.title).toBe('mystery');
    expect(tooltip.description).toBeUndefined();
    expect(tooltip.items?.map((i) => i.label)).toEqual(['Type', 'Allowed']);
  });
});

describe('summarizeColumnRules (§E.4)', () => {
  it('lists expectation, required, conditional one-liners, comment', () => {
    const lines = summarizeColumnRules(get('move_reason'), digest.conditionals);
    expect(lines[0]).toContain('one of:');
    expect(lines[1]).toBe('required');
    expect(lines.some((l) => l.startsWith('when baseline_record = 1,'))).toBe(true);
    expect(lines.some((l) => l.startsWith('when moved_since_last_wave = 1,'))).toBe(true);
  });
});
