import { describe, expect, it } from 'vitest';
import { renderFlag } from '../../../src/core/flags/messages';
import type { QCFlag } from '../../../src/core/flags/flag';

function flag(overrides: Partial<QCFlag>): QCFlag {
  return {
    source: 'schema',
    ruleId: 'schema:prop:age:value',
    scope: 'cell',
    row: 3,
    column: 'age',
    severity: 'error',
    message: '150 exceeds the maximum 100.',
    ...overrides,
  };
}

describe('renderFlag', () => {
  it('renders "{ruleId}: {message}"', () => {
    expect(renderFlag(flag({}))).toBe('schema:prop:age:value: 150 exceeds the maximum 100.');
  });

  it('appends the correction suffix (qc-rules-format §5 shape)', () => {
    const f = flag({
      source: 'rules',
      ruleId: 'Q047',
      severity: 'info',
      message: 'Legacy 999 recoded to -999.',
      correction: { before: 999, after: -999 },
    });
    expect(renderFlag(f)).toBe('Q047: Legacy 999 recoded to -999. (corrected: 999 → -999)');
  });

  it('quotes string correction values and renders null for SQL NULL', () => {
    const f = flag({ correction: { before: 'N/A', after: null } });
    expect(renderFlag(f)).toBe(
      "schema:prop:age:value: 150 exceeds the maximum 100. (corrected: 'N/A' → null)",
    );
  });
});
