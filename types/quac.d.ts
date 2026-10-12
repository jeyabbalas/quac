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
 * contract this package would then owe compatibility to. `findings` is the
 * opposite: it IS a public contract — the JSON document `--findings x.json`
 * writes, versioned by `findingsSchemaVersion` — so it is declared in full.
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
  /** Write the .xlsx QC report (it holds the data). Default true; false writes nothing. */
  report?: boolean;
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

export interface RunQuacResult<OutPath extends string | null = string> {
  /** Absolute path of the written workbook; null when `report: false`. */
  outPath: OutPath;
  artifacts: unknown;
  model: unknown;
  /** The findings without data: what failed, where it is defined, how often — no data value. */
  findings: QcFindings;
  inputs: {
    dataset: RunQuacDatasetInfo;
    schema: unknown;
    rules: unknown;
    applyCorrections: boolean;
    pertinence: unknown;
  };
}

/** Ingest → schema validation → rules + corrections → Excel report, on Node. */
export declare function runQuac(
  options: RunQuacOptions & { report: false },
): Promise<RunQuacResult<null>>;
export declare function runQuac(
  options: RunQuacOptions & { report?: true },
): Promise<RunQuacResult>;
export declare function runQuac(options: RunQuacOptions): Promise<RunQuacResult<string | null>>;

/** Thrown for anything a user can fix; `kind` maps onto the CLI exit codes. */
export declare class QuacCliError extends Error {
  readonly kind: QuacErrorKind;
  readonly detail: readonly string[];
}

export declare const SUMMARY_SCHEMA_VERSION: number;

export type FindingsFormat = 'markdown' | 'json' | 'xlsx';

/** One findings output the CLI wrote: an absolute path, or `-` for stdout. */
export interface WrittenFindings {
  path: string;
  format: FindingsFormat;
}

export interface SummaryContext {
  quacVersion: string;
  exitCode: number;
  /** ISO-8601. */
  generatedAt: string;
  /** What `--findings` wrote; absent, none. */
  findings?: WrittenFindings[];
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
  /** Null when the run wrote no QC report (`--no-report`). */
  report: { path: string; dataRowsTruncated: boolean } | null;
  findings: WrittenFindings[];
}

export declare function buildSummary(
  result: RunQuacResult<string | null>,
  ctx: SummaryContext,
): SummaryJson;

// ---- The findings without data (qc-report-spec.md §7) ----

export declare const FINDINGS_SCHEMA_VERSION: number;

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface QcFindings {
  findingsSchemaVersion: number;
  /** Always false: nothing in the document was read from the dataset's values. */
  containsData: false;
  generator: { name: 'QuaC'; version: string; homepage: string };
  /** ISO 8601. */
  generatedAt: string;
  dataset: {
    name: string;
    format: string;
    sheet: string | null;
    records: number;
    variables: number;
  };
  inputs: {
    schema: {
      root: string;
      files: string[];
      /**
       * A URL-loaded set's common base: `root`, `files` and every `location.file` are
       * relative to it. Null for uploads.
       */
      baseUrl: string | null;
      /** QuaC's fingerprint of the exact schema files. */
      setId: string;
      title: string | null;
      id: string | null;
    } | null;
    rules: { file: string; rules: number; source: string | null }[];
    correctionsApplied: boolean;
  };
  overview: {
    records: number;
    recordsWithErrors: number;
    recordsWithWarnings: number;
    /** False when a cap left flagged records uncounted: the two figures above are lower bounds. */
    recordsExact: boolean;
    schemaChecksFailed: number;
    rules: {
      total: number;
      failed: number;
      passed: number;
      corrected: number;
      errored: number;
      notRun: number;
    };
    valuesCorrected: number;
    missingVariables: { required: number; optional: number };
    columnsNotInSchema: number;
  };
  schemaChecks: SchemaCheckFinding[];
  rules: RuleFinding[];
  notes: FindingsNote[];
}

export interface SchemaCheckFinding {
  level: 'dataset' | 'variable' | 'value';
  variable: string | null;
  variableTitle: string | null;
  /** Where inside the variable's value — `household[].age`; null at the value itself. */
  path: string | null;
  /** What the schema requires, in words, from the schema alone. */
  requirement: string;
  keyword: string | null;
  /** The keyword's value, when it is a plain value or a list of them. */
  schemaValue?: unknown;
  /** The schema file and a JSON Pointer to the keyword (or to the variable's declaration). */
  location: { file: string; pointer: string } | null;
  severity: FindingSeverity;
  records: number | null;
  failures: number;
  percentOfRecords: number | null;
  ruleId: string;
}

export type RuleOutcome =
  | 'failed'
  | 'passed'
  | 'corrected'
  | 'unchanged'
  | 'error'
  | 'not-evaluated'
  | 'disabled'
  | 'skipped'
  | 'excluded'
  | 'not-applied'
  | 'not-run';

export interface RuleFinding {
  ruleId: string;
  file: string;
  /** Data rows counted from 1; the header is not one. */
  row: number;
  type: 'validate' | 'correct' | 'external';
  scope: 'row' | 'column' | 'dataset' | 'longitudinal';
  severity: FindingSeverity;
  variables: string[];
  description: string;
  condition: string;
  outcome: RuleOutcome;
  reason: string | null;
  records: number | null;
  percentOfRecords: number | null;
  recordsExact: boolean;
  resultRows: number | null;
  valuesChanged: number | null;
  byVariable:
    | { variable: string; records: number | null; distinctValues?: number; failed: boolean }[]
    | null;
}

export interface FindingsNote {
  kind:
    | 'cancelled'
    | 'stage-error'
    | 'assess-only'
    | 'no-schema'
    | 'no-rules'
    | 'records-lower-bound'
    | 'schema-load'
    | 'not-checked'
    | 'json-source'
    | 'precision'
    | 'rules-file'
    | 'schema-comment';
  text: string;
}

/** The findings as GitHub-flavoured Markdown, newline-terminated. */
export declare function renderFindingsMarkdown(findings: QcFindings): string;

/** The findings as an Excel workbook: Summary · Schema checks · QC rules · Notes. */
export declare function writeFindingsWorkbook(findings: QcFindings): Promise<Blob>;
