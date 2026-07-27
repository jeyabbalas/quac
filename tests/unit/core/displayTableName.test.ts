/**
 * UX-01: `nextDisplayTableName` is what keeps two data-table builds off one
 * duckdb-wasm parquet path (the name IS the path, `<tableName>.parquet`), so
 * the only property that matters is that a name is never handed out twice —
 * including across a table that has since been dropped. The reshape behaviour
 * it buys is proven in displayGridReshape.browser.test.ts; this pins the
 * contract in node.
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
