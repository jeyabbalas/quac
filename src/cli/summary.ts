/**
 * The machine-readable run summary (headless.md §7) — pure assembly over what
 * `runQuac` already computed. Nothing here re-derives a number; every field
 * maps onto an existing type, and where §7's JSON name differs from the source
 * field the rename is spelled out at the site.
 *
 * Stability contract: within `summarySchemaVersion: 1` fields may be ADDED but
 * never removed or renamed. A removal or rename bumps the version, because
 * scripts read this with `jq` and a silent rename is a silent breakage.
 *
 * Lives here rather than on `RunQuacResult` because the summary is the CLI's
 * artifact — it carries an `exitCode` and the report's path, neither of which
 * `runQuac` knows. `src/headless/index.ts` re-exports `buildSummary` so
 * library callers get it from the package root all the same.
 */
import type { FlagStoreSummary } from '../core/flags/flagStore';
import type { RunStage } from '../core/pipeline';
import type { FindingsFormat } from '../core/report/findings';
import type { RuleRunStatus } from '../core/rules/types';
import type { RunQuacResult } from '../headless/run';
import type { FailOn } from './args';

export const SUMMARY_SCHEMA_VERSION = 1;

/** headless.md §6 codes a finished run can end with (the rest are refusals). */
export const EXIT_OK = 0;
export const EXIT_RUN_FAILURE = 4;
export const EXIT_FAIL_ON = 6;

/**
 * The exit code of a run that produced its report.
 *
 * A schema stage that did not finish is §6's exit 4 — a run failure — whatever
 * `--fail-on` says: its findings are missing, not merely few, so a script
 * gating on "no errors" must not read the partial report as a pass. (The
 * report and summary are still written, as for exit 6.) Other non-prepare
 * stage errors stay non-fatal, as §6 says. Otherwise `--fail-on`: `error`
 * fails on any error, `warning` on any error or warning, `none` never.
 */
export function exitCodeFor(failOn: FailOn, result: RunQuacResult<string | null>): number {
  if (result.artifacts.stageErrors.some((e) => e.stage === 'schema')) return EXIT_RUN_FAILURE;
  if (failOn === 'none') return EXIT_OK;
  const { error, warning } = result.artifacts.flagStore.summary().severityTotals;
  const hit = failOn === 'error' ? error > 0 : error + warning > 0;
  return hit ? EXIT_FAIL_ON : EXIT_OK;
}

export interface SummaryJson {
  summarySchemaVersion: number;
  quacVersion: string;
  generatedAt: string;
  exitCode: number;
  dataset: {
    path: string;
    name: string;
    format: string;
    sheet: string | null;
    rows: number;
    columns: number;
  };
  inputs: {
    schema: {
      files: string[];
      root: string | null;
      index: string | null;
      loadWarnings: string[];
    } | null;
    rules: { name: string; rules: number; lintErrors: number; excludedRuleIds: string[] }[];
    applyCorrections: boolean;
  };
  severityTotals: { error: number; warning: number; info: number };
  rowsAffected: number;
  flagsTruncated: boolean;
  correctedCells: number;
  perRule: {
    ruleId: string;
    status: RuleRunStatus;
    violationCount: number;
    flagsEmitted: number;
    truncated: boolean;
    durationMs: number;
  }[];
  schema: {
    rowsTotal: number;
    rowsWithErrors: number;
    flagsEmitted: number;
    flagsTruncated: boolean;
    countsByRuleId: Record<string, number>;
    elapsedMs: number;
    aborted: boolean;
  } | null;
  missingVariables: { name: string; description: string }[];
  stageErrors: { stage: RunStage; message: string }[];
  durations: Partial<Record<RunStage, number>>;
  /** Null when the run wrote no QC report (`--no-report`). */
  report: { path: string; dataRowsTruncated: boolean } | null;
  /** The findings without data the run wrote (`--findings`), in argument order. */
  findings: WrittenFindings[];
}

/** One findings output: an absolute path, or `-` for stdout. */
export interface WrittenFindings {
  path: string;
  format: FindingsFormat;
}

export interface SummaryContext {
  quacVersion: string;
  exitCode: number;
  /** ISO-8601. Injected so the summary is testable without a clock. */
  generatedAt: string;
  /** What `--findings` wrote; absent, none. */
  findings?: WrittenFindings[];
}

