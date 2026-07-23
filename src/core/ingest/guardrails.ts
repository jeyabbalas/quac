/**
 * Ingestion guardrails (ingestion.md §5): size warn/stop before any bytes
 * are read, and the Excel-truncation notice threshold used by the report.
 */
import { IngestError } from './errors';

export const WARN_BYTES = 100 * 2 ** 20; // 100 MB
export const MAX_BYTES = 500 * 2 ** 20; // 500 MB
/** Excel worksheet row capacity minus the header row. */
export const EXCEL_MAX_ROWS = 1_048_575;

/**
 * Gate on the file size before reading anything. Throws INGEST_TOO_LARGE
 * above the hard cap; 'warn' asks the UI to surface the slow-load notice.
 */
export function assessFileSize(size: number): 'ok' | 'warn' {
  if (size > MAX_BYTES) {
    throw new IngestError(
      'INGEST_TOO_LARGE',
      `This file is ${formatMB(size)} MB — QuaC stops at ${formatMB(MAX_BYTES)} MB to keep the browser responsive.`,
      { hint: 'Convert the dataset to Parquet (much smaller) or split it before loading.' },
    );
  }
  return size >= WARN_BYTES ? 'warn' : 'ok';
}

/** True when Sheet 1 of the Excel report would truncate (qc-report-spec.md §truncation). */
export function needsExcelTruncationNotice(rowCount: number): boolean {
  return rowCount > EXCEL_MAX_ROWS;
}

function formatMB(bytes: number): string {
  return String(Math.round(bytes / 2 ** 20));
}
