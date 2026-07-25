/**
 * Storage-type classification for the preview table's right-alignment
 * (UIX-4 §4). Node-tested: the module reads no DOM at import time.
 *
 * The vocabulary matters because `describeColumns` (casting.ts:60) has already
 * stripped type parameters and upper-cased, so DECIMAL(18,3) arrives here as
 * a bare `DECIMAL`.
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

  it('accepts DECIMAL as describeColumns delivers it — parameters already stripped', () => {
    expect(isNumericStorageType('DECIMAL')).toBe(true);
    // Belt and braces: an unstripped one must not silently pass as numeric.
    expect(isNumericStorageType('DECIMAL(18,3)')).toBe(false);
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
