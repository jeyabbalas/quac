/**
 * Rules over nested values on duckdb-wasm, through the real hardened bridge
 * and the QuickJS sandbox — the browser half of tests/shared/nestedRules.ts
 * (the node half is tests/unit/rules/nested.test.ts). Before nested values
 * were read as `to_json` text, this tier showed a date inside a list as epoch
 * milliseconds, and a JavaScript correction could not write a MAP back.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { createBridge } from '../../src/core/bridge/bridge';
import { hardenBridge } from '../../src/core/bridge/harden';
import { createBridgeRunner, runQC } from '../../src/core/rules/engine';
import { parseRuleFile } from '../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../src/core/rules/sandbox';
import {
  NESTED_RULES_CORRECTED_ROWS,
  NESTED_RULES_CORRECTED_SQL,
  NESTED_RULES_CSV,
  NESTED_RULES_EXPECTED_FLAGS,
  NESTED_RULES_SETUP_SQL,
} from '../shared/nestedRules';

let bridge: WorkerBridge | undefined;

function b(): WorkerBridge {
  if (!bridge) throw new Error('bridge not initialized');
  return bridge;
}

beforeAll(async () => {
  bridge = await createBridge();
  await hardenBridge(bridge);
  for (const sql of NESTED_RULES_SETUP_SQL) await bridge.query(sql);
  bridge.clearQueryCache();
}, 120_000);

afterAll(() => {
  bridge?.terminate();
});

test('rules read, correct and select nested values exactly as on Node', async () => {
  const parsed = parseRuleFile(NESTED_RULES_CSV, 'nested.quac.csv');
  const run = await runQC(createBridgeRunner(b()), [parsed.file], {
    jsSandbox: createQuickJSSandbox(),
  });
  expect(run.perRule.filter((s) => s.status !== 'ok')).toEqual([]);
  expect(run.flags).toEqual(NESTED_RULES_EXPECTED_FLAGS);
  expect(run.correctedCells).toBe(5);
  b().clearQueryCache();
  expect(await b().query(NESTED_RULES_CORRECTED_SQL)).toEqual(NESTED_RULES_CORRECTED_ROWS);
}, 120_000);
