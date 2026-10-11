/**
 * UX-01: `nextDisplayTableName` kept two data-table builds off one duckdb-wasm
 * parquet path while the library derived that path from the table name
 * (`<tableName>.parquet`, through 0.8). Since 0.9 the library generates the
 * path itself, so the suffix is no longer load-bearing — but the property it
 * promises is still that a name is never handed out twice, including across a
 * table that has since been dropped, and this pins that contract in node. The
 * reshape behaviour is proven end to end in displayGridReshape.browser.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  QUAC_DISPLAY,
  QUAC_STUDIO_DISPLAY,
  nextDisplayTableName,
} from '../../../src/core/bridge/tables';

describe('nextDisplayTableName', () => {
  it('never repeats a name, across bases', () => {
    const names: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      names.push(nextDisplayTableName(QUAC_DISPLAY));
      names.push(nextDisplayTableName(QUAC_STUDIO_DISPLAY));
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the base as a prefix, so the tables stay recognisable', () => {
    expect(nextDisplayTableName(QUAC_DISPLAY)).toMatch(
      new RegExp(`^${QUAC_DISPLAY}_\\d+$`),
    );
    expect(nextDisplayTableName(QUAC_STUDIO_DISPLAY)).toMatch(
      new RegExp(`^${QUAC_STUDIO_DISPLAY}_\\d+$`),
    );
  });

  it('yields a bare SQL identifier — no quoting needed at the call sites', () => {
    expect(nextDisplayTableName(QUAC_DISPLAY)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });
});
