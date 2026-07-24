/**
 * Excel workbook writer (qc-report-spec.md §5) — the lazy exceljs chunk. Turns
 * a pure `ReportModel` + a chunked row source into a styled `.xlsx` Blob:
 * frozen header, autofilter, severity fills, clamped widths, and sheets 2–5.
 *
 * exceljs is dynamically imported so it never enters the entry bundle, and is
 * reached ONLY from here (via `ui/views/report/reportExport.ts`). The library
 * ships as UMD whose API sits under the interop `default` — hence `mod.default
 * ?? mod`. There is no browser streaming writer (`stream.xlsx.WorkbookWriter`
 * is Node-fs only, Verified fact V21), so the workbook is assembled in memory
 * and emitted with `writeBuffer()`; the "10k-row chunks" apply to READING rows
 * out of DuckDB, which keeps the row buffer flat.
 */
import { EXCEL_MAX_ROWS } from '../ingest/guardrails';
import type { Fill } from 'exceljs';
import type { FillKind, ReportModel } from './reportModel';

/** One post-correction data row: `row` = __row__ (decoration key), `values` = source columns. */
export interface ReportDataRow {
  row: number;
  values: Record<string, unknown>;
}

/** Chunked, cancellable row source (DuckDB pages in the app; an array in tests). */
export type ReportRowSource = (
  signal?: AbortSignal,
) => AsyncIterable<readonly ReportDataRow[]>;

export interface WriteOptions {
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number }) => void;
}

/** Spec ARGB pairs (fill background / font foreground) per severity + corrected. */
const FILL_ARGB: Record<FillKind, { bg: string; fg: string }> = {
  error: { bg: 'FFFFC7CE', fg: 'FF9C0006' },
  warning: { bg: 'FFFFEB9C', fg: 'FF9C6500' },
  info: { bg: 'FFDDEBF7', fg: 'FF1F4E79' },
  corrected: { bg: 'FFC6EFCE', fg: 'FF276749' },
};
const HEADER_BG = 'FF111111';
const HEADER_FG = 'FFFFFFFF';
const REVIEW_HEADER_FG = 'FFB7BEC9';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_SAFE = 9007199254740991n;
const MIN_SAFE = -9007199254740991n;

type CellValue = string | number | boolean | Date | null;

const solidFill = (argb: string): Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const clampWidth = (len: number, max: number): number => Math.min(max, Math.max(10, len + 2));

/** Aborted? throw a plain Error; the orchestrator distinguishes via signal.aborted. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Export cancelled');
}

/** DuckDB scalars → exceljs-safe cell values (bigint past 2^53 → string). */
function coerce(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'bigint':
      return v > MAX_SAFE || v < MIN_SAFE ? v.toString() : Number(v);
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'boolean':
      return v;
    case 'string':
      return v;
    default:
      return v instanceof Date ? v : JSON.stringify(v);
  }
}

const cellLen = (v: CellValue): number => (v === null ? 0 : String(v).length);

