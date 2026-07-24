/**
 * Report model (qc-report-spec.md §6): the pure, node-testable description of
 * every Excel sheet — column layout with `<col>__review` sister placement +
 * deterministic collision escalation, per-cell merged review text, severity
 * fills, truncation, and the content of sheets 2–5. `excelWriter.ts` renders
 * this 1:1, so all layout decisions live here where a node test can assert
 * them without exceljs.
 *
 * A handful of helpers (`RULE_STATUS_LABELS`, `schemaRuleTargets`,
 * `exactRuleCounts`, `rankOffenders`) are shared with the in-app Report
 * panels (`ui/views/report/reportPanels.ts`) so the workbook and the panels
 * can never disagree about a rule's status wording or its exact count.
 *
 * Framework-free: imports only other `core/` modules (flags, schema digests,
 * rules types, ingest guardrails). No DOM, no exceljs.
 */
import { renderFlag } from '../flags/messages';
import { missingVariables } from '../schema/column-meta';
import { EXCEL_MAX_ROWS } from '../ingest/guardrails';
import type { QCFlag } from '../flags/flag';
import type { FlagEntry, FlagStore, RuleAggregate } from '../flags/flagStore';
import type { ColumnMeta } from '../schema/column-meta';
import type { ValidationSummary } from '../schema/worker-protocol';
import type { QCRule, RuleFile, RuleRunStat, RuleRunStatus } from '../rules/types';

// ---- shared constants -------------------------------------------------------

/** Excel's hard per-cell character limit (guards oversized merged review text). */
export const EXCEL_MAX_CELL_CHARS = 32_767;
/** Merged review text shows at most this many flags before `(+N more)`. */
export const CELL_FLAG_CAP = 8;

export type FillKind = 'error' | 'warning' | 'info' | 'corrected';

/** Rendered inner base name for the row-scope review column (before collision escalation). */
const ROW_REVIEW_BASE = '__row_review';

const SEVERITY_RANK: Record<QCFlag['severity'], number> = { error: 0, warning: 1, info: 2 };

// ---- helpers shared with the in-app panels ----------------------------------

/** Rule-status → human wording; the single source for panel + Sheet 3. */
export const RULE_STATUS_LABELS: Record<RuleRunStatus, string> = {
  ok: 'ok',
  broken: 'failed to execute',
  'skipped-disabled': 'skipped — disabled',
  'skipped-external': 'not evaluated — requires external reference data',
  'skipped-inapplicable': 'skipped — target variables not in this dataset',
};

/** Target column(s) for a schema ruleId (D.5 grammar); '—' for dataset scope. */
export function schemaRuleTargets(ruleId: string): string {
  const parts = ruleId.split(':');
  if (parts[1] === 'prop' || parts[1] === 'column') return parts[2] ?? '—';
  if (parts[1] === 'cond') return parts[3] ?? '—';
  return '—';
}

/**
 * Exact per-rule counts: `RuleRunStat.violationCount` (rules) unioned with
 * `ValidationSummary.countsByRuleId` (schema). Flag emission is truncated by
 * the engine caps; these counters never are (qc-report-spec.md §1).
 */
export function exactRuleCounts(
  perRule: readonly RuleRunStat[] | undefined,
  schemaCounts: Readonly<Record<string, number>> | undefined,
): Map<string, number> {
  const exact = new Map<string, number>();
  for (const stat of perRule ?? []) exact.set(stat.ruleId, stat.violationCount);
  for (const [ruleId, count] of Object.entries(schemaCounts ?? {})) exact.set(ruleId, count);
  return exact;
}

/**
 * Re-rank the FlagStore's per-rule aggregates on the EXACT count the reader
 * sees (count desc, ruleId asc). FlagStore orders by flag count, and a rule
 * spanning N target columns emits N flags per violation — so its "descending"
 * order looks shuffled once the exact counts replace flag counts.
 */
export function rankOffenders(
  perRule: readonly RuleAggregate[],
  exactByRule: ReadonlyMap<string, number>,
): RuleAggregate[] {
  const exactOf = (ruleId: string, fallback: number): number => exactByRule.get(ruleId) ?? fallback;
  return [...perRule].sort((a, b) => {
    const delta = exactOf(b.ruleId, b.count) - exactOf(a.ruleId, a.count);
    return delta !== 0 ? delta : a.ruleId < b.ruleId ? -1 : 1;
  });
}

// ---- model shapes -----------------------------------------------------------

export interface ReportColumn {
  header: string;
  kind: 'row-review' | 'source' | 'review';
  /** Source dataset column this column carries or annotates (source/review only). */
  source?: string;
  /** Column-scope severity tint for a source header (qc-report-spec.md §5 Sheet 1). */
  headerFill?: FillKind;
}