export function buildSummary(
  result: RunQuacResult<string | null>,
  ctx: SummaryContext,
): SummaryJson {
  const { artifacts, inputs, model } = result;
  const flags: FlagStoreSummary = artifacts.flagStore.summary(artifacts.rowsTotal);

  return {
    summarySchemaVersion: SUMMARY_SCHEMA_VERSION,
    quacVersion: ctx.quacVersion,
    generatedAt: ctx.generatedAt,
    exitCode: ctx.exitCode,
    dataset: {
      path: inputs.dataset.path,
      name: inputs.dataset.name,
      format: inputs.dataset.format,
      sheet: inputs.dataset.sheet,
      rows: inputs.dataset.rows,
      columns: inputs.dataset.columns,
    },
    inputs: {
      schema:
        inputs.schema === null
          ? null
          : {
              files: inputs.schema.set.schemas.map((f) => f.relativePath),
              root:
                inputs.schema.set.files.find((f) => f.fileId === inputs.schema?.set.root.rootFileId)
                  ?.relativePath ?? null,
              index: inputs.schema.set.root.indexFileId ?? null,
              // Fatals already threw; what is left is advice worth keeping.
              loadWarnings: inputs.schema.set.errors
                .filter((e) => e.severity !== 'fatal')
                .map((e) => e.message),
            },
      rules: inputs.rules.map((r) => ({
        name: r.file, // §7 `name` ← RuleFileLintResult.file
        rules: r.ruleCount, // §7 `rules` ← ruleCount
        lintErrors: r.issues.filter((i) => i.severity === 'error').length,
        excludedRuleIds: excludedRuleIds(r.issues),
      })),
      applyCorrections: inputs.applyCorrections,
    },
    severityTotals: flags.severityTotals,
    rowsAffected: flags.rowsAffected,
    flagsTruncated: flags.truncated, // §7 `flagsTruncated` ← FlagStoreSummary.truncated
    correctedCells: artifacts.rules?.correctedCells ?? 0,
    perRule: (artifacts.rules?.perRule ?? []).map((s) => ({
      ruleId: s.ruleId,
      status: s.status,
      violationCount: s.violationCount, // exact — never the capped figure
      flagsEmitted: s.flagsEmitted,
      truncated: s.truncated,
      durationMs: s.durationMs,
    })),
    schema:
      artifacts.schema === null
        ? null
        : {
            rowsTotal: artifacts.schema.rowsTotal,
            rowsWithErrors: artifacts.schema.rowsWithErrors,
            flagsEmitted: artifacts.schema.flagsEmitted,
            flagsTruncated: artifacts.schema.flagsTruncated,
            // Already a plain object, unlike the FlagStore's ReadonlyMaps.
            countsByRuleId: { ...artifacts.schema.countsByRuleId },
            elapsedMs: artifacts.schema.elapsedMs,
            aborted: artifacts.schema.aborted,
          },
    missingVariables: model.missingVariables.map((v) => ({
      name: v.variable, // §7 `name` ← MissingVarRow.variable
      description: v.description,
    })),
    // StageError.cause is an arbitrary thrown value — never serialize it.
    stageErrors: artifacts.stageErrors.map((e) => ({ stage: e.stage, message: e.message })),
    durations: { ...artifacts.durations },
    report:
      result.outPath === null
        ? null
        : { path: result.outPath, dataRowsTruncated: model.data.truncated },
    findings: (ctx.findings ?? []).map((f) => ({ path: f.path, format: f.format })),
  };
}

/**
 * The rules a lint error took out of the run. Mirrors `executableRuleFile`:
 * an error carrying a `rowNumber` excludes that one rule, while an error
 * WITHOUT one is structural and excludes the whole file — which no list of
 * rule ids can express, so those contribute nothing here and show up as a
 * `lintErrors` count with an empty exclusion list.
 */
function excludedRuleIds(issues: RunQuacResult['inputs']['rules'][number]['issues']): string[] {
  const ids = new Set<string>();
  for (const issue of issues) {
    if (issue.severity !== 'error' || issue.rowNumber === undefined) continue;
    if (issue.ruleId !== undefined) ids.add(issue.ruleId);
  }
  return [...ids];
}
