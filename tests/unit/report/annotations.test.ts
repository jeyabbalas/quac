// Annotation plan (qc-report-spec.md §2): every cell, row and column flag
// painted in store order, dataset excluded, id-free (renderFlagMessage)
// messages, dedupe-once — and no paint cap.
import { describe, expect, it } from 'vitest';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import { buildAnnotationPlan } from '../../../src/core/report/annotations';
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
  it('paints every cell, row and column flag in store order; dataset excluded', () => {
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

    const plan = buildAnnotationPlan(store);
    // The store's own order (row → pipeline category → ruleId; the row-less
    // column flag sorts first). The info cell is there: nothing is dropped.
    expect(plan.items.map((i) => i.code)).toEqual(['COL', 'E1', 'E2', 'W1', 'I1', 'ROW']);
    expect(plan.items.every((i) => i.code !== 'DS')).toBe(true);

    const rowAnnotation = plan.items[5];
    expect(rowAnnotation).toMatchObject({ scope: 'row', rowId: 4, severity: 'error' });
    const cell = plan.items[1];
    expect(cell).toMatchObject({
      scope: 'cell',
      rowId: 0,
      column: 'a',
      source: 'rules',
      metadata: { scope: 'cell' },
    });
  });

  it('renders the id-free message, correction suffix included; metadata carries the correction', () => {
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
      'Rent looks cents-scaled; rescaled to dollars. (corrected: 150000 → 1500)',
    );
    expect(plan.items[0]?.code).toBe('Q050');
    expect(plan.items[0]?.metadata).toEqual({
      scope: 'cell',
      correction: { before: 150000, after: 1500 },
    });
  });

  // UX-09: data-table renders `code · source` beneath every popover entry, so a
  // prefixed message printed the id twice, one row apart.
  it('the ruleId appears once, on `code`, and never inside the message', () => {
    const ruleId = 'schema:prop:reference_year:value';
    const store = createFlagStore();
    store.add([
      flag({
        source: 'schema',
        ruleId,
        message: '2150 exceeds the maximum 2,100 — expected an integer 2,000–2,100.',
      }),
    ]);

    const annotation = buildAnnotationPlan(store).items[0];
    expect(annotation?.message).toBe(
      '2150 exceeds the maximum 2,100 — expected an integer 2,000–2,100.',
    );
    expect(annotation?.message).not.toContain(ruleId);
    expect(annotation?.code).toBe(ruleId);
    expect(annotation?.source).toBe('schema');
  });

  it('deduped repeats paint once', () => {
    const store = createFlagStore();
    store.add([flag({}), flag({})]); // identical → one entry, count 2
    const plan = buildAnnotationPlan(store);
    expect(plan.items).toHaveLength(1);
  });

  // data-table 0.10 holds a million annotations, so the 20,000-cell paint cap
  // it once forced is gone. Past that old line, warnings and infos used to be
  // the first to go — every one of them must survive now.
  it('paints past the old 20,000-cell cap, every severity included', () => {
    const store = createFlagStore();
    const severities = ['error', 'warning', 'info'] as const;
    store.add(
      Array.from({ length: 25_000 }, (_, row) =>
        flag({ ruleId: `R${String(row % 3)}`, row, severity: severities[row % 3] }),
      ),
    );

    const plan = buildAnnotationPlan(store);
    expect(plan.items).toHaveLength(25_000);
    expect(plan.items.filter((i) => i.severity === 'info')).toHaveLength(8_333);
    expect(plan.items.at(-1)).toMatchObject({ scope: 'cell', rowId: 24_999 });
  });
});
