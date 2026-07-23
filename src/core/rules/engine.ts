// Rules engine — runQC orchestration (qc-rules-engine.md §3): work-table
// rebuild, corrections phase (P12), validations phase (P11), shared caps/sink.
// All rule SQL executes against the canonical view `data` through the
// SQLRunner abstraction. The pseudocode's hardening SETs are NOT issued here —
// per Verified fact V6 network is closed in the worker prelude; browser
// callers run hardenBridge() before runQC.
//
// Contracts fixed here (recorded in phase-11/-12 Deferred notes):
// - perRule: corrections stats first (file order over correct rules), then one
//   file-order pass over validate + external (P11 shape unchanged).
// - external → skipped-external unconditionally (even when disabled; §3
//   `for rule in rules(type='external')` has no enabled filter).
// - correct rules get NO stat from runValidations — the corrections phase owns
//   them; in assess-only mode (applyCorrections:false) they get no stats at all.
// - onProgress fires BEFORE each enabled rule (inapplicable skips included —
//   they are loop work), index 0-based, total = enabled count for that phase.
// - violationCount: row/longitudinal = violating ROWS; column asserts = sum of
//   per-target counts (violating cells); count_distinct_in_range = number of
//   violating targets; dataset = returned-row count (exact); corrections =
//   changed CELLS (== changedCells). broken/skips = 0.
// - Broken rules are all-or-nothing: the rule's buffered flags are discarded
//   and one dataset-scope error flag `Rule failed to execute: …` is emitted;
//   the run continues (§5). Correction swaps are single-statement
//   CREATE OR REPLACE CTAS (V14 — no quac_work_next dance), so a failed rule
//   leaves quac_work untouched with nothing to clean up.
// - js correct rules are broken in P12 regardless of opts.jsSandbox (the
//   QuickJS execution path arrives in P13).
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { parseAssertion, expandAssertion } from './assertions';
import {
  correctionCaptureSQL,
  correctionCountSQL,
  datasetCountSQL,
  datasetFetchSQL,
  expandValueToken,
  rebuildSelectSQL,
  violCountSQL,
  violFetchSQL,
} from './sql';
import type { EngineOptions, QCRule, RuleFile, RuleRunStat, RunResult, SQLRunner } from './types';
import { computePertinence } from '../pertinence';
import type { QCFlag } from '../flags/flag';

export const ROW_CAP_PER_RULE_DEFAULT = 10_000;
export const DATASET_ROW_CAP_DEFAULT = 200;
/** Mirrors FLAG_CAP_DEFAULT in flags/flagStore.ts (architecture.md §5). */
export const GLOBAL_FLAG_CAP_DEFAULT = 200_000;

/**
 * Browser SQLRunner over the real bridge (phase task 5; exercised in P12).
 * Validations never mutate, so clearCache stays unused here — P12's runQC
 * calls it after every work-table swap (Verified facts V2).
 */
export function createBridgeRunner(bridge: WorkerBridge): SQLRunner & { clearCache: () => void } {
  return {
    query: <T = Record<string, unknown>>(sql: string): Promise<T[]> => bridge.query<T>(sql),
    clearCache: (): void => {
      bridge.clearQueryCache();
    },
  };
}

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

// ---- shared phase plumbing -------------------------------------------------

interface PhaseCtx {
  runner: SQLRunner & { clearCache?: () => void };
  datasetColumns: string[];
  rowCap: number;
  datasetCap: number;
  sink: FlagSink;
  perRule: RuleRunStat[];
  onProgress?: EngineOptions['onProgress'];
}

/** DISTINCT targets (§7) + the P11 applicability gate shared by both phases. */
function applicableTargets(ctx: PhaseCtx, rule: QCRule): string[] | null {
  const targets = [...new Set(rule.targetVariables)];
  const pertinence = computePertinence({
    schemaColumns: targets.map((name) => ({ name, required: true })),
    datasetColumns: ctx.datasetColumns,
  });
  if (pertinence !== null && pertinence.missingRequired.length > 0) return null;
  return targets;
}

/** The exact P11 broken-rule sequence: discard → broken flag → flush → stat. */
function recordBrokenRule(ctx: PhaseCtx, rule: QCRule, err: unknown, started: number): void {
  ctx.sink.discardRule(); // all-or-nothing: no partial flags from a broken rule
  const msg = err instanceof Error ? err.message : String(err);
  ctx.sink.emitSummary({
    source: 'rules',
    ruleId: rule.ruleId,
    scope: 'dataset',
    severity: 'error',
    message: `Rule failed to execute: ${msg}`,
  });
  const { emitted } = ctx.sink.flushRule();
  ctx.perRule.push({
    ruleId: rule.ruleId,
    status: 'broken',
    violationCount: 0,
    flagsEmitted: emitted,
    truncated: false,
    durationMs: performance.now() - started,
    error: msg,
  });
}

