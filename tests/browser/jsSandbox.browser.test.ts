/**
 * P13 browser tier — two halves, ORDER MATTERS within this file (its iframe
 * owns a fresh module graph + performance timeline):
 *
 * 1. Lazy-chunk proof (first, before anything touches sandbox.ts): linting a
 *    rules file WITHOUT js rules never requests the quickjs chunk; loading one
 *    WITH a js rule (H006) triggers exactly one load — asserted both at the
 *    network level (performance resource entries) and at the loader memo
 *    (sandboxLoadCount).
 * 2. Sandbox smoke on the real browser wasm: compileCheck, H006 normalize,
 *    ambient-authority typeofs, the interrupt kill-switch. The engine-through-
 *    hardened-bridge half of the browser smoke lives in
 *    rulesExec.browser.test.ts (H006 is in the parity manifest since P13).
 */
import { expect, test } from 'vitest';
import { lintRuleFilesWithDataset } from '../../src/core/rules/lint';
import { parseRuleFile } from '../../src/core/rules/parse';
import { loadJSSandbox, sandboxLoadCount } from '../../src/core/rules/sandbox-loader';
import type { JSSandbox } from '../../src/core/rules/types';
import consistencyUrl from '../fixtures/hesp/rules/hesp_consistency.quac.csv?url';
import correctionsUrl from '../fixtures/hesp/rules/hesp_corrections.quac.csv?url';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture fetch failed: ${String(res.status)} ${url}`);
  return res.text();
}

/** Resource-timing entries whose URL mentions quickjs (module or wasm fetch). */
function quickjsResources(): string[] {
  return performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .filter((name) => /quickjs/i.test(name));
}

test('a rules file WITHOUT js rules never requests the quickjs chunk', async () => {
  const consistency = parseRuleFile(await fetchText(consistencyUrl), 'hesp_consistency.quac.csv');
  const results = await lintRuleFilesWithDataset([consistency], null, {
    loadSandbox: loadJSSandbox,
  });
  expect(results[0]?.ruleCount).toBe(5);
  expect(quickjsResources()).toEqual([]);
  expect(sandboxLoadCount()).toBe(0);
});

test('adding a js rule triggers exactly one quickjs load (memoized)', async () => {
  const corrections = parseRuleFile(await fetchText(correctionsUrl), 'hesp_corrections.quac.csv');
  const first = await lintRuleFilesWithDataset([corrections], null, {
    loadSandbox: loadJSSandbox,
  });
  // The compile check really ran in-browser: H006 resolves clean (no js-error,
  // no per-rule pending), only the file-level SQL pending remains.
  const issues = first[0]?.issues ?? [];
  expect(issues.filter((i) => i.code === 'js-error')).toEqual([]);
  expect(issues.filter((i) => i.code === 'pending-data').map((i) => i.message)).toEqual([
    'SQL checks are pending until a dataset is loaded.',
  ]);
  expect(quickjsResources().length).toBeGreaterThan(0);
  expect(sandboxLoadCount()).toBe(1);

  // Re-lint: the memo holds — no second load.
  await lintRuleFilesWithDataset([corrections], null, { loadSandbox: loadJSSandbox });
  expect(sandboxLoadCount()).toBe(1);
});

// ---- sandbox smoke on browser wasm -----------------------------------------

let sandbox: JSSandbox | undefined;

async function sb(): Promise<JSSandbox> {
  sandbox ??= await loadJSSandbox();
  return sandbox;
}

test('compileCheck in-browser: good arrow ok, syntax error reported', async () => {
  expect(await (await sb()).compileCheck('(value, row) => value')).toEqual({ ok: true });
  const bad = await (await sb()).compileCheck('(value, row => {');
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/SyntaxError/);
});

test('H006 normalizes hh-42 in the browser sandbox; undefined leaves unchanged', async () => {
  const corrections = parseRuleFile(await fetchText(correctionsUrl), 'hesp_corrections.quac.csv');
  const h006 = corrections.file.rules.find((r) => r.ruleId === 'H006');
  if (!h006) throw new Error('fixture rule H006 not found');
  const out = await (await sb()).runCorrection(
    h006.updateExpression,
    [{ row: 13, value: 'hh-42', rowData: { __row__: 13, household_id: 'hh-42' } }],
    { timeoutMs: 2000 },
  );
  expect(out).toEqual([{ row: 13, value: 'HH00000042', changed: true }]);
  expect(
    await (await sb()).runCorrection('(value) => undefined', [{ row: 0, value: 'x', rowData: {} }], {
      timeoutMs: 2000,
    }),
  ).toEqual([{ row: 0, value: null, changed: false }]);
});

test('zero ambient authority inside the browser sandbox', async () => {
  const out = await (await sb()).runCorrection(
    `(value) => [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof document].join('/')`,
    [{ row: 0, value: null, rowData: {} }],
    { timeoutMs: 2000 },
  );
  expect(out[0]?.value).toBe('undefined/undefined/undefined/undefined');
});

test('while(true) is killed within the budget in-browser', async () => {
  await expect(
    (await sb()).runCorrection('(value) => { while (true) {} }', [{ row: 0, value: 1, rowData: {} }], {
      timeoutMs: 200,
    }),
  ).rejects.toThrow(/interrupted/);
});
