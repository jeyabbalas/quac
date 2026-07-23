/**
 * P12: representative fixture rules through the REAL hardened bridge produce
 * the same flags as the node run — both tiers pin the shared parity manifest
 * from tests/shared/qcFixtureSql.ts over the same seeded rows. Also proves
 * on wasm: the V14 via-view CREATE OR REPLACE swap (post-correction row
 * content) and the EXPLAIN round-trip lint stage 4 builds on.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { createBridge } from '../../src/core/bridge/bridge';
import { hardenBridge } from '../../src/core/bridge/harden';
import { createBridgeRunner, runQC } from '../../src/core/rules/engine';
import { lintRuleFilesWithDataset } from '../../src/core/rules/lint';
import { parseRuleFile, type ParsedRuleFile } from '../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../src/core/rules/sandbox';
import type { RuleFile } from '../../src/core/rules/types';
import {
  PARITY_RULE_IDS,
  expectedParityResult,
  qcFixtureSetupSql,
} from '../shared/qcFixtureSql';
import consistencyUrl from '../fixtures/hesp/rules/hesp_consistency.quac.csv?url';
import correctionsUrl from '../fixtures/hesp/rules/hesp_corrections.quac.csv?url';
import keysUrl from '../fixtures/hesp/rules/hesp_keys_and_structure.quac.csv?url';

let bridge: WorkerBridge | undefined;
const parsedFiles: ParsedRuleFile[] = [];

function b(): WorkerBridge {
  if (!bridge) throw new Error('bridge not initialized');
  return bridge;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture fetch failed: ${String(res.status)} ${url}`);
  return res.text();
}

beforeAll(async () => {
  bridge = await createBridge();
  await hardenBridge(bridge);
  for (const sql of qcFixtureSetupSql('quac_typed')) {
    await bridge.query(sql);
  }
  bridge.clearQueryCache();
  for (const [url, name] of [
    [keysUrl, 'hesp_keys_and_structure.quac.csv'],
    [consistencyUrl, 'hesp_consistency.quac.csv'],
    [correctionsUrl, 'hesp_corrections.quac.csv'],
  ] as const) {
    parsedFiles.push(parseRuleFile(await fetchText(url), name));
  }
}, 120_000);

afterAll(() => {
  bridge?.terminate();
});

const allRules = (): RuleFile['rules'] => parsedFiles.flatMap((p) => p.file.rules);

/** One RuleFile with the named catalog rules in order (node-tier `pick`). */
function pick(...ruleIds: string[]): RuleFile[] {
  const rules = ruleIds.map((id) => {
    const rule = allRules().find((r) => r.ruleId === id);
    if (rule === undefined) throw new Error(`fixture rule ${id} not found`);
    return rule;
  });
  return [{ name: 'picked.quac.csv', group: 'picked', rules, extraColumns: [] }];
}

test('EXPLAIN round-trips through the hardened WorkerBridge (lint stage-4 foundation)', async () => {
  const rows = await b().query(
    'EXPLAIN SELECT COUNT(*) FROM (SELECT (wave > 1) AS viol FROM quac_typed) WHERE viol',
  );
  expect(rows.length).toBeGreaterThan(0);
  await expect(b().query('EXPLAIN SELECT no_such_col FROM quac_typed')).rejects.toThrow(
    /no_such_col/,
  );
});

test('parity: runQC on the hardened bridge produces the node manifest exactly', async () => {
  const runner = createBridgeRunner(b());
  const run = await runQC(runner, pick(...PARITY_RULE_IDS), {
    jsSandbox: createQuickJSSandbox(), // H006 (js) is in the parity set since P13
  });

  const comments = Object.fromEntries(allRules().map((r) => [r.ruleId, r.comment]));
  const expected = expectedParityResult(comments);
  expect(run.flags).toEqual(expected.flags);
  expect(run.perRule.map((s) => [s.ruleId, s.status, s.violationCount])).toEqual(
    expected.perRule,
  );
  expect(run.correctedCells).toBe(expected.correctedCells);

  // V14 via-view swap proven on wasm: the corrected work table holds the new
  // values (the V14 pin read FROM quac_work directly; runQC reads FROM data).
  const rows = await b().query(
    `SELECT __row__::INTEGER AS r, wage_income_annual AS wage, monthly_rent AS rent,
            reference_education AS edu
     FROM quac_work WHERE __row__ IN (7, 8, 9, 11) ORDER BY __row__`,
  );
  expect(rows).toEqual([
    { r: 7, wage: 88000, rent: 1500, edu: 6 },
    { r: 8, wage: -999, rent: 1100, edu: 3 },
    { r: 9, wage: 64000, rent: -666, edu: 4 },
    { r: 11, wage: 46000, rent: -666, edu: 4 },
  ]);
  // The js staged merge landed on wasm too, and its staging tables are gone.
  const h006 = await b().query('SELECT household_id AS h FROM quac_work WHERE __row__ = 13');
  expect(h006).toEqual([{ h: 'HH00000042' }]);
  const staged = await b().query(
    "SELECT COUNT(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name LIKE '__qc_updates%'",
  );
  expect(staged).toEqual([{ n: 0 }]);
  // The durable baseline is untouched (determinism contract).
  const typed = await b().query(
    'SELECT wage_income_annual AS wage FROM quac_typed WHERE __row__ = 8',
  );
  expect(typed).toEqual([{ wage: 999 }]);
});

test('lint stages 4-6 run against the hardened bridge (dry-run + pertinence)', async () => {
  const columns = await b().query<{ column_name: string }>('DESCRIBE quac_typed');
  const results = await lintRuleFilesWithDataset(parsedFiles, {
    runner: b(),
    datasetColumns: columns.map((c) => c.column_name).filter((n) => n !== '__row__'),
  });
  const issues = results.flatMap((r) => r.issues);
  expect(issues.filter((i) => i.code === 'sql-error')).toEqual([]);
  expect(issues.filter((i) => i.code === 'unknown-target').map((i) => i.ruleId)).toEqual([
    'Q021',
    'Q052',
  ]);
  expect(results.map((r) => r.executable)).toEqual([10, 4, 5]);
});
