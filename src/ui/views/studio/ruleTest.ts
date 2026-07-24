/**
 * Live rule test for the Studio preview (P18, qc-rules-engine.md §8): run the
 * draft rule's EXACT engine SQL wrappers against the full `data` view with the
 * preview cap, and report counts + samples. Pure async dispatch — no DOM, no
 * signals — node-tested through the SQLRunner interface.
 *
 * Contract mirrors engine `interpret` + `applicableTargets`:
 * - external, or ANY distinct target missing from the dataset → not-testable
 *   (the engine would skip the rule, so the save gate must not demand a test).
 * - Counts are EXACT (full `data`); only row samples are capped at 20.
 * - Previews NEVER mutate: corrections are pure SELECT count/capture (no
 *   CTAS); js corrections run sandboxed on the ≤20 sample rows only.
 * - Any thrown query/sandbox error → { kind: 'error' } with the message
 *   verbatim (the engine's broken-rule text minus the prefix).
 */
import { expandAssertion, parseAssertion } from '../../../core/rules/assertions';
import { JS_CHUNK_TIMEOUT_MS_DEFAULT, marshalJsValue } from '../../../core/rules/engine';
import {
  correctionCaptureSQL,
  correctionCountSQL,
  datasetCountSQL,
  datasetFetchSQL,
  expandValueToken,
  jsChunkFetchSQL,
  violCountSQL,
  violFetchSQL,
} from '../../../core/rules/sql';
import type { JSSandbox, QCRule, SQLRunner } from '../../../core/rules/types';

export const PREVIEW_ROW_CAP = 20;

export interface RuleTestDeps {
  /** Executes against the canonical `data` view (the dataset lint context's runner). */
  runner: SQLRunner;
  datasetColumns: readonly string[];
  /** Lazy QuickJS source for js correction drafts (app passes loadJSSandbox). */
  loadSandbox?: () => Promise<JSSandbox>;
}

export interface CorrectionCapture {
  target: string;
  row: number;
  before: unknown;
  after: unknown;
  /** js sample rows whose user function threw (after stays undefined). */
  error?: string;
}

export type AssertTargetResult = { target: string; sql: string } & (
  | { aggregate: { count: number; lo: number; hi: number; pass: boolean } }
  | { count: number; rows: Record<string, unknown>[]; truncated: boolean }
);

export type RuleTestResult =
  | {
      kind: 'validate';
      count: number;
      columns: string[];
      rows: Record<string, unknown>[];
      truncated: boolean;
    }
  | { kind: 'assert'; perTarget: AssertTargetResult[] }
  | {
      kind: 'correction';
      /** sql: exact changed cells; js: exact condition-matching rows per pair. */
      count: number;
      captures: CorrectionCapture[];
      /** True for js — captures come from the ≤20-row sample only. */
      sampleOnly: boolean;
      /** Rows the sandbox actually ran on (0 for sql — captures are exact). */
      sampledRows: number;
      sampleErrors: number;
    }
  | {
      kind: 'dataset';
      count: number;
      columns: string[];
      rows: Record<string, unknown>[];
      truncated: boolean;
    }
  | { kind: 'not-testable'; reason: string }
  | { kind: 'error'; message: string };

/** First column of the first row (COUNT results come back as `count_star()`). */
function firstScalar(rows: Record<string, unknown>[]): number {
  const row = rows[0];
  if (row === undefined) return 0;
  return Number(Object.values(row)[0] ?? 0);
}

async function testValidate(
  rule: QCRule,
  targets: string[],
  deps: RuleTestDeps,
): Promise<RuleTestResult> {
  const count = firstScalar(await deps.runner.query(violCountSQL(rule.condition)));
  const rows =
    count === 0
      ? []
      : await deps.runner.query(violFetchSQL(rule.condition, targets, PREVIEW_ROW_CAP));
  return {
    kind: 'validate',
    count,
    columns: ['__row__', ...targets],
    rows,
    truncated: count > PREVIEW_ROW_CAP,
  };
}

async function testAssert(
  rule: QCRule,
  targets: string[],
  deps: RuleTestDeps,
): Promise<RuleTestResult> {
  const parsed = parseAssertion(rule.condition);
  if (!parsed.ok) throw new Error(parsed.error);
  const perTarget: AssertTargetResult[] = [];
  for (const target of targets) {
    const exp = expandAssertion(parsed.assertion, target);
    if (exp.kind === 'column-aggregate') {
      const n = firstScalar(await deps.runner.query(exp.countSql));
      perTarget.push({
        target,
        sql: exp.countSql,
        aggregate: { count: n, lo: exp.lo, hi: exp.hi, pass: n >= exp.lo && n <= exp.hi },
      });
    } else {
      const count = firstScalar(await deps.runner.query(violCountSQL(exp.sql)));
      const rows =
        count === 0
          ? []
          : await deps.runner.query(violFetchSQL(exp.sql, [target], PREVIEW_ROW_CAP));
      perTarget.push({ target, sql: exp.sql, count, rows, truncated: count > PREVIEW_ROW_CAP });
    }
  }
  return { kind: 'assert', perTarget };
}

/** SQL correction: exact per-pair change counts + `__row__|before|after`
 *  captures, exactly the engine's pre-swap reads — the CTAS never runs. */
