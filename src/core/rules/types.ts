// Rules subsystem types — verbatim from qc-rules-engine.md §1 (rule model +
// engine/sandbox interfaces, gathered here per phase-10 task 1) and §7 (lint shapes).
import type { QCFlag } from '../flags/flag';

export type RuleType = 'validate' | 'correct' | 'external';
export type RuleScope = 'row' | 'column' | 'dataset' | 'longitudinal';
export type Severity = 'error' | 'warning' | 'info';

export interface QCRule {
  ruleId: string;
  ruleType: RuleType;
  ruleScope: RuleScope;
  targetVariables: string[]; // parsed pipe list; [] only for dataset/external
  condition: string;
  updateLanguage: 'sql' | 'js'; // default 'sql'
  updateExpression: string; // '' unless correct
  severity: Severity;
  comment: string;
  enabled: boolean;
  sourceFile: string; // group (basename)
  rowNumber: number; // 1-based CSV data row, for lint/error surfacing
  extras: Record<string, string>; // unknown columns, preserved for lossless round-trip
}

export interface RuleFile {
  name: string;
  group: string;
  rules: QCRule[];
  extraColumns: string[]; // original order, for lossless export
}

export interface SQLRunner {
  // WorkerBridge adapter in browser; @duckdb/node-api in node tests
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
}

export interface EngineOptions {
  workTable?: string; // default 'quac_work'; view 'data' points at it
  rowCapPerRule?: number; // default 10_000 violating rows
  datasetRowCap?: number; // default 200 rows per dataset rule
  globalFlagCap?: number; // default 200_000
  applyCorrections?: boolean; // false = assess-only mode
  jsSandbox?: JSSandbox | null; // null ⇒ js rules marked broken, run continues
  onProgress?: (p: {
    ruleId: string;
    index: number;
    total: number;
    phase: 'correct' | 'validate';
  }) => void;
  onFlags?: (batch: QCFlag[]) => void; // incremental delivery to the FlagStore
}

export type RuleRunStatus =
  | 'ok'
  | 'broken'
  | 'skipped-disabled'
  | 'skipped-external'
  | 'skipped-inapplicable';

export interface RuleRunStat {
  ruleId: string;
  status: RuleRunStatus;
  violationCount: number; // EXACT, from COUNT(*), never truncated
  flagsEmitted: number;
  truncated: boolean;
  changedCells?: number; // correct rules
  durationMs: number;
  error?: string;
}

export interface RunResult {
  flags: QCFlag[];
  perRule: RuleRunStat[];
  correctedCells: number;
}

export interface JSSandbox {
  compileCheck(fnSource: string): Promise<{ ok: boolean; error?: string }>;
  runCorrection(
    fnSource: string,
    batch: { row: number; value: unknown; rowData: Record<string, unknown> }[],
    budget: { timeoutMs: number },
  ): Promise<{ row: number; value: unknown; changed: boolean }[]>;
}

// ---- Lint result shapes (qc-rules-engine.md §7) ----

export type LintCode =
  | 'missing-header'
  | 'empty-file'
  | 'bad-enum'
  | 'missing-field'
  | 'duplicate-id'
  | 'bad-id'
  | 'update-on-validate'
  | 'missing-update'
  | 'bad-scope-combo'
  | 'bad-assertion'
  | 'select-in-row-scope'
  | 'semicolon'
  | 'value-token-misuse'
  | 'sql-error'
  | 'js-error'
  | 'smart-quotes'
  | 'unknown-target'
  | 'pertinence'
  | 'pending-data'
  | 'extra-columns'
  | 'empty-comment';

export interface RuleLintIssue {
  severity: 'error' | 'warning' | 'info';
  code: LintCode;
  file: string;
  ruleId?: string;
  rowNumber?: number; // 1-based CSV data row
  csvColumn?: string;
  message: string;
  detail?: string; // detail = raw DuckDB/QuickJS message
}

export interface RuleFileLintResult {
  file: string;
  ok: boolean; // ok = no error-severity issues
  ruleCount: number;
  executable: number; // enabled ∧ lint-clean ∧ applicable
  issues: RuleLintIssue[];
  pertinence?: { targetsFound: number; targetsTotal: number; missing: string[] };
}
