// Rules engine — validations phase (qc-rules-engine.md §3 phase 3, §5 caps).
// P12 wraps these internals with runQC (hardening SETs, work-table rebuild,
// corrections phase); P11 executes `validate` rules against the canonical view
// `data` through the SQLRunner abstraction. EngineOptions.workTable /
// applyCorrections / jsSandbox are runQC concerns — validations only read `data`.
//
// Contracts fixed here (recorded in phase-11 Deferred notes):
// - perRule is built in ONE file-order pass (validate + external interleaved),
//   deviating from the §3 pseudocode's externals-appended-last: same stat set,
//   deterministic file order for the report.
// - external → skipped-external unconditionally (even when disabled; §3
//   `for rule in rules(type='external')` has no enabled filter).
// - correct rules get NO stat here — P12's corrections phase owns them.
// - onProgress fires BEFORE each enabled validate rule (inapplicable skips
//   included — they are loop work), index 0-based, total = enabled validate
//   count, phase always 'validate'.
// - violationCount: row/longitudinal = violating ROWS; column asserts = sum of
//   per-target counts (violating cells); count_distinct_in_range = number of
//   violating targets; dataset = returned-row count (exact). broken/skips = 0.
// - Broken rules are all-or-nothing: the rule's buffered flags are discarded
//   and one dataset-scope error flag `Rule failed to execute: …` is emitted;
//   the run continues (§5).
import { parseAssertion, expandAssertion } from './assertions';
import { datasetCountSQL, datasetFetchSQL, violCountSQL, violFetchSQL } from './sql';
import type { EngineOptions, QCRule, RuleFile, RuleRunStat, RunResult, SQLRunner } from './types';
import { computePertinence } from '../pertinence';
import type { QCFlag } from '../flags/flag';

export const ROW_CAP_PER_RULE_DEFAULT = 10_000;
export const DATASET_ROW_CAP_DEFAULT = 200;
/** Mirrors FLAG_CAP_DEFAULT in flags/flagStore.ts (architecture.md §5). */
export const GLOBAL_FLAG_CAP_DEFAULT = 200_000;

// ---- flag sink (engine-internal; the store lives in flags/flagStore.ts) ----

interface FlagSink {
  /** Detail flag (cell/column/dataset finding) — counted against the global cap. */
  emit(flag: QCFlag): void;
  /** Summary/broken flag — bypasses the cap (§5: they ARE the past-cap mechanism). */
  emitSummary(flag: QCFlag): void;
  /** Detail flags withheld by the global cap for the current rule. */
  suppressed(): number;
  /** Deliver the rule's batch to onFlags and the run total; resets per-rule state. */
  flushRule(): { emitted: number };
  /** Broken rule: drop the buffered flags and refund their cap slots. */
  discardRule(): void;
  all(): QCFlag[];
}

function createFlagSink(globalCap: number, onFlags?: (batch: QCFlag[]) => void): FlagSink {
  const flags: QCFlag[] = [];
  let buffer: QCFlag[] = [];
  let admittedTotal = 0;
  let admittedInRule = 0;
  let suppressedInRule = 0;
  return {
    emit(flag: QCFlag): void {
      if (admittedTotal + admittedInRule >= globalCap) {
        suppressedInRule += 1;
        return;
      }
      admittedInRule += 1;
      buffer.push(flag);
    },
    emitSummary(flag: QCFlag): void {
      buffer.push(flag);
    },
    suppressed: (): number => suppressedInRule,
    flushRule(): { emitted: number } {
      const emitted = buffer.length;
      if (buffer.length > 0) {
        flags.push(...buffer);
        onFlags?.(buffer);
      }
      admittedTotal += admittedInRule;
      buffer = [];
      admittedInRule = 0;
      suppressedInRule = 0;
      return { emitted };
    },
    discardRule(): void {
      buffer = [];
      admittedInRule = 0;
      suppressedInRule = 0;
    },
    all: (): QCFlag[] => flags,
  };
}

// ---- helpers ---------------------------------------------------------------

/** First column of the first row (COUNT results come back as `count_star()`). */
function firstScalar(rows: Record<string, unknown>[]): number {
  const row = rows[0];
  if (row === undefined) return 0;
  return Number(Object.values(row)[0] ?? 0);
}

/** Blank comments get the format-§2 fallback so flag messages stay self-contained. */
function flagMessage(rule: QCRule): string {
  return rule.comment.trim() !== '' ? rule.comment : 'Rule condition matched.';
}