async function testSqlCorrection(rule: QCRule, deps: RuleTestDeps): Promise<RuleTestResult> {
  let count = 0;
  const captures: CorrectionCapture[] = [];
  for (const pair of expandValueToken(rule)) {
    const n = firstScalar(
      await deps.runner.query(correctionCountSQL(pair.condition, pair.expression, pair.target)),
    );
    count += n;
    if (n === 0) continue;
    const rows = await deps.runner.query(
      correctionCaptureSQL(pair.condition, pair.expression, pair.target, PREVIEW_ROW_CAP),
    );
    for (const row of rows) {
      captures.push({
        target: pair.target,
        row: Number(row.__row__),
        before: row.before,
        after: row.after,
      });
    }
  }
  return { kind: 'correction', count, captures, sampleOnly: false, sampledRows: 0, sampleErrors: 0 };
}

/** js correction: exact match counts from SQL; the user function runs
 *  sandboxed on the first ≤20 matching rows per pair only. */
async function testJsCorrection(rule: QCRule, deps: RuleTestDeps): Promise<RuleTestResult> {
  if (deps.loadSandbox === undefined) {
    throw new Error('JS corrections require the QuickJS sandbox; rule not executed');
  }
  const sandbox = await deps.loadSandbox();
  let count = 0;
  let sampledRows = 0;
  let sampleErrors = 0;
  let firstError: string | null = null;
  const captures: CorrectionCapture[] = [];
  for (const pair of expandValueToken(rule)) {
    count += firstScalar(await deps.runner.query(violCountSQL(pair.condition)));
    const chunk: Record<string, unknown>[] = await deps.runner.query(
      jsChunkFetchSQL(pair.condition, -1, PREVIEW_ROW_CAP),
    );
    if (chunk.length === 0) continue;
    const batch = chunk.map((row) => {
      const rowData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (key === '__qc_hit__') continue;
        rowData[key] = marshalJsValue(value);
      }
      return { row: Number(row.__row__), value: marshalJsValue(row[pair.target]), rowData };
    });
    sampledRows += batch.length;
    const results = await sandbox.runCorrection(pair.expression, batch, {
      timeoutMs: JS_CHUNK_TIMEOUT_MS_DEFAULT,
    });
    for (const [i, result] of results.entries()) {
      if (result.error !== undefined) {
        sampleErrors += 1;
        firstError ??= result.error;
        captures.push({
          target: pair.target,
          row: result.row,
          before: batch[i]?.value,
          after: undefined,
          error: result.error,
        });
        continue;
      }
      // `value === undefined` covers JSON-unrepresentable returns — treated
      // as unchanged, like the engine does.
      if (!result.changed || result.value === undefined) continue;
      captures.push({
        target: pair.target,
        row: result.row,
        before: batch[i]?.value,
        after: result.value,
      });
    }
  }
  if (sampledRows > 0 && sampleErrors === sampledRows) {
    throw new Error(
      `JS correction failed on all ${String(sampledRows)} sampled rows; ` +
        `first error: ${firstError ?? 'unknown'}`,
    );
  }
  return { kind: 'correction', count, captures, sampleOnly: true, sampledRows, sampleErrors };
}

async function testDataset(rule: QCRule, deps: RuleTestDeps): Promise<RuleTestResult> {
  // The engine's cap+1 idiom: the exact count query runs only on overflow —
  // when the fetch fits, its length already IS the exact count.
  const fetched = await deps.runner.query(datasetFetchSQL(rule.condition, PREVIEW_ROW_CAP + 1));
  const rows = fetched.slice(0, PREVIEW_ROW_CAP);
  const truncated = fetched.length > PREVIEW_ROW_CAP;
  const count = truncated
    ? firstScalar(await deps.runner.query(datasetCountSQL(rule.condition)))
    : rows.length;
  const first = rows[0];
  return {
    kind: 'dataset',
    count,
    columns: first === undefined ? [] : Object.keys(first),
    rows,
    truncated,
  };
}

export async function runRuleTest(draft: QCRule, deps: RuleTestDeps): Promise<RuleTestResult> {
  if (draft.ruleType === 'external') {
    return {
      kind: 'not-testable',
      reason: 'External rules are loaded and listed, never executed.',
    };
  }
  // DISTINCT targets + the exact-name applicability gate (engine §7): a rule
  // the engine would skip must not be testable — the gate falls back to
  // "Save untested" instead.
  const targets = [...new Set(draft.targetVariables)];
  const missing = targets.filter((t) => !deps.datasetColumns.includes(t));
  if (missing.length > 0) {
    return {
      kind: 'not-testable',
      reason:
        `Target column${missing.length === 1 ? '' : 's'} not in this dataset: ` +
        `${missing.join(', ')} — the engine skips this rule.`,
    };
  }
  try {
    if (draft.ruleType === 'correct') {
      return draft.updateLanguage === 'js'
        ? await testJsCorrection(draft, deps)
        : await testSqlCorrection(draft, deps);
    }
    if (draft.ruleScope === 'dataset') return await testDataset(draft, deps);
    if (draft.ruleScope === 'column') return await testAssert(draft, targets, deps);
    // row + longitudinal execute identically (uniform SELECT-list wrapping).
    return await testValidate(draft, targets, deps);
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
