/**
 * Rules over nested values on native DuckDB — the node half of the shared
 * expectations in tests/shared/nestedRules.ts (the browser half is
 * tests/browser/rulesNested.browser.test.ts).
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runQC } from '../../../src/core/rules/engine';
import { parseRuleFile } from '../../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../../src/core/rules/sandbox';
import {
  NESTED_RULES_CORRECTED_ROWS,
  NESTED_RULES_CORRECTED_SQL,
  NESTED_RULES_CSV,
  NESTED_RULES_EXPECTED_FLAGS,
  NESTED_RULES_SETUP_SQL,
} from '../../shared/nestedRules';
import { openDuckDb } from './support';
import type { QcFixtureDb } from './support';

let db: QcFixtureDb;

beforeAll(async () => {
  db = await openDuckDb(NESTED_RULES_SETUP_SQL);
});

afterAll(() => {
  db.close();
});

test('rules read, correct and select nested values as the JSON they hold', async () => {
  const parsed = parseRuleFile(NESTED_RULES_CSV, 'nested.quac.csv');
  expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
  const run = await runQC(db.runner, [parsed.file], { jsSandbox: createQuickJSSandbox() });
  expect(run.perRule.map((s) => [s.ruleId, s.status, s.violationCount])).toEqual([
    ['N2', 'ok', 2],
    ['N3', 'ok', 1],
    ['N4', 'ok', 2],
    ['N1', 'ok', 1],
    ['N5', 'ok', 1],
    ['N6', 'ok', 1],
  ]);
  expect(run.flags).toEqual(NESTED_RULES_EXPECTED_FLAGS);
  expect(run.correctedCells).toBe(5);
  expect(await db.runner.query(NESTED_RULES_CORRECTED_SQL)).toEqual(NESTED_RULES_CORRECTED_ROWS);
}, 60_000);
