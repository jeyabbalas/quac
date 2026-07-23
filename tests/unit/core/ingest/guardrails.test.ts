import { expect, test } from 'vitest';
import {
  EXCEL_MAX_ROWS,
  MAX_BYTES,
  WARN_BYTES,
  assessFileSize,
  needsExcelTruncationNotice,
} from '../../../../src/core/ingest/guardrails';
import { IngestError } from '../../../../src/core/ingest/errors';

test('sizes below 100 MB pass silently', () => {
  expect(assessFileSize(0)).toBe('ok');
  expect(assessFileSize(WARN_BYTES - 1)).toBe('ok');
});

test('100 MB to 500 MB warns', () => {
  expect(assessFileSize(WARN_BYTES)).toBe('warn');
  expect(assessFileSize(MAX_BYTES)).toBe('warn');
});

test('above 500 MB throws INGEST_TOO_LARGE with the Parquet hint', () => {
  try {
    assessFileSize(MAX_BYTES + 1);
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(IngestError);
    const e = err as IngestError;
    expect(e.code).toBe('INGEST_TOO_LARGE');
    expect(e.hint).toMatch(/Parquet/);
  }
});

test('Excel truncation notice fires only past the sheet row capacity', () => {
  expect(needsExcelTruncationNotice(EXCEL_MAX_ROWS)).toBe(false);
  expect(needsExcelTruncationNotice(EXCEL_MAX_ROWS + 1)).toBe(true);
});
