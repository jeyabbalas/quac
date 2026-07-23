// Header-tooltip aggregation (qc-report-spec.md §3 / phase-14 "tooltip
// aggregation unit test"): schema digest items merged with the QC-rules item
// per column, rule-line caps, comment snipping, and column filtering.
import { describe, expect, it } from 'vitest';
import { buildHeaderTooltips, TOOLTIP_RULE_CAP } from '../../../src/core/report/headerTooltips';
import type { ColumnDigest, ColumnMeta } from '../../../src/core/schema/column-meta';
import type { QCRule, RuleFile } from '../../../src/core/rules/types';

const meta = (name: string): ColumnMeta => ({
  name,
  title: `${name} title`,
  required: true,
  jsonTypes: new Set(['integer']),
  storageType: 'BIGINT',
  mixed: false,
  valueSpec: { kind: 'numeric', numType: 'integer', min: 0, max: 120, exclusions: [], sentinels: [] },
  conditionals: { asTarget: [], asCondition: [] },
  source: { fileId: 'mini.schema.json', pointer: `/items/properties/${name}` },
});

const digest = (...names: string[]): ColumnDigest => ({
  meta: names.map(meta),
  conditionals: [],
});

const rule = (ruleId: string, targets: string[], comment = `${ruleId} comment`): QCRule => ({
  ruleId,
  ruleType: 'validate',
  ruleScope: 'row',
  targetVariables: targets,
  condition: 'TRUE',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'warning',
  comment,
  enabled: true,
  sourceFile: 'r.quac.csv',
  rowNumber: 1,
  extras: {},
});

const file = (...rules: QCRule[]): RuleFile => ({
  name: 'r.quac.csv',
  group: 'r',
  rules,
  extraColumns: [],
});

describe('buildHeaderTooltips', () => {
  it('merges schema items with a trailing QC rules item; rules-only columns get a bare tooltip; untargeted columns none', () => {
    const plan = buildHeaderTooltips(
      digest('age'),
      [file(rule('R001', ['age', 'zip']), rule('R002', ['age']), rule('R003', ['ghost']))],
      ['age', 'zip', 'other'],
    );

    const age = plan.byColumn.get('age');
    expect(age?.title).toBe('age title');
    const labels = (age?.items ?? []).map((i) => i.label);
    expect(labels[0]).toBe('Type'); // schema items lead
    expect(labels.at(-1)).toBe('QC rules'); // rules item appended last
    expect(age?.items?.at(-1)?.value).toEqual(['R001 — R001 comment', 'R002 — R002 comment']);

    // zip: no schema meta → title fallback + rules item only.
    expect(plan.byColumn.get('zip')).toEqual({
      title: 'zip',
      items: [{ label: 'QC rules', value: ['R001 — R001 comment'] }],
    });

    // 'other' has neither; 'ghost' is not a dataset column.
    expect(plan.byColumn.has('other')).toBe(false);
    expect(plan.byColumn.has('ghost')).toBe(false);
  });

  it('caps rule lines at 6 with "+n more"; snips comments at ~80 chars; empty comment → bare ruleId', () => {
    const rules = Array.from({ length: 8 }, (_, i) => rule(`R00${String(i)}`, ['age']));
    const plan = buildHeaderTooltips(null, [file(...rules)], ['age']);
    const value = plan.byColumn.get('age')?.items?.[0]?.value;
    expect(Array.isArray(value) && value.length).toBe(TOOLTIP_RULE_CAP + 1);
    expect(Array.isArray(value) ? value.at(-1) : undefined).toBe('+2 more');

    const long = buildHeaderTooltips(null, [file(rule('RL', ['age'], 'x'.repeat(100)))], ['age']);
    const line = long.byColumn.get('age')?.items?.[0]?.value;
    expect(Array.isArray(line) ? line[0] : line).toBe(`RL — ${'x'.repeat(80)}…`);

    const bare = buildHeaderTooltips(null, [file(rule('RB', ['age'], '  '))], ['age']);
    const bareLine = bare.byColumn.get('age')?.items?.[0]?.value;
    expect(Array.isArray(bareLine) ? bareLine[0] : bareLine).toBe('RB');
  });

  it('dedupes repeated targets within one rule; keeps file/load order across files', () => {
    const plan = buildHeaderTooltips(
      null,
      [
        file(rule('B1', ['age', 'age'])),
        { ...file(rule('A1', ['age'])), name: 'second.quac.csv', group: 'second' },
      ],
      ['age'],
    );
    expect(plan.byColumn.get('age')?.items?.[0]?.value).toEqual([
      'B1 — B1 comment',
      'A1 — A1 comment',
    ]);
  });
});
