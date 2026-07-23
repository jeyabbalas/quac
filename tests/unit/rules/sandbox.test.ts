// T-JS-SANDBOX (phase-13 §Verification) — the QuickJS sandbox on node
// (quickjs-emscripten runs in node; the browser tier re-smokes it in
// jsSandbox.browser.test.ts). Direct sandbox mechanics here; the
// engine-integrated scenarios (H006 through runQC, kill-switches as broken
// rules, error-rate policy) live in the sibling describe blocks below.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QCFlag } from '../../../src/core/flags/flag';
import { runQC } from '../../../src/core/rules/engine';
import { parseRuleFile } from '../../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../../src/core/rules/sandbox';
import type { QCRule, RuleFile } from '../../../src/core/rules/types';
import { openDuckDb, openQcTyped, type QcFixtureDb } from './support';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');

const loadRules = (rel: string): RuleFile => {
  const name = rel.split('/').pop() ?? rel;
  return parseRuleFile(readFileSync(resolve(FIXTURES, rel), 'utf8'), name).file;
};

const KEYS = loadRules('hesp/rules/hesp_keys_and_structure.quac.csv');
const CONSISTENCY = loadRules('hesp/rules/hesp_consistency.quac.csv');
const CORRECTIONS = loadRules('hesp/rules/hesp_corrections.quac.csv');

/** The committed H006 arrow-function source (multi-line, inline comment). */
const H006_SOURCE = (() => {
  const rule = CORRECTIONS.rules.find((r) => r.ruleId === 'H006');
  if (rule === undefined) throw new Error('fixture rule H006 not found');
  return rule.updateExpression;
})();

const pick = (...ruleIds: string[]): RuleFile[] => {
  const all = [...KEYS.rules, ...CONSISTENCY.rules, ...CORRECTIONS.rules];
  const rules = ruleIds.map((id) => {
    const rule = all.find((r) => r.ruleId === id);
    if (rule === undefined) throw new Error(`fixture rule ${id} not found`);
    return rule;
  });
  return [{ name: 'picked.quac.csv', group: 'picked', rules, extraColumns: [] }];
};

const makeJsRule = (overrides: Partial<QCRule>): QCRule => ({
  ruleId: 'J001',
  ruleType: 'correct',
  ruleScope: 'row',
  targetVariables: ['v'],
  condition: 'TRUE',
  updateLanguage: 'js',
  updateExpression: '(value) => value',
  severity: 'info',
  comment: 'Test js correction.',
  enabled: true,
  sourceFile: 'inline.quac.csv',
  rowNumber: 1,
  extras: {},
  ...overrides,
});

const inline = (...rules: QCRule[]): RuleFile[] => [
  { name: 'inline.quac.csv', group: 'inline', rules, extraColumns: [] },
];

const correctionFlags = (flags: QCFlag[]): QCFlag[] =>
  flags.filter((f) => f.correction !== undefined);

const scalar = async (db: QcFixtureDb, sql: string): Promise<unknown> => {
  const rows = await db.runner.query(sql);
  return Object.values(rows[0] ?? {})[0];
};

const sandbox = createQuickJSSandbox();

const batchRow = (
  row: number,
  value: unknown,
  rowData: Record<string, unknown> = {},
): { row: number; value: unknown; rowData: Record<string, unknown> } => ({
  row,
  value,
  rowData: { __row__: row, ...rowData },
});

const BUDGET = { timeoutMs: 2000 };

describe('createQuickJSSandbox — compileCheck', () => {
  it('accepts the committed H006 arrow function (multi-line, inline comment)', async () => {
    expect(await sandbox.compileCheck(H006_SOURCE)).toEqual({ ok: true });
  });

  it('accepts a function source ending in a line comment (newline wrap)', async () => {
    expect(await sandbox.compileCheck('(value, row) => value // normalize later')).toEqual({
      ok: true,
    });
  });

  it('reports syntax errors with the raw QuickJS message', async () => {
    const result = await sandbox.compileCheck('(value, row => {');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SyntaxError/);
  });

  it('rejects expressions that do not evaluate to a function', async () => {
    const result = await sandbox.compileCheck('42');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must evaluate to a function/);
  });

  it('kills a compile-time infinite loop within its own deadline', async () => {
    const bomb = createQuickJSSandbox({ compileDeadlineMs: 100 });
    const result = await bomb.compileCheck('(() => { while (true) {} })()');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/interrupted/);
  });
});

