// Annotation plan (qc-report-spec.md §2): errors-first cell cap, row/column
// always painted, dataset excluded, renderFlag messages, dedupe-once.
import { describe, expect, it } from 'vitest';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import {
  ANNOTATION_CAP,
  buildAnnotationPlan,
} from '../../../src/core/report/annotations';
import type { QCFlag } from '../../../src/core/flags/flag';

const flag = (overrides: Partial<QCFlag>): QCFlag => ({
  source: 'rules',
  ruleId: 'R1',
  scope: 'cell',
  row: 0,
  column: 'a',
  severity: 'error',
  message: 'bad value',
  ...overrides,
});

describe('buildAnnotationPlan', () => {
  it('caps CELL annotations errors→warnings→info; row/column always painted; dataset excluded', () => {
    const store = createFlagStore();
    store.add([
      flag({ ruleId: 'E1', row: 0 }),
      flag({ ruleId: 'E2', row: 1 }),
      flag({ ruleId: 'W1', row: 2, severity: 'warning' }),
      flag({ ruleId: 'I1', row: 3, severity: 'info' }),
      flag({ ruleId: 'ROW', scope: 'row', row: 4, column: undefined }),
      flag({ ruleId: 'COL', scope: 'column', row: undefined, column: 'b', severity: 'info' }),
      flag({ ruleId: 'DS', scope: 'dataset', row: undefined, column: undefined }),
    ]);

    const plan = buildAnnotationPlan(store, { cap: 3 });
    expect(plan.cellTotal).toBe(4);
    expect(plan.cellPainted).toBe(3);
    expect(plan.capped).toBe(true);
    // Row/column-scope lead (store order: column's row-less entries first);
    // then cells errors-first — the info cell fell to the cap.
    expect(plan.items.map((i) => i.code)).toEqual(['COL', 'ROW', 'E1', 'E2', 'W1']);
    expect(plan.items.every((i) => i.code !== 'DS')).toBe(true);

    const rowAnnotation = plan.items[1];
    expect(rowAnnotation).toMatchObject({ scope: 'row', rowId: 4, severity: 'error' });
    const cell = plan.items[2];
    expect(cell).toMatchObject({
      scope: 'cell',
      rowId: 0,
      column: 'a',
      source: 'rules',
      metadata: { scope: 'cell' },
    });
  });

  it('renders messages via renderFlag, correction suffix included; metadata carries the correction', () => {
    const store = createFlagStore();
    store.add([
      flag({
        ruleId: 'Q050',
        severity: 'info',
        message: 'Rent looks cents-scaled; rescaled to dollars.',
        correction: { before: 150000, after: 1500 },
      }),
    ]);

    const plan = buildAnnotationPlan(store);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.message).toBe(
      'Q050: Rent looks cents-scaled; rescaled to dollars. (corrected: 150000 → 1500)',
    );
    expect(plan.items[0]?.metadata).toEqual({
      scope: 'cell',
      correction: { before: 150000, after: 1500 },
    });
    expect(plan.capped).toBe(false);
  });

  it('deduped repeats paint once; default cap is 20k', () => {
    const store = createFlagStore();
    store.add([flag({}), flag({})]); // identical → one entry, count 2
    const plan = buildAnnotationPlan(store);
    expect(plan.items).toHaveLength(1);
    expect(ANNOTATION_CAP).toBe(20_000);
  });
});