export interface RowDecoration {
  /** sourceColumn → merged cell-scope review text. */
  reviews: Map<string, string>;
  /** sourceColumn → cell fill kind. */
  fills: Map<string, FillKind>;
  /** Merged row-scope review text (blank when none). */
  rowReview: string;
}

export interface DataSheetModel {
  columns: ReportColumn[];
  /** __row__ → decoration; only rows with ≥1 cell/row flag appear. */
  decorations: Map<number, RowDecoration>;
  /** Rows written (≤ EXCEL_MAX_ROWS). */
  rowLimit: number;
  truncated: boolean;
  /** Final note row appended after the data when truncated. */
  truncationNote?: string;
}

export interface MissingVarRow {
  variable: string;
  title: string;
  description: string;
  group: string;
  required: boolean;
}

export interface FindingRow {
  ruleId: string;
  source: 'schema' | 'rules';
  severity: QCFlag['severity'];
  scope: string;
  column: string;
  message: string;
  count: string;
}

export interface OffenderRow {
  ruleId: string;
  source: 'schema' | 'rules';
  severity: QCFlag['severity'];
  targets: string;
  count: number;
  pctOfRows: string;
  comment: string;
}

export interface InfoRow {
  label: string;
  value: string;
}

/** Run metadata the UI assembles for Sheet 5 (not derivable from FlagStore). */
export interface RunInfoInput {
  appVersion: string;
  runAt: Date;
  datasetName: string;
  datasetFormat: string;
  /** Schema file names/URLs (empty ⇒ no schema loaded). */
  schemaFiles: readonly string[];
  /** Resolved root file relativePath, when a schema is loaded. */
  schemaRoot?: string;
  /** Shareable index id (§A.4), when set. */
  schemaIndexId?: string;
  ruleFileSummaries: readonly { name: string; ruleCount: number }[];
  /** Pipeline stage durations, in emission order. */
  durations: readonly { stage: string; ms: number }[];
  correctionsApplied: boolean;
  caps: readonly { label: string; value: string }[];
  stageErrors: readonly { stage: string; message: string }[];
}

export interface ReportModelInput {
  flagStore: FlagStore;
  /** Dataset columns in file order, `__row__` excluded. */
  datasetColumns: readonly string[];
  rowCount: number;
  columnMeta: readonly ColumnMeta[] | null;
  ruleFiles: readonly RuleFile[];
  rules: { perRule: readonly RuleRunStat[]; correctedCells: number; aborted: boolean } | null;
  schema: ValidationSummary | null;
  runInfo: RunInfoInput;
}

export interface ReportModel {
  data: DataSheetModel;
  missingVariables: MissingVarRow[];
  datasetFindings: FindingRow[];
  repeatOffenders: OffenderRow[];
  runInfo: InfoRow[];
  filename: string;
}

// ---- text + fill helpers ----------------------------------------------------

/** Highest-severity fill among a cell's flags; 'corrected' when every flag is a correction. */
function fillForFlags(flags: readonly QCFlag[]): FillKind {
  if (flags.every((f) => f.correction !== undefined)) return 'corrected';
  let rank = SEVERITY_RANK.info;
  for (const f of flags) rank = Math.min(rank, SEVERITY_RANK[f.severity]);
  return rank === 0 ? 'error' : rank === 1 ? 'warning' : 'info';
}

/** Merge a cell's flags into review text: `"; "`-joined, 8-flag cap, char guard. */
function mergeReviewText(flags: readonly QCFlag[]): string {
  const rendered = flags.map(renderFlag);
  let parts = rendered;
  let suffix = '';
  if (rendered.length > CELL_FLAG_CAP) {
    parts = rendered.slice(0, CELL_FLAG_CAP);
    suffix = ` (+${String(rendered.length - CELL_FLAG_CAP)} more)`;
  }
  const text = parts.join('; ') + suffix;
  if (text.length <= EXCEL_MAX_CELL_CHARS) return text;
  const marker = '… (truncated)';
  return text.slice(0, EXCEL_MAX_CELL_CHARS - marker.length) + marker;
}

