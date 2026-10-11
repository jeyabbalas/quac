/**
 * Storage-type classification for the preview table's right-alignment
 * (UIX-4 §4). Node-tested: the module reads no DOM at import time.
 *
 * `describeColumns` (casting.ts) hands over DuckDB's whole type text —
 * `DECIMAL(18,3)`, `STRUCT(x DOUBLE)[]` — and the classification reads its
 * base name (core/duckdb-type.ts), so a parameterised number aligns right and
 * a list of numbers does not.
 */
import { describe, expect, it } from 'vitest';
import {
  NUMERIC_STORAGE_TYPES,
  isNumericStorageType,
} from '../../../src/ui/components/plainPreviewTable';

describe('isNumericStorageType', () => {
  it('accepts the signed integer ladder', () => {
    for (const type of ['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT']) {
      expect(isNumericStorageType(type), type).toBe(true);
    }
  });

  it('accepts the unsigned variants', () => {
    for (const type of ['UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT']) {
      expect(isNumericStorageType(type), type).toBe(true);
    }
  });

  it('accepts the floating and fixed-point types', () => {
    for (const type of ['FLOAT', 'REAL', 'DOUBLE', 'DECIMAL']) {
      expect(isNumericStorageType(type), type).toBe(true);
    }
  });

  it('accepts DECIMAL with or without its parameters', () => {
    expect(isNumericStorageType('DECIMAL')).toBe(true);
    expect(isNumericStorageType('DECIMAL(18,3)')).toBe(true);
  });

  it('rejects a list or struct OF numbers — the column holds containers', () => {
    for (const type of ['BIGINT[]', 'DECIMAL(10,2)[]', 'DOUBLE[3]', 'STRUCT(x DOUBLE, y DOUBLE)', 'MAP(VARCHAR, BIGINT)']) {
      expect(isNumericStorageType(type), type).toBe(false);
    }
  });

  it('rejects text, boolean, temporal and nested types', () => {
    for (const type of [
      'VARCHAR',
      'BOOLEAN',
      'DATE',
      'TIME',
      'TIMESTAMP',
      'TIMESTAMP WITH TIME ZONE',
      'INTERVAL',
      'BLOB',
      'UUID',
      'LIST',
      'STRUCT',
      'MAP',
      'JSON',
    ]) {
      expect(isNumericStorageType(type), type).toBe(false);
    }
  });

  it('is case-insensitive and rejects the empty string', () => {
    expect(isNumericStorageType('bigint')).toBe(true);
    expect(isNumericStorageType('Double')).toBe(true);
    expect(isNumericStorageType('')).toBe(false);
  });

  it('exposes the vocabulary it matches on', () => {
    expect(NUMERIC_STORAGE_TYPES.has('BIGINT')).toBe(true);
    expect(NUMERIC_STORAGE_TYPES.has('VARCHAR')).toBe(false);
    expect(NUMERIC_STORAGE_TYPES.size).toBe(14);
  });
});
