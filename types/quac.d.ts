/**
 * Public type surface of the `quac` package (headless.md §9).
 *
 * Hand-maintained: the repo is `noEmit`, so there is no dts toolchain to
 * generate this. It is kept honest by `tests/unit/cli/publicTypes.test.ts`,
 * which assigns these declarations against the real ones in both directions —
 * `npm run typecheck` fails the moment they drift.
 *
 * Only the stable surface lives here. `RunQuacResult.artifacts` and `.model`
 * are deep internal structures whose shapes belong to the pipeline and the
 * report model; they are typed `unknown` rather than frozen into a public
 * contract this package would then owe compatibility to.
 */

export type IngestFormat = 'csv' | 'tsv' | 'json' | 'xlsx' | 'parquet';
export type RunStage = 'prepare' | 'corrections' | 'schema' | 'rules' | 'annotate';
export type QuacErrorKind = 'usage' | 'input' | 'schema' | 'run' | 'report';
export type RuleRunStatus =
  | 'ok'
  | 'broken'
  | 'skipped-disabled'
  | 'skipped-external'
  | 'skipped-inapplicable';

export interface RunProgress {
  stage: RunStage;
  done: number;
  /** 0 ⇒ indeterminate. */
  total: number;
  /** ruleId (engine stages) or schema phase name. */
  detail?: string;
  flagCount: number;
}

export interface RunQuacOptions {
  /** Local path to the dataset (csv/tsv/json/xlsx/parquet). */
  dataset: string;
  /** Files, directories or URLs — all one kind, never a mix. */
  schema?: readonly string[];
  /** Files or URLs. Argument order is load order is correction order. */
  rules?: readonly string[];
  index?: string;
  sheet?: string;
  /** Output .xlsx path, or a directory to write the default name into. */
  out?: string;
  /** Default true. */
  applyCorrections?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
}

export interface RunQuacDatasetInfo {
  path: string;
  name: string;
  format: IngestFormat;
  /** The worksheet actually read, else null. */
  sheet: string | null;
  rows: number;
  columns: number;
  sizeVerdict: 'ok' | 'warn';
}

export interface RunQuacResult {
  /** Absolute path of the written workbook. */
  outPath: string;
  artifacts: unknown;
  model: unknown;
  inputs: {
    dataset: RunQuacDatasetInfo;
    schema: unknown;
    rules: unknown;
    applyCorrections: boolean;
    pertinence: unknown;
  };
}

/** Ingest → schema validation → rules + corrections → Excel report, on Node. */
export declare function runQuac(options: RunQuacOptions): Promise<RunQuacResult>;

/** Thrown for anything a user can fix; `kind` maps onto the CLI exit codes. */
export declare class QuacCliError extends Error {
  readonly kind: QuacErrorKind;
  readonly detail: readonly string[];
}

export declare const SUMMARY_SCHEMA_VERSION: number;

export interface SummaryContext {
  quacVersion: string;
  exitCode: number;
  /** ISO-8601. */
  generatedAt: string;
}

/** The machine-readable run record (headless.md §7), also what `--summary` writes. */
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
    schema: { files: string[]; root: string | null; index: string | null; loadWarnings: string[] } | null;
    rules: { name: string; rules: number; lintErrors: number; excludedRuleIds: string[] }[];
    applyCorrections: boolean;
  };
  severityTotals: { error: number; warning: number; info: number };
  /** Distinct rows carrying at least one finding — exact past the flag cap. */
  rowsAffected: number;
  flagsTruncated: boolean;
  correctedCells: number;
  perRule: {
    ruleId: string;
    status: RuleRunStatus;
    /** Exact, never the capped figure. */
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
  report: { path: string; dataRowsTruncated: boolean };
}

export declare function buildSummary(result: RunQuacResult, ctx: SummaryContext): SummaryJson;