// ---- the validations phase (engine §3 phase 3) -----------------------------

async function runValidationsPhase(ctx: PhaseCtx, allRules: QCRule[]): Promise<void> {
  const total = allRules.filter((r) => r.ruleType === 'validate' && r.enabled).length;
  let index = 0;

  for (const rule of allRules) {
    if (rule.ruleType === 'correct') continue; // the corrections phase stats these
    if (rule.ruleType === 'external') {
      ctx.perRule.push(skipStat(rule, 'skipped-external'));
      continue;
    }
    if (!rule.enabled) {
      ctx.perRule.push(skipStat(rule, 'skipped-disabled'));
      continue;
    }

    ctx.onProgress?.({ ruleId: rule.ruleId, index, total, phase: 'validate' });
    index += 1;

    const targets = applicableTargets(ctx, rule);
    if (targets === null) {
      ctx.perRule.push(skipStat(rule, 'skipped-inapplicable'));
      continue;
    }

    const started = performance.now();
    try {
      const outcome = await runValidateRule(
        ctx.runner,
        rule,
        targets,
        ctx.rowCap,
        ctx.datasetCap,
        ctx.sink,
      );
      const suppressed = ctx.sink.suppressed();
      if (suppressed > 0) {
        ctx.sink.emitSummary({
          source: 'rules',
          ruleId: rule.ruleId,
          scope: 'dataset',
          severity: rule.severity,
          message: `…and ${countFmt(suppressed)} more flags from this rule suppressed (global flag cap reached)`,
        });
      }
      const { emitted } = ctx.sink.flushRule();
      ctx.perRule.push({
        ruleId: rule.ruleId,
        status: 'ok',
        violationCount: outcome.violationCount,
        flagsEmitted: emitted,
        truncated: outcome.truncated || suppressed > 0,
        durationMs: performance.now() - started,
      });
    } catch (err) {
      recordBrokenRule(ctx, rule, err, started);
    }
  }
}

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
  await runValidationsPhase(
    { runner, datasetColumns, rowCap, datasetCap, sink, perRule, onProgress: opts.onProgress },
    ruleFiles.flatMap((f) => f.rules),
  );
  return { flags: sink.all(), perRule, correctedCells: 0 };
}

// ---- the corrections phase (engine §3 phase 1; P12) ------------------------

/**
 * Executes one SQL correction rule: exact per-target counts, before/after
 * capture (no-op suppressed via `after IS DISTINCT FROM before`), then ONE
 * atomic CREATE OR REPLACE CTAS covering all targets (V14) + view refresh +
 * cache clear. Returns the changed-cell count.
 */
async function runSqlCorrection(ctx: PhaseCtx, rule: QCRule): Promise<ExecOutcome> {
  await ctx.runner.query('SELECT setseed(0.42)');
  const pairs = expandValueToken(rule);
  const message = flagMessage(rule);
  let changed = 0;
  let truncated = false;

  // Capture BEFORE the rebuild: every count/capture and the CTAS all read the
  // same pre-rule `data` state (spec §3 single-pass guarantee).
  for (const pair of pairs) {
    const n = firstScalar(
      await ctx.runner.query(correctionCountSQL(pair.condition, pair.expression, pair.target)),
    );
    changed += n;
    if (n === 0) continue;
    const rows = await ctx.runner.query(
      correctionCaptureSQL(pair.condition, pair.expression, pair.target, ctx.rowCap),
    );
    for (const row of rows) {
      ctx.sink.emit({
        source: 'rules',
        ruleId: rule.ruleId,
        scope: 'cell',
        row: Number(row.__row__),
        column: pair.target,
        severity: rule.severity,
        message,
        value: row.before,
        correction: { before: row.before, after: row.after },
      });
    }
    if (n > ctx.rowCap) {
      truncated = true;
      ctx.sink.emitSummary({
        source: 'rules',
        ruleId: rule.ruleId,
        scope: 'column',
        column: pair.target,
        severity: rule.severity,
        message: `…and ${countFmt(n - ctx.rowCap)} more rows corrected by this rule`,
      });
    }
  }

  // Atomic swap — single self-referential CTAS (V14; failure leaves quac_work
  // untouched, nothing to clean up), then the cheap-insurance view refresh.
  await ctx.runner.query(`CREATE OR REPLACE TABLE quac_work AS ${rebuildSelectSQL(pairs)}`);
  await ctx.runner.query('CREATE OR REPLACE VIEW data AS SELECT * FROM quac_work');
  ctx.runner.clearCache?.();

  return { violationCount: changed, truncated };
}