describe('createQuickJSSandbox — runCorrection', () => {
  it('H006 normalizes legacy household ids; non-undefined returns are changed', async () => {
    const out = await sandbox.runCorrection(
      H006_SOURCE,
      [
        batchRow(13, 'hh-42'),
        batchRow(14, 'HH 00000042'),
        // H006 returns `value` (not undefined) for unrecognized formats — the
        // sandbox reports changed:true and SQL-side no-op suppression drops it.
        batchRow(15, 'UNKNOWN-9'),
      ],
      BUDGET,
    );
    expect(out).toEqual([
      { row: 13, value: 'HH00000042', changed: true },
      { row: 14, value: 'HH00000042', changed: true },
      { row: 15, value: 'UNKNOWN-9', changed: true },
    ]);
  });

  it('undefined return ⇒ changed:false; null return ⇒ changed:true with null', async () => {
    expect(
      await sandbox.runCorrection('(value) => undefined', [batchRow(0, 'x')], BUDGET),
    ).toEqual([{ row: 0, value: null, changed: false }]);
    expect(await sandbox.runCorrection('(value) => null', [batchRow(0, 'x')], BUDGET)).toEqual([
      { row: 0, value: null, changed: true },
    ]);
  });

  it('receives the full row object; rowData is frozen against writes', async () => {
    const out = await sandbox.runCorrection(
      '(value, row) => { row.wave = 99; return String(row.wave) + "/" + String(row.household_id); }',
      [batchRow(3, 'hh-42', { wave: 2, household_id: 'hh-42' })],
      BUDGET,
    );
    // Sloppy-mode writes to a frozen object are silently ignored.
    expect(out).toEqual([{ row: 3, value: '2/hh-42', changed: true }]);
  });

  it('has zero ambient authority: fetch/XMLHttpRequest/WebSocket/require undefined', async () => {
    const out = await sandbox.runCorrection(
      `(value) => [
         typeof fetch, typeof XMLHttpRequest, typeof WebSocket,
         typeof globalThis.require, typeof setTimeout,
       ].join('/')`,
      [batchRow(0, null)],
      BUDGET,
    );
    expect(out[0]?.value).toBe('undefined/undefined/undefined/undefined/undefined');
  });

  it('captures per-row exceptions without aborting the chunk', async () => {
    const out = await sandbox.runCorrection(
      '(value, row) => { if (row.__row__ === 1) throw new TypeError("boom"); return value; }',
      [batchRow(0, 'a'), batchRow(1, 'b'), batchRow(2, 'c')],
      BUDGET,
    );
    expect(out).toEqual([
      { row: 0, value: 'a', changed: true },
      { row: 1, value: null, changed: false, error: 'TypeError: boom' },
      { row: 2, value: 'c', changed: true },
    ]);
  });

  it('while(true) is killed within the chunk budget (fatal reject)', async () => {
    await expect(
      sandbox.runCorrection('(value) => { while (true) {} }', [batchRow(0, 1)], {
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/interrupted/);
  });

  it('an allocation bomb hits the memory cap cleanly (fatal reject)', async () => {
    const small = createQuickJSSandbox({ memoryLimitBytes: 16 * 1024 * 1024 });
    await expect(
      small.runCorrection(
        // The driver's per-row catch rethrows InternalError — without that,
        // OOM would be swallowed as an ordinary per-row error (spike finding).
        `(value) => { const a = []; while (true) { a.push(new Array(65536).fill('x')); } }`,
        [batchRow(0, 1)],
        { timeoutMs: 10_000 },
      ),
    ).rejects.toThrow(/out of memory/);
  });

  it('a guest that swallows its own OOM stays inside the memory cap', async () => {
    const small = createQuickJSSandbox({ memoryLimitBytes: 16 * 1024 * 1024 });
    // Guest try/catch CAN observe the OOM InternalError before the driver does
    // (its allocation failed — the cap held; the wasm heap never grows past
    // setMemoryLimit). It only gets to return an ordinary value; a retry loop
    // would die at the interrupt deadline. Documented containment behavior.
    const out = await small.runCorrection(
      `(value) => {
         try { const a = []; while (true) { a.push(new Array(65536).fill('x')); } }
         catch (e) { return 'swallowed:' + (e instanceof InternalError); }
       }`,
      [batchRow(0, 1)],
      { timeoutMs: 10_000 },
    );
    expect(out).toEqual([{ row: 0, value: 'swallowed:true', changed: true }]);
  });

  it('an empty batch resolves without booting a context', async () => {
    expect(await sandbox.runCorrection('(value) => value', [], BUDGET)).toEqual([]);
  });

  it('a non-function expression rejects the chunk (engine breaks the rule)', async () => {
    await expect(sandbox.runCorrection('(value, row => {', [batchRow(0, 1)], BUDGET)).rejects.toThrow(
      /SyntaxError/,
    );
  });
});

// ---- engine-integrated scenarios (runQC with a real sandbox) ---------------

describe('runQC js corrections (T-JS-SANDBOX engine path)', () => {
  it('H006 golden — normalizes hh-42 on the fixture; second run is a no-op', async () => {
    const db = await openQcTyped();
    try {
      const run1 = await runQC(db.runner, pick('H006'), { jsSandbox: sandbox });
      expect(run1.flags).toEqual([
        {
          source: 'rules',
          ruleId: 'H006',
          scope: 'cell',
          row: 13,
          column: 'household_id',
          severity: 'info',
          message:
            "Legacy household_id formats (e.g. 'hh-42', 'HH 00000042') normalized to canonical HH######## via regex capture groups.",
          value: 'hh-42',
          correction: { before: 'hh-42', after: 'HH00000042' },
        },
      ]);
      expect(run1.perRule).toEqual([
        expect.objectContaining({
          ruleId: 'H006',
          status: 'ok',
          violationCount: 1,
          changedCells: 1,
          flagsEmitted: 1,
          truncated: false,
        }),
      ]);
      expect(run1.correctedCells).toBe(1);
      expect(await scalar(db, 'SELECT household_id FROM quac_work WHERE __row__ = 13')).toBe(
        'HH00000042',
      );
      // Other rows untouched; staging tables cleaned up.
      expect(await scalar(db, 'SELECT household_id FROM quac_work WHERE __row__ = 0')).toBe(
        'HH00000001',
      );
      expect(
        await scalar(
          db,
          "SELECT COUNT(*) FROM duckdb_tables() WHERE table_name LIKE '__qc_updates%'",
        ),
      ).toBe(0);

      // Idempotence: promote the corrected data to quac_typed and re-run —
      // the condition no longer matches, so zero flags and zero changes.
      await db.runner.query('CREATE OR REPLACE TABLE quac_typed AS SELECT * FROM quac_work');
      const run2 = await runQC(db.runner, pick('H006'), { jsSandbox: sandbox });
      expect(run2.flags).toEqual([]);
      expect(run2.correctedCells).toBe(0);
    } finally {
      db.close();
    }
  });

  it('undefined return leaves cells unchanged and emits no flags', async () => {
    const db = await openDuckDb([
      "CREATE TABLE quac_typed AS SELECT range AS __row__, 'x' || CAST(range AS VARCHAR) AS v FROM range(3)",
    ]);
    try {
      const { flags, perRule, correctedCells } = await runQC(
        db.runner,
        inline(makeJsRule({ updateExpression: '(value) => undefined' })),
        { jsSandbox: sandbox },
      );
      expect(flags).toEqual([]);
      expect(perRule[0]).toMatchObject({
        ruleId: 'J001',
        status: 'ok',
        violationCount: 0,
        changedCells: 0,
        flagsEmitted: 0,
      });
      expect(correctedCells).toBe(0);
      expect(await scalar(db, 'SELECT v FROM quac_work WHERE __row__ = 1')).toBe('x1');
    } finally {
      db.close();
    }
  });

  it('null return writes SQL NULL', async () => {
    const db = await openDuckDb([
      "CREATE TABLE quac_typed (__row__ BIGINT, v VARCHAR)",
      "INSERT INTO quac_typed VALUES (0, 'keep-null'), (1, 'other')",
    ]);
    try {
      const { flags, correctedCells } = await runQC(
        db.runner,
        inline(
          makeJsRule({
            condition: "v = 'keep-null'",
            updateExpression: '(value) => null',
          }),
        ),
        { jsSandbox: sandbox },
      );
      expect(correctionFlags(flags)).toEqual([
        expect.objectContaining({
          row: 0,
          column: 'v',
          correction: { before: 'keep-null', after: null },
        }),
      ]);
      expect(correctedCells).toBe(1);
      expect(await scalar(db, 'SELECT v IS NULL FROM quac_work WHERE __row__ = 0')).toBe(true);
      expect(await scalar(db, 'SELECT v FROM quac_work WHERE __row__ = 1')).toBe('other');
    } finally {
      db.close();
    }
  });

  it('SQL-side no-op suppression — same-value and cast-normalized returns are not corrections', async () => {
    const db = await openDuckDb([
      'CREATE TABLE quac_typed (__row__ BIGINT, v BIGINT)',
      'INSERT INTO quac_typed VALUES (0, 7), (1, 42)',
    ]);
    try {
      // Row 0: 7 → '8' (real change). Row 1: 42 → '042' — CAST('042' AS
      // BIGINT) = 42, so the sandbox's changed:true is suppressed SQL-side.
      const { flags, correctedCells } = await runQC(
        db.runner,
        inline(makeJsRule({ updateExpression: `(value) => value === 7 ? '8' : '0' + String(value)` })),
        { jsSandbox: sandbox },
      );
      expect(correctionFlags(flags)).toEqual([
        expect.objectContaining({ row: 0, correction: { before: 7, after: 8 } }),
      ]);
      expect(correctedCells).toBe(1);
      expect(await scalar(db, 'SELECT v FROM quac_work WHERE __row__ = 1')).toBe(42);
    } finally {
      db.close();
    }
  });

  it('while(true) is killed within the chunk budget — rule broken, run continues', async () => {
    const db = await openQcTyped();
    try {
      const { flags, perRule } = await runQC(
        db.runner,
        [
          ...inline(
            makeJsRule({
              ruleId: 'J_SPIN',
              targetVariables: ['household_id'],
              updateExpression: '(value) => { while (true) {} }',
            }),
          ),
          ...pick('Q047'),
        ],
        { jsSandbox: sandbox, jsChunkTimeoutMs: 50 },
      );
      expect(perRule[0]).toMatchObject({ ruleId: 'J_SPIN', status: 'broken' });
      expect(perRule[0]?.error).toMatch(/interrupted/);
      expect(flags.filter((f) => f.ruleId === 'J_SPIN')).toEqual([
        expect.objectContaining({ scope: 'dataset', severity: 'error' }),
      ]);
      // The run continued and the table only reflects the healthy rule.
      expect(perRule[1]).toMatchObject({ ruleId: 'Q047', status: 'ok', changedCells: 1 });
      expect(await scalar(db, 'SELECT household_id FROM quac_work WHERE __row__ = 13')).toBe(
        'hh-42',
      );
    } finally {
      db.close();
    }
  });

  it('allocation bomb hits the memory cap — rule broken, table untouched', async () => {
    const db = await openQcTyped();
    try {
      const small = createQuickJSSandbox({ memoryLimitBytes: 16 * 1024 * 1024 });
      const { perRule } = await runQC(
        db.runner,
        inline(
          makeJsRule({
            ruleId: 'J_BOMB',
            targetVariables: ['household_id'],
            updateExpression:
              `(value) => { const a = []; while (true) { a.push(new Array(65536).fill('x')); } }`,
          }),
        ),
        // Generous deadline so the MEMORY cap fires first even on slow CI
        // runners — with the 2 s default the interrupt can win the race there.
        { jsSandbox: small, jsChunkTimeoutMs: 10_000 },
      );
      expect(perRule[0]).toMatchObject({ ruleId: 'J_BOMB', status: 'broken' });
      expect(perRule[0]?.error).toMatch(/out of memory/);
      expect(await scalar(db, 'SELECT household_id FROM quac_work WHERE __row__ = 13')).toBe(
        'hh-42',
      );
    } finally {
      db.close();
    }
  });

  it('row failures under 1% — up to 50 warning flags plus an overflow summary', async () => {
    // 6000 matching rows in 2 keyset chunks; every 109th row throws → 56
    // failures (0.93%): the rule survives, corrections still apply elsewhere.
    const db = await openDuckDb([
      'CREATE TABLE quac_typed AS SELECT range AS __row__, CAST(range AS INTEGER) AS v FROM range(6000)',
    ]);
    try {
      const { flags, perRule } = await runQC(
        db.runner,
        inline(
          makeJsRule({
            updateExpression:
              '(value, row) => { if (row.__row__ % 109 === 0) throw new Error("bad row"); return undefined; }',
          }),
        ),
        { jsSandbox: sandbox },
      );
      expect(perRule[0]).toMatchObject({ ruleId: 'J001', status: 'ok', changedCells: 0 });
      const errorFlags = flags.filter((f) => f.message.startsWith('JS error on row'));
      expect(errorFlags).toHaveLength(50);
      expect(errorFlags[0]).toMatchObject({
        scope: 'cell',
        row: 0,
        column: 'v',
        severity: 'warning',
        message: 'JS error on row 0: Error: bad row',
        value: 0,
      });
      expect(flags.at(-1)).toMatchObject({
        scope: 'column',
        column: 'v',
        message: '…and 6 more JS errors from this rule',
      });
      expect(perRule[0]?.flagsEmitted).toBe(51);
    } finally {
      db.close();
    }
  });

  it('row failures over 1% — rule broken at the chunk boundary, flags discarded', async () => {
    // Every 89th row throws → 57 failures in the first 5000-row chunk (>50).
    const db = await openDuckDb([
      'CREATE TABLE quac_typed AS SELECT range AS __row__, CAST(range AS INTEGER) AS v FROM range(6000)',
    ]);
    try {
      const { flags, perRule } = await runQC(
        db.runner,
        inline(
          makeJsRule({
            updateExpression:
              '(value, row) => { if (row.__row__ % 89 === 0) throw new Error("bad row"); return String(value); }',
          }),
        ),
        { jsSandbox: sandbox },
      );
      expect(perRule[0]).toMatchObject({ ruleId: 'J001', status: 'broken' });
      expect(perRule[0]?.error).toMatch(/over the 1% limit/);
      // All-or-nothing: only the single broken-rule dataset flag survives.
      expect(flags).toEqual([
        expect.objectContaining({ scope: 'dataset', severity: 'error', ruleId: 'J001' }),
      ]);
      expect(await scalar(db, 'SELECT v FROM quac_work WHERE __row__ = 1')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('cumulative sandbox budget — rule broken once jsRuleTimeoutMs is exhausted', async () => {
    const db = await openDuckDb([
      'CREATE TABLE quac_typed AS SELECT range AS __row__, CAST(range AS INTEGER) AS v FROM range(6000)',
    ]);
    try {
      const { perRule } = await runQC(
        db.runner,
        inline(makeJsRule({ updateExpression: '(value) => undefined' })),
        { jsSandbox: sandbox, jsRuleTimeoutMs: 0 },
      );
      expect(perRule[0]).toMatchObject({ ruleId: 'J001', status: 'broken' });
      expect(perRule[0]?.error).toMatch(/per-rule sandbox budget/);
    } finally {
      db.close();
    }
  });

  it('keyset pagination + capture truncation — 6000 changed rows, capped flags, exact counts', async () => {
    const db = await openDuckDb([
      'CREATE TABLE quac_typed AS SELECT range AS __row__, CAST(range AS INTEGER) AS v FROM range(6000)',
    ]);
    try {
      const { flags, perRule } = await runQC(
        db.runner,
        inline(makeJsRule({ updateExpression: '(value) => value + 1' })),
        { jsSandbox: sandbox, rowCapPerRule: 5 },
      );
      expect(perRule[0]).toMatchObject({
        ruleId: 'J001',
        status: 'ok',
        violationCount: 6000, // EXACT, from the SQL count
        changedCells: 6000,
        flagsEmitted: 6, // 5 cell flags + 1 truncation summary
        truncated: true,
      });
      expect(correctionFlags(flags).map((f) => f.row)).toEqual([0, 1, 2, 3, 4]);
      expect(flags.at(-1)).toMatchObject({
        scope: 'column',
        column: 'v',
        message: '…and 5,995 more rows corrected by this rule',
      });
      // The merge is never capped: both chunk ranges landed.
      expect(await scalar(db, 'SELECT v FROM quac_work WHERE __row__ = 0')).toBe(1);
      expect(await scalar(db, 'SELECT v FROM quac_work WHERE __row__ = 5999')).toBe(6000);
    } finally {
      db.close();
    }
  });

  it('full catalog with a sandbox — H006 corrects, H001 sees clean data, Q003 catches the mismatch', async () => {
    const db = await openQcTyped();
    try {
      const { perRule, correctedCells } = await runQC(
        db.runner,
        [KEYS, CONSISTENCY, CORRECTIONS],
        { jsSandbox: sandbox },
      );
      const byId = new Map(perRule.map((s) => [s.ruleId, s]));
      expect(byId.get('H006')).toMatchObject({ status: 'ok', changedCells: 1 });
      // Post-correction interplay: household_id is now canonical (H001 clean),
      // but record_id still carries the legacy prefix — Q003 flags row 13 too.
      expect(byId.get('H001')).toMatchObject({ status: 'ok', violationCount: 0 });
      expect(byId.get('Q003')).toMatchObject({ status: 'ok', violationCount: 2 });
      expect(correctedCells).toBe(5);
    } finally {
      db.close();
    }
  });
});