/** Message values render like correction values do (flags/messages.ts). */
function formatValue(v: unknown): string {
  if (typeof v === 'string') return `'${v}'`;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/** `wave=1; n_rows=13`-style rendering of a dataset-rule result row (format §9). */
function renderRowPairs(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join('; ');
}

const countFmt = (n: number): string => n.toLocaleString('en-US');

function skipStat(rule: QCRule, status: RuleRunStat['status']): RuleRunStat {
  return {
    ruleId: rule.ruleId,
    status,
    violationCount: 0,
    flagsEmitted: 0,
    truncated: false,
    durationMs: 0,
  };
}

// ---- interpretation dispatch (qc-rules-format.md §4 matrix) ----------------

type Interpretation =
  | { kind: 'rowBool'; conds: { condition: string; targets: string[] }[] }
  | { kind: 'columnAggregate'; aggs: { target: string; countSql: string; lo: number; hi: number }[] }
  | { kind: 'datasetSelect' };

function interpret(rule: QCRule, targets: string[]): Interpretation {
  if (rule.ruleScope === 'dataset') return { kind: 'datasetSelect' };
  if (rule.ruleScope === 'column') {
    const parsed = parseAssertion(rule.condition);
    if (!parsed.ok) throw new Error(parsed.error);
    const expansions = targets.map((t) => ({ target: t, exp: expandAssertion(parsed.assertion, t) }));
    const aggs = expansions.flatMap(({ target, exp }) =>
      exp.kind === 'column-aggregate' ? [{ target, countSql: exp.countSql, lo: exp.lo, hi: exp.hi }] : [],
    );
    if (aggs.length > 0) return { kind: 'columnAggregate', aggs };
    return {
      kind: 'rowBool',
      conds: expansions.map(({ target, exp }) => ({
        condition: exp.kind === 'row-condition' ? exp.sql : '',
        targets: [target],
      })),
    };
  }
  // row + longitudinal execute identically (uniform SELECT-list wrapping).
  return { kind: 'rowBool', conds: [{ condition: rule.condition, targets }] };
}

// ---- per-path execution ----------------------------------------------------

interface ExecOutcome {
  violationCount: number;
  truncated: boolean;
}

async function runRowBool(
  runner: SQLRunner,
  rule: QCRule,
  conds: { condition: string; targets: string[] }[],
  rowCap: number,
  sink: FlagSink,
): Promise<ExecOutcome> {
  let violationCount = 0;
  let truncated = false;
  const message = flagMessage(rule);
  for (const { condition, targets } of conds) {
    const n = firstScalar(await runner.query(violCountSQL(condition)));
    violationCount += n;
    if (n === 0) continue;
    const rows = await runner.query(violFetchSQL(condition, targets, rowCap));
    for (const row of rows) {
      for (const target of targets) {
        sink.emit({
          source: 'rules',
          ruleId: rule.ruleId,
          scope: 'cell',
          row: Number(row.__row__),
          column: target,
          severity: rule.severity,
          message,
          value: row[target],
        });
      }
    }
    if (n > rowCap) {
      truncated = true;
      for (const target of targets) {
        sink.emitSummary({
          source: 'rules',
          ruleId: rule.ruleId,
          scope: 'column',
          column: target,
          severity: rule.severity,
          message: `…and ${countFmt(n - rowCap)} more rows flagged by this rule`,
        });
      }
    }
  }
  return { violationCount, truncated };
}

async function runColumnAggregate(
  runner: SQLRunner,
  rule: QCRule,
  aggs: { target: string; countSql: string; lo: number; hi: number }[],
  sink: FlagSink,
): Promise<ExecOutcome> {
  let violating = 0;
  const message = flagMessage(rule);
  for (const agg of aggs) {
    const n = firstScalar(await runner.query(agg.countSql));
    if (n < agg.lo || n > agg.hi) {
      violating += 1;
      sink.emit({
        source: 'rules',
        ruleId: rule.ruleId,
        scope: 'column',
        column: agg.target,
        severity: rule.severity,
        message: `${message} Found ${String(n)} distinct values.`,
      });
    }
  }
  return { violationCount: violating, truncated: false };
}

async function runDatasetSelect(
  runner: SQLRunner,
  rule: QCRule,
  datasetCap: number,
  sink: FlagSink,
): Promise<ExecOutcome> {
  const message = flagMessage(rule);
  const rows = await runner.query(datasetFetchSQL(rule.condition, datasetCap + 1));
  for (const row of rows.slice(0, datasetCap)) {
    sink.emit({
      source: 'rules',
      ruleId: rule.ruleId,
      scope: 'dataset',
      severity: rule.severity,
      message: `${message} — ${renderRowPairs(row)}`,
    });
  }
  if (rows.length <= datasetCap) {
    return { violationCount: rows.length, truncated: false };
  }
  // Fetch overflowed the cap: get the exact total for the §5 truncation flag
  // (when the fetch fits, its length already IS the exact count — no 2nd query).
  const exact = firstScalar(await runner.query(datasetCountSQL(rule.condition)));
  sink.emitSummary({
    source: 'rules',
    ruleId: rule.ruleId,
    scope: 'dataset',
    severity: rule.severity,
    message: `…and ${countFmt(exact - datasetCap)} more result rows`,
  });
  return { violationCount: exact, truncated: true };
}

async function runValidateRule(
  runner: SQLRunner,
  rule: QCRule,
  targets: string[],
  rowCap: number,
  datasetCap: number,
  sink: FlagSink,
): Promise<ExecOutcome> {
  const interpretation = interpret(rule, targets);
  switch (interpretation.kind) {
    case 'rowBool':
      return runRowBool(runner, rule, interpretation.conds, rowCap, sink);
    case 'columnAggregate':
      return runColumnAggregate(runner, rule, interpretation.aggs, sink);
    case 'datasetSelect':
      return runDatasetSelect(runner, rule, datasetCap, sink);
  }
}

// ---- the validations phase (engine §3 phase 3) -----------------------------

export async function runValidations(
  runner: SQLRunner,
  ruleFiles: RuleFile[],
  opts: EngineOptions = {},
): Promise<RunResult> {
  const rowCap = opts.rowCapPerRule ?? ROW_CAP_PER_RULE_DEFAULT;
  const datasetCap = opts.datasetRowCap ?? DATASET_ROW_CAP_DEFAULT;
  const globalCap = opts.globalFlagCap ?? GLOBAL_FLAG_CAP_DEFAULT;

  // No `data` view (or no runner) is caller error — propagate, not per-rule broken.
  const datasetColumns = (await runner.query<{ column_name: string }>('DESCRIBE data')).map(
    (r) => r.column_name,
  );

  const sink = createFlagSink(globalCap, opts.onFlags);
  const perRule: RuleRunStat[] = [];

  const allRules = ruleFiles.flatMap((f) => f.rules);
  const total = allRules.filter((r) => r.ruleType === 'validate' && r.enabled).length;
  let index = 0;

  for (const rule of allRules) {
    if (rule.ruleType === 'correct') continue; // P12's corrections phase stats these
    if (rule.ruleType === 'external') {
      perRule.push(skipStat(rule, 'skipped-external'));
      continue;
    }
    if (!rule.enabled) {
      perRule.push(skipStat(rule, 'skipped-disabled'));
      continue;
    }

    opts.onProgress?.({ ruleId: rule.ruleId, index, total, phase: 'validate' });
    index += 1;

    const targets = [...new Set(rule.targetVariables)]; // §7: DISTINCT targets
    const pertinence = computePertinence({
      schemaColumns: targets.map((name) => ({ name, required: true })),
      datasetColumns,
    });
    if (pertinence !== null && pertinence.missingRequired.length > 0) {
      perRule.push(skipStat(rule, 'skipped-inapplicable'));
      continue;
    }

    const started = performance.now();
    try {
      const outcome = await runValidateRule(runner, rule, targets, rowCap, datasetCap, sink);
      const suppressed = sink.suppressed();
      if (suppressed > 0) {
        sink.emitSummary({
          source: 'rules',
          ruleId: rule.ruleId,
          scope: 'dataset',
          severity: rule.severity,
          message: `…and ${countFmt(suppressed)} more flags from this rule suppressed (global flag cap reached)`,
        });
      }
      const { emitted } = sink.flushRule();
      perRule.push({
        ruleId: rule.ruleId,
        status: 'ok',
        violationCount: outcome.violationCount,
        flagsEmitted: emitted,
        truncated: outcome.truncated || suppressed > 0,
        durationMs: performance.now() - started,
      });
    } catch (err) {
      sink.discardRule(); // all-or-nothing: no partial flags from a broken rule
      const msg = err instanceof Error ? err.message : String(err);
      sink.emitSummary({
        source: 'rules',
        ruleId: rule.ruleId,
        scope: 'dataset',
        severity: 'error',
        message: `Rule failed to execute: ${msg}`,
      });
      const { emitted } = sink.flushRule();
      perRule.push({
        ruleId: rule.ruleId,
        status: 'broken',
        violationCount: 0,
        flagsEmitted: emitted,
        truncated: false,
        durationMs: performance.now() - started,
        error: msg,
      });
    }
  }

  return { flags: sink.all(), perRule, correctedCells: 0 };
}
