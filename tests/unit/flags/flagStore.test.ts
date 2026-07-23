import { describe, expect, it } from 'vitest';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import type { QCFlag } from '../../../src/core/flags/flag';

function cell(row: number, column: string, ruleId: string, overrides: Partial<QCFlag> = {}): QCFlag {
  return {
    source: 'schema',
    ruleId,
    scope: 'cell',
    row,
    column,
    severity: 'error',
    message: `bad value in ${column}`,
    ...overrides,
  };
}

/** mulberry32 — deterministic shuffle for the determinism test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

describe('flagStore dedupe', () => {
  it('counts identical duplicates without re-materializing', () => {
    const store = createFlagStore();
    const f = cell(1, 'age', 'schema:prop:age:value');
    store.add([f, { ...f }, { ...f }]);
    const entries = store.byCell(1, 'age');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.count).toBe(3);
    expect(store.summary().totalCount).toBe(3);
    expect(store.summary().countsByRuleId.get('schema:prop:age:value')).toBe(3);
  });

  it('keeps flags distinct when the message differs', () => {
    const store = createFlagStore();
    const f = cell(1, 'age', 'schema:prop:age:value');
    store.add([f, { ...f, message: 'different text' }]);
    expect(store.byCell(1, 'age')).toHaveLength(2);
  });
});

describe('flagStore indexes', () => {
  const dataset: QCFlag = {
    source: 'schema',
    ruleId: 'schema:dataset:duplicate-records',
    scope: 'dataset',
    severity: 'error',
    message: 'Rows 8 and 9 are identical records — the schema requires all records to be unique.',
  };
  const columnFlag: QCFlag = {
    source: 'schema',
    ruleId: 'schema:column:notes:unexpected',
    scope: 'column',
    column: 'notes',
    severity: 'error',
    message: "Column 'notes' is not defined in the schema, which does not allow unexpected variables.",
  };

  it('byCell / byColumn / byRule / datasetScope route correctly', () => {
    const store = createFlagStore();
    store.add([cell(0, 'age', 'schema:prop:age:value'), cell(1, 'age', 'schema:prop:age:value'), columnFlag, dataset]);
    expect(store.byCell(0, 'age')).toHaveLength(1);
    expect(store.byCell(0, 'score')).toHaveLength(0);
    expect(store.byColumn('age')).toHaveLength(2);
    expect(store.byColumn('notes')).toHaveLength(1); // column-scope flags land in byColumn
    expect(store.byRule('schema:prop:age:value')).toHaveLength(2);
    expect(store.datasetScope().map((e) => e.flag.ruleId)).toEqual(['schema:dataset:duplicate-records']);
    expect(store.all()).toHaveLength(4);
  });

  it('orders a cell by pipeline stage (corrections → schema → rules) then ruleId', () => {
    const store = createFlagStore();
    const correction = cell(2, 'age', 'Q047', {
      source: 'rules',
      severity: 'info',
      message: 'recode',
      correction: { before: 999, after: -999 },
    });
    const rules = cell(2, 'age', 'Q001', { source: 'rules', message: 'rule says no' });
    const schemaB = cell(2, 'age', 'schema:prop:age:value');
    const schemaA = cell(2, 'age', 'schema:cond:3:age', { message: 'conditional broke' });
    store.add([rules, schemaB, correction, schemaA]);
    expect(store.byCell(2, 'age').map((e) => e.flag.ruleId)).toEqual([
      'Q047',
      'schema:cond:3:age',
      'schema:prop:age:value',
      'Q001',
    ]);
  });
});

describe('flagStore aggregates', () => {
  it('computes severity totals, corrections count, per-column counts, and per-rule stats', () => {
    const store = createFlagStore();
    store.add([
      cell(0, 'age', 'schema:prop:age:value'),
      cell(1, 'age', 'schema:prop:age:value'),
      cell(1, 'age', 'schema:prop:age:value'), // duplicate of the row-1 flag
      cell(2, 'score', 'Q010', { source: 'rules', severity: 'warning', message: 'suspicious' }),
      cell(3, 'score', 'Q047', {
        source: 'rules',
        severity: 'info',
        message: 'recode',
        correction: { before: 1, after: 2 },
      }),
    ]);
    const summary = store.summary(10);
    expect(summary.severityTotals).toEqual({ error: 3, warning: 1, info: 1 });
    expect(summary.correctionsCount).toBe(1);
    expect(summary.countsByColumn.get('age')).toBe(3);
    expect(summary.countsByColumn.get('score')).toBe(2);
    expect(summary.perRule[0]).toEqual({
      ruleId: 'schema:prop:age:value',
      source: 'schema',
      severity: 'error',
      count: 3,
      rowsAffected: 2, // row 1 counted once despite the duplicate
      pctOfRows: 0.2,
    });
    // Sheet-4 ordering: count desc, then ruleId asc.
    expect(summary.perRule.map((r) => r.ruleId)).toEqual(['schema:prop:age:value', 'Q010', 'Q047']);
  });
});

describe('flagStore cap', () => {
  it('admits errors first by evicting the newest lowest-severity entry, with exact counters', () => {
    const store = createFlagStore({ cap: 4 });
    store.add([
      cell(0, 'a', 'I1', { severity: 'info', message: 'i1' }),
      cell(1, 'a', 'I2', { severity: 'info', message: 'i2' }),
      cell(2, 'a', 'W1', { severity: 'warning', message: 'w1' }),
      cell(3, 'a', 'W2', { severity: 'warning', message: 'w2' }),
    ]);
    expect(store.summary().truncated).toBe(false);

    // At cap: an error evicts the newest info (I2), then the next evicts I1.
    store.add([cell(4, 'a', 'E1', { message: 'e1' }), cell(5, 'a', 'E2', { message: 'e2' })]);
    // A warning at cap with no info left below it is counted, not materialized.
    store.add([cell(6, 'a', 'W3', { severity: 'warning', message: 'w3' })]);
    // An info at cap is always counted-only.
    store.add([cell(7, 'a', 'I3', { severity: 'info', message: 'i3' })]);

    const materialized = store.all().map((e) => e.flag.ruleId);
    expect(materialized).toEqual(['W1', 'W2', 'E1', 'E2']);
    const summary = store.summary();
    expect(summary.materializedCount).toBe(4);
    expect(summary.truncated).toBe(true);
    // Counters stay exact past the cap.
    expect(summary.totalCount).toBe(8);
    expect(summary.severityTotals).toEqual({ error: 2, warning: 3, info: 3 });
    expect(summary.countsByRuleId.get('W3')).toBe(1);
    expect(summary.countsByRuleId.get('I3')).toBe(1);
  });

  it('an error still displaces a warning when only warnings remain', () => {
    const store = createFlagStore({ cap: 2 });
    store.add([
      cell(0, 'a', 'W1', { severity: 'warning', message: 'w1' }),
      cell(1, 'a', 'W2', { severity: 'warning', message: 'w2' }),
      cell(2, 'a', 'E1', { message: 'e1' }),
    ]);
    expect(store.all().map((e) => e.flag.ruleId)).toEqual(['W1', 'E1']);
  });
});

describe('flagStore determinism', () => {
  it('yields identical iteration order for shuffled input batches', () => {
    const flags: QCFlag[] = [];
    for (let row = 0; row < 20; row++) {
      flags.push(cell(row, 'age', 'schema:prop:age:value', { message: `m${String(row)}` }));
      flags.push(cell(row, 'score', 'Q001', { source: 'rules', message: `r${String(row)}` }));
    }
    const a = createFlagStore();
    a.add(flags);
    const b = createFlagStore();
    for (const f of shuffled(flags, 42)) b.add([f]);
    const key = (e: { flag: QCFlag }): string => `${String(e.flag.row)}|${e.flag.column ?? ''}|${e.flag.ruleId}`;
    expect(b.all().map(key)).toEqual(a.all().map(key));
  });
});

describe('flagStore lifecycle', () => {
  it('notifies subscribers on add and clear; clear resets everything', () => {
    const store = createFlagStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.add([cell(0, 'age', 'schema:prop:age:value')]);
    store.add([]); // empty batch → no notification
    store.clear();
    expect(calls).toBe(2);
    expect(store.all()).toHaveLength(0);
    expect(store.summary().totalCount).toBe(0);
    unsubscribe();
    store.add([cell(0, 'age', 'schema:prop:age:value')]);
    expect(calls).toBe(2);
  });
});