async function runCorrectionsPhase(ctx: PhaseCtx, allRules: QCRule[]): Promise<number> {
  const correctRules = allRules.filter((r) => r.ruleType === 'correct');
  const total = correctRules.filter((r) => r.enabled).length;
  let index = 0;
  let correctedCells = 0;

  for (const rule of correctRules) {
    if (!rule.enabled) {
      ctx.perRule.push(skipStat(rule, 'skipped-disabled'));
      continue;
    }

    ctx.onProgress?.({ ruleId: rule.ruleId, index, total, phase: 'correct' });
    index += 1;

    if (applicableTargets(ctx, rule) === null) {
      ctx.perRule.push(skipStat(rule, 'skipped-inapplicable'));
      continue;
    }

    const started = performance.now();
    try {
      if (rule.updateLanguage === 'js') {
        throw new Error('JS corrections require the QuickJS sandbox (P13); rule not executed');
      }
      const outcome = await runSqlCorrection(ctx, rule);
      const suppressed = ctx.sink.suppressed();
      if (suppressed > 0) {
        ctx.sink.emitSummary({
          source: 'rules',
          ruleId: rule.ruleId,
          scope: 'dataset',
          severity: rule.severity,
          message: `…and ${countFmt(suppressed)} more flags from this rule suppressed (global flag cap reached)`,
        });
      }
      const { emitted } = ctx.sink.flushRule(); // only after the swap succeeded
      correctedCells += outcome.violationCount;
      ctx.perRule.push({
        ruleId: rule.ruleId,
        status: 'ok',
        violationCount: outcome.violationCount,
        flagsEmitted: emitted,
        truncated: outcome.truncated || suppressed > 0,
        changedCells: outcome.violationCount,
        durationMs: performance.now() - started,
      });
    } catch (err) {
      recordBrokenRule(ctx, rule, err, started);
    }
  }

  return correctedCells;
}

// ---- runQC orchestration (engine §3) ---------------------------------------

/**
 * Full SQL-rules run: rebuild `quac_work` from the never-mutated `quac_typed`,
 * refresh the canonical view `data`, run corrections (file order; skipped
 * entirely in assess-only mode) then validations against the corrected data.
 * One shared sink — the global flag cap spans the whole run. Browser callers
 * must hardenBridge() first (architecture.md §8 / V6) and pass a runner whose
 * clearCache invalidates the bridge SELECT cache (V2).
 */
export async function runQC(
  runner: SQLRunner & { clearCache?: () => void },
  ruleFiles: RuleFile[],
  opts: EngineOptions = {},
): Promise<RunResult> {
  const rowCap = opts.rowCapPerRule ?? ROW_CAP_PER_RULE_DEFAULT;
  const datasetCap = opts.datasetRowCap ?? DATASET_ROW_CAP_DEFAULT;
  const globalCap = opts.globalFlagCap ?? GLOBAL_FLAG_CAP_DEFAULT;

  // Prepare (§3): determinism — every run starts from a fresh work-table copy.
  await runner.query('CREATE OR REPLACE TABLE quac_work AS SELECT * FROM quac_typed');
  await runner.query('CREATE OR REPLACE VIEW data AS SELECT * FROM quac_work');
  runner.clearCache?.();

  // One DESCRIBE serves both phases — SELECT * REPLACE never changes columns.
  const datasetColumns = (await runner.query<{ column_name: string }>('DESCRIBE data')).map(
    (r) => r.column_name,
  );

  const sink = createFlagSink(globalCap, opts.onFlags);
  const perRule: RuleRunStat[] = [];
  const allRules = ruleFiles.flatMap((f) => f.rules);
  const ctx: PhaseCtx = {
    runner,
    datasetColumns,
    rowCap,
    datasetCap,
    sink,
    perRule,
    onProgress: opts.onProgress,
  };

  let correctedCells = 0;
  if (opts.applyCorrections !== false) {
    correctedCells = await runCorrectionsPhase(ctx, allRules);
  }
  await runValidationsPhase(ctx, allRules);

  return { flags: sink.all(), perRule, correctedCells };
}
