/**
 * Standard JSON text for the DuckDB types JSON lacks (src/core/schema/canonical.ts).
 * Inputs are DuckDB 1.5's own text for each type (`CAST(… AS VARCHAR)` /
 * `to_json`), as probed on both runtimes.
 */
import { describe, expect, test } from 'vitest';
import {
  blobBase64,
  canonicalKindOf,
  canonicalValue,
  float32Shortest,
  intervalIso,
  timestampText,
  timestamptzText,
  timetzText,
} from '../../../src/core/schema/canonical';

describe('canonicalKindOf', () => {
  test('names the types whose DuckDB text is not the standard one', () => {
    expect(canonicalKindOf('TIMESTAMP')).toBe('timestamp');
    expect(canonicalKindOf('TIMESTAMP_NS')).toBe('timestamp');
    expect(canonicalKindOf('TIMESTAMP WITH TIME ZONE')).toBe('timestamptz');
    expect(canonicalKindOf('TIME WITH TIME ZONE')).toBe('timetz');
    expect(canonicalKindOf('INTERVAL')).toBe('interval');
    expect(canonicalKindOf('BLOB')).toBe('blob');
    expect(canonicalKindOf('FLOAT')).toBe('float');
    for (const t of ['DATE', 'TIME', 'UUID', 'VARCHAR', 'DOUBLE', 'DECIMAL', 'BIGINT']) {
      expect(canonicalKindOf(t), t).toBeUndefined();
    }
  });
});

describe('dates and times', () => {
  test('TIMESTAMP: the T separator, nothing else changed', () => {
    expect(timestampText('2024-01-15 08:30:00')).toBe('2024-01-15T08:30:00');
    expect(timestampText('2024-01-15 08:30:00.123456789')).toBe('2024-01-15T08:30:00.123456789');
    expect(timestampText('infinity')).toBe('infinity');
    expect(timestampText('10000-01-01 00:00:00')).toBe('10000-01-01T00:00:00');
  });

  test('TIMESTAMPTZ: RFC 3339, Z for UTC and ±hh:mm otherwise', () => {
    expect(timestamptzText('2024-01-15 03:00:00+00')).toBe('2024-01-15T03:00:00Z');
    expect(timestamptzText('2024-01-15 03:00:00.5-05:30')).toBe('2024-01-15T03:00:00.5-05:30');
    expect(timestamptzText('2024-01-15 03:00:00+05')).toBe('2024-01-15T03:00:00+05:00');
  });

  test('TIMETZ: ±hh:mm offsets', () => {
    expect(timetzText('14:30:45+05:30')).toBe('14:30:45+05:30');
    expect(timetzText('14:30:45.5-08')).toBe('14:30:45.5-08:00');
    expect(timetzText('14:30:45+00')).toBe('14:30:45Z');
  });
});

describe('INTERVAL → ISO 8601 duration', () => {
  test.each([
    ['1 year 2 months 3 days 04:05:06.5', 'P1Y2M3DT4H5M6.5S'],
    ['3 years 2 months', 'P3Y2M'],
    ['14 days', 'P14D'],
    ['36:00:00', 'PT36H'],
    ['00:00:00.000001', 'PT0.000001S'],
    ['00:00:00', 'PT0S'],
    ['-1 day', '-P1D'],
    ['-00:00:01.5', '-PT1.5S'],
    ['2 years 1 month 1 day 01:02:03', 'P2Y1M1DT1H2M3S'],
    // Mixed signs have no ISO 8601 form; signed components fail every duration format.
    ['1 month -2 days', 'P1M-2D'],
  ])('%s → %s', (text, iso) => {
    expect(intervalIso(text)).toBe(iso);
  });
});

describe('BLOB → base64', () => {
  test('decodes DuckDB’s \\xHH escapes and printable bytes alike', () => {
    expect(blobBase64('\\x00\\x5C\\x22A\\xFF~\\x7F\\x0A')).toBe('AFwiQf9+fwo=');
    expect(blobBase64('')).toBe('');
  });
});

describe('FLOAT → the shortest decimal that is that float', () => {
  test('to_json widens; this narrows back', () => {
    expect(float32Shortest(0.10000000149011612)).toBe(0.1);
    expect(float32Shortest(3.4028234663852886e38)).toBe(3.4028235e38);
    expect(Object.is(float32Shortest(-0), -0)).toBe(true);
    expect(float32Shortest(Number.NaN)).toBeNaN();
  });

  test('canonicalValue dispatches, leaving non-matching values alone', () => {
    expect(canonicalValue('float', 0.10000000149011612)).toBe(0.1);
    expect(canonicalValue('timestamp', 42)).toBe(42);
  });
});
