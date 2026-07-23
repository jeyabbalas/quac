// T-JS-SANDBOX (phase-13 §Verification) — the QuickJS sandbox on node
// (quickjs-emscripten runs in node; the browser tier re-smokes it in
// jsSandbox.browser.test.ts). Direct sandbox mechanics here; the
// engine-integrated scenarios (H006 through runQC, kill-switches as broken
// rules, error-rate policy) live in the sibling describe blocks below.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRuleFile } from '../../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../../src/core/rules/sandbox';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');

/** The committed H006 arrow-function source (multi-line, inline comment). */
const H006_SOURCE = (() => {
  const text = readFileSync(resolve(FIXTURES, 'hesp/rules/hesp_corrections.quac.csv'), 'utf8');
  const rule = parseRuleFile(text, 'hesp_corrections.quac.csv').file.rules.find(
    (r) => r.ruleId === 'H006',
  );
  if (rule === undefined) throw new Error('fixture rule H006 not found');
  return rule.updateExpression;
})();

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