/** Deterministic collision escalation: base → base_2 → base_3 → … */
function escalate(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${String(i)}`)) i++;
  return `${base}_${String(i)}`;
}

// ---- Sheet 1: column layout + decorations -----------------------------------

interface CellGroup {
  reviews: Map<string, QCFlag[]>;
  rowFlags: QCFlag[];
}

function buildDataSheet(input: ReportModelInput): DataSheetModel {
  const { flagStore, datasetColumns, rowCount } = input;

  // Which source columns carry ≥1 cell-scope / column-scope flag.
  const cellColumns = new Set<string>();
  // Column-scope flags tint the header; a column flag is never a correction,
  // so its fill is exactly its severity — keep the strongest across duplicates.
  const columnFills = new Map<string, QCFlag['severity']>();
  let hasRowFlags = false;
  for (const entry of flagStore.all()) {
    const f = entry.flag;
    if (f.scope === 'cell' && f.column !== undefined) cellColumns.add(f.column);
    else if (f.scope === 'row') hasRowFlags = true;
    else if (f.scope === 'column' && f.column !== undefined) {
      const prev = columnFills.get(f.column);
      if (prev === undefined || SEVERITY_RANK[f.severity] < SEVERITY_RANK[prev]) {
        columnFills.set(f.column, f.severity);
      }
    }
  }

  // Column layout. Sisters must not collide with a real column or an emitted header.
  const taken = new Set<string>(datasetColumns);
  const columns: ReportColumn[] = [];
  if (hasRowFlags) {
    const rowReviewHeader = escalate(ROW_REVIEW_BASE, taken);
    taken.add(rowReviewHeader);
    columns.push({ header: rowReviewHeader, kind: 'row-review' });
  }
  for (const col of datasetColumns) {
    const headerFill = columnFills.get(col);
    columns.push({ header: col, kind: 'source', source: col, ...(headerFill ? { headerFill } : {}) });
    if (cellColumns.has(col)) {
      const sister = escalate(`${col}__review`, taken);
      taken.add(sister);
      columns.push({ header: sister, kind: 'review', source: col });
    }
  }

  // Group cell/row flags by row (FlagStore.all() is already in pipeline order).
  const groups = new Map<number, CellGroup>();
  const groupFor = (row: number): CellGroup => {
    let g = groups.get(row);
    if (g === undefined) {
      g = { reviews: new Map(), rowFlags: [] };
      groups.set(row, g);
    }
    return g;
  };
  for (const entry of flagStore.all()) {
    const f = entry.flag;
    if (f.scope === 'cell' && f.row !== undefined && f.column !== undefined) {
      const g = groupFor(f.row);
      const list = g.reviews.get(f.column);
      if (list === undefined) g.reviews.set(f.column, [f]);
      else list.push(f);
    } else if (f.scope === 'row' && f.row !== undefined) {
      groupFor(f.row).rowFlags.push(f);
    }
  }

  const decorations = new Map<number, RowDecoration>();
  for (const [row, group] of groups) {
    const reviews = new Map<string, string>();
    const fills = new Map<string, FillKind>();
    for (const [column, flags] of group.reviews) {
      reviews.set(column, mergeReviewText(flags));
      fills.set(column, fillForFlags(flags));
    }
    decorations.set(row, {
      reviews,
      fills,
      rowReview: group.rowFlags.length > 0 ? mergeReviewText(group.rowFlags) : '',
    });
  }

  const rowLimit = Math.min(rowCount, EXCEL_MAX_ROWS);
  const truncated = rowCount > EXCEL_MAX_ROWS;
  return {
    columns,
    decorations,
    rowLimit,
    truncated,
    ...(truncated
      ? {
          truncationNote:
            `… ${(rowCount - rowLimit).toLocaleString('en-US')} more rows not shown — ` +
            `Excel caps a sheet at ${EXCEL_MAX_ROWS.toLocaleString('en-US')} data rows. ` +
            'See the Run Info sheet.',
        }
      : {}),
  };
}

// ---- Sheet 2: missing variables ---------------------------------------------

function buildMissingVariables(input: ReportModelInput): MissingVarRow[] {
  if (input.columnMeta === null) return [];
  return missingVariables(input.columnMeta, input.datasetColumns).map((m) => ({
    variable: m.name,
    title: m.title ?? '',
    description: m.description ?? '',
    group: m.group ?? '',
    required: m.required,
  }));
}

// ---- Sheet 3: dataset findings ----------------------------------------------

function buildDatasetFindings(input: ReportModelInput): FindingRow[] {
  const { flagStore } = input;
  const exactByRule = exactRuleCounts(input.rules?.perRule, input.schema?.countsByRuleId);
  const rows: FindingRow[] = [];

  const fromFlag = (entry: FlagEntry): void => {
    const f = entry.flag;
    rows.push({
      ruleId: f.ruleId,
      source: f.source,
      severity: f.severity,
      scope: f.scope,
      column: f.column ?? '',
      message: f.message,
      count: String(exactByRule.get(f.ruleId) ?? entry.count),
    });
  };
  for (const entry of flagStore.datasetScope()) fromFlag(entry);
  for (const entry of flagStore.all()) {
    if (entry.flag.scope === 'column') fromFlag(entry);
  }

  for (const stat of input.rules?.perRule ?? []) {
    if (stat.status === 'ok') continue;
    rows.push({
      ruleId: stat.ruleId,
      source: 'rules',
      severity: stat.status === 'broken' ? 'error' : 'info',
      scope: '',
      column: '',
      message:
        stat.status === 'broken'
          ? `Rule failed to execute: ${stat.error ?? 'unknown error'}`
          : RULE_STATUS_LABELS[stat.status],
      count: '',
    });
  }

  rows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]); // stable within a tier
  return rows;
}

// ---- Sheet 4: repeat offenders ----------------------------------------------

function buildRepeatOffenders(input: ReportModelInput): OffenderRow[] {
  const summary = input.flagStore.summary(input.rowCount);
  const exactByRule = exactRuleCounts(input.rules?.perRule, input.schema?.countsByRuleId);
  const ruleById = new Map<string, QCRule>();
  for (const file of input.ruleFiles) for (const rule of file.rules) ruleById.set(rule.ruleId, rule);

  return rankOffenders(summary.perRule, exactByRule).map((aggregate) => {
    const rule = ruleById.get(aggregate.ruleId);
    const targets =
      aggregate.source === 'rules'
        ? (rule?.targetVariables ?? []).join(', ')
        : schemaRuleTargets(aggregate.ruleId);
    return {
      ruleId: aggregate.ruleId,
      source: aggregate.source,
      severity: aggregate.severity,
      targets: targets === '' ? '—' : targets,
      count: exactByRule.get(aggregate.ruleId) ?? aggregate.count,
      pctOfRows: aggregate.pctOfRows === undefined ? '—' : `${(aggregate.pctOfRows * 100).toFixed(1)}%`,
      comment: rule?.comment ?? '',
    };
  });
}

// ---- Sheet 5: run info ------------------------------------------------------

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;
}

function buildRunInfo(input: ReportModelInput, dataTruncated: boolean): InfoRow[] {
  const ri = input.runInfo;
  const rows: InfoRow[] = [];
  const push = (label: string, value: string): void => {
    rows.push({ label, value });
  };
  push('QuaC version', ri.appVersion);
  push('Run at', ri.runAt.toISOString());
  push('Dataset', `${ri.datasetName} (${ri.datasetFormat})`);
  push('Rows', input.rowCount.toLocaleString('en-US'));
  push('Columns', input.datasetColumns.length.toLocaleString('en-US'));

  push('', '');
  push('Schema files', ri.schemaFiles.length === 0 ? '(none)' : String(ri.schemaFiles.length));
  for (const name of ri.schemaFiles) push('  •', name);
  if (ri.schemaRoot !== undefined) push('  root', ri.schemaRoot);
  if (ri.schemaIndexId !== undefined) push('  index id', ri.schemaIndexId);

  push('', '');
  push('Rules files', ri.ruleFileSummaries.length === 0 ? '(none)' : String(ri.ruleFileSummaries.length));
  for (const f of ri.ruleFileSummaries) {
    push('  •', `${f.name} — ${f.ruleCount.toLocaleString('en-US')} rules`);
  }

  push('', '');
  push('Corrections', ri.correctionsApplied ? 'applied' : 'not applied (assess-only)');
  push('Cells corrected', (input.rules?.correctedCells ?? 0).toLocaleString('en-US'));

  push('', '');
  push('Stage durations', '');
  for (const d of ri.durations) push(`  ${d.stage}`, fmtDuration(d.ms));

  if (ri.caps.length > 0) {
    push('', '');
    push('Caps in effect', '');
    for (const cap of ri.caps) push(`  ${cap.label}`, cap.value);
  }

  const notes: string[] = [];
  if (dataTruncated) notes.push('Data sheet truncated to Excel’s row limit.');
  if (input.flagStore.summary().truncated) notes.push('Flag materialization hit the global cap (exact counts unaffected).');
  if (input.rules?.aborted === true) notes.push('Run was cancelled — results are partial.');
  for (const e of ri.stageErrors) notes.push(`Stage ${e.stage} error: ${e.message}`);
  if (notes.length > 0) {
    push('', '');
    push('Notes', '');
    for (const n of notes) push('  •', n);
  }

  return rows;
}

// ---- filename ---------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `quac-report_<dataset-stem>_<YYYYMMDD-HHmm>.xlsx` (local time). */
export function reportFilename(datasetName: string, at: Date): string {
  const stem = datasetName.replace(/\.[^./\\]+$/, '').replace(/[^\w.-]+/g, '_') || 'dataset';
  const stamp =
    `${String(at.getFullYear())}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
    `-${pad2(at.getHours())}${pad2(at.getMinutes())}`;
  return `quac-report_${stem}_${stamp}.xlsx`;
}

// ---- entry point ------------------------------------------------------------

export function buildReportModel(input: ReportModelInput): ReportModel {
  const data = buildDataSheet(input);
  return {
    data,
    missingVariables: buildMissingVariables(input),
    datasetFindings: buildDatasetFindings(input),
    repeatOffenders: buildRepeatOffenders(input),
    runInfo: buildRunInfo(input, data.truncated),
    filename: reportFilename(input.runInfo.datasetName, input.runInfo.runAt),
  };
}