export async function writeReportWorkbook(
  model: ReportModel,
  rows: ReportRowSource,
  opts: WriteOptions = {},
): Promise<Blob> {
  const { signal, onProgress } = opts;
  // exceljs is UMD: its API sits under the interop `default` in both the node
  // (CJS) and the browser (bundled UMD) resolutions.
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();

  // ---- Sheet 1: Data ----
  const cols = model.data.columns;
  const ws = workbook.addWorksheet('Data');
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const headerRow = ws.addRow(cols.map((c) => c.header));
  cols.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    if (col.headerFill) {
      cell.font = { bold: true, color: { argb: FILL_ARGB[col.headerFill].fg } };
      cell.fill = solidFill(FILL_ARGB[col.headerFill].bg);
    } else if (col.kind === 'review' || col.kind === 'row-review') {
      cell.font = { italic: true, bold: true, color: { argb: REVIEW_HEADER_FG } };
      cell.fill = solidFill(HEADER_BG);
    } else {
      cell.font = { bold: true, color: { argb: HEADER_FG } };
      cell.fill = solidFill(HEADER_BG);
    }
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  const widths = cols.map((c) => c.header.length);
  const total = model.data.rowLimit;
  let written = 0;
  onProgress?.({ done: 0, total });

  outer: for await (const chunk of rows(signal)) {
    throwIfAborted(signal);
    for (const dataRow of chunk) {
      if (written >= total) break outer;
      const dec = model.data.decorations.get(dataRow.row);
      const values: CellValue[] = cols.map((col) => {
        if (col.kind === 'row-review') return dec?.rowReview ?? '';
        if (col.kind === 'review') return dec?.reviews.get(col.source ?? '') ?? '';
        return coerce(dataRow.values[col.source ?? '']);
      });
      const xlsxRow = ws.addRow(values);
      if (dec) {
        cols.forEach((col, i) => {
          if (col.kind !== 'source' || col.source === undefined) return;
          const fill = dec.fills.get(col.source);
          if (fill === undefined) return;
          const cell = xlsxRow.getCell(i + 1);
          cell.fill = solidFill(FILL_ARGB[fill].bg);
          cell.font = { color: { argb: FILL_ARGB[fill].fg } };
        });
      }
      values.forEach((v, i) => {
        const len = cellLen(v);
        if (len > (widths[i] ?? 0)) widths[i] = len;
      });
      written += 1;
    }
    onProgress?.({ done: written, total });
  }

  if (model.data.truncated && model.data.truncationNote !== undefined) {
    ws.addRow([model.data.truncationNote]);
  }
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = clampWidth(w, 40);
  });
  onProgress?.({ done: written, total });

  // ---- Sheets 2–5: plain tables ----
  addTableSheet(
    workbook,
    'Missing Variables',
    ['Variable', 'Title', 'Description', 'Variable group', 'Required?'],
    model.missingVariables.map((m) => [
      m.variable,
      m.title,
      m.description,
      m.group,
      m.required ? 'Yes' : 'No',
    ]),
  );
  addTableSheet(
    workbook,
    'Dataset Findings',
    ['Rule ID', 'Source', 'Severity', 'Scope', 'Column', 'Message', 'Affected count'],
    model.datasetFindings.map((f) => [
      f.ruleId,
      f.source,
      f.severity,
      f.scope,
      f.column,
      f.message,
      f.count,
    ]),
  );
  addTableSheet(
    workbook,
    'Repeat Offenders',
    ['Rule ID', 'Source', 'Severity', 'Target variables', 'Flag count', '% of rows', 'Comment'],
    model.repeatOffenders.map((o) => [
      o.ruleId,
      o.source,
      o.severity,
      o.targets,
      o.count,
      o.pctOfRows,
      o.comment,
    ]),
  );
  addTableSheet(
    workbook,
    'Run Info',
    ['Field', 'Value'],
    model.runInfo.map((r) => [r.label, r.value]),
  );

  throwIfAborted(signal);
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}

/** A bold-header table sheet (frozen row 1, clamped widths) — sheets 2–5. */
function addTableSheet(
  workbook: import('exceljs').Workbook,
  name: string,
  headerLabels: readonly string[],
  dataRows: readonly (readonly CellValue[])[],
): void {
  const ws = workbook.addWorksheet(name);
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const headerRow = ws.addRow([...headerLabels]);
  headerLabels.forEach((_, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.font = { bold: true, color: { argb: HEADER_FG } };
    cell.fill = solidFill(HEADER_BG);
  });
  const widths = headerLabels.map((h) => h.length);
  for (const row of dataRows) {
    ws.addRow([...row]);
    row.forEach((v, i) => {
      const len = cellLen(v);
      if (len > (widths[i] ?? 0)) widths[i] = len;
    });
  }
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = clampWidth(w, 60);
  });
}

/** Re-export the row ceiling so callers building the SQL LIMIT share one constant. */
export { EXCEL_MAX_ROWS };
