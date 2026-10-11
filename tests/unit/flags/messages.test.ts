import { describe, expect, it } from 'vitest';
import { renderFlag, renderFlagMessage } from '../../../src/core/flags/messages';
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

describe('corrections of nested values', () => {
  it('names the struct fields that changed', () => {
    const f = flag({
      correction: {
        before: { street: '611 Pine Ct', city: 'Lakeside', country: 'us', unit: null },
        after: { street: '611 Pine Ct', city: 'Lakeside', country: 'US', unit: null },
      },
    });
    expect(renderFlagMessage(f)).toBe("150 exceeds the maximum 100. (corrected: country: 'us' → 'US')");
  });

  it('names the list items that changed, counted from 1', () => {
    const f = flag({ correction: { before: ['e11.9', 'I10'], after: ['E11.9', 'I10'] } });
    expect(renderFlagMessage(f)).toBe("150 exceeds the maximum 100. (corrected: [1]: 'e11.9' → 'E11.9')");
  });

  it('prints the whole value when everything changed — cut at 80 characters', () => {
    expect(renderFlagMessage(flag({ correction: { before: ['+1 555-010-2030'], after: ['+15550102030'] } }))).toBe(
      '150 exceeds the maximum 100. (corrected: ["+1 555-010-2030"] → ["+15550102030"])',
    );
    const long = Array.from({ length: 100 }, (_, i) => i);
    const message = renderFlagMessage(flag({ correction: { before: long, after: [] } }));
    expect(message).toBe(
      `150 exceeds the maximum 100. (corrected: ${JSON.stringify(long).slice(0, 79)}… → [])`,
    );
  });
});

/** UX-09 — the id-free half, for surfaces that print the ruleId themselves. */
describe('renderFlagMessage', () => {
  /** The live repro id: 106 chars, and the message already names the file. */
  const advisory = flag({
    ruleId:
      'schema:advisory:http://localhost:4173/quac/examples/json_schema/core/categories/household_composition.json',
    scope: 'dataset',
    row: undefined,
    column: undefined,
    severity: 'info',
    message:
      'Schema note (core/categories/household_composition.json): Soft checks: adult_count + child_count should equal household_size.',
  });

  it('omits the ruleId, so the sentence leads and the file is named once', () => {
    expect(renderFlagMessage(advisory)).toBe(advisory.message);
    expect(renderFlagMessage(advisory).startsWith('schema:advisory:')).toBe(false);
    expect(renderFlagMessage(advisory)).not.toContain('http://');
  });

  it('still appends the correction suffix, with the same quoting', () => {
    expect(renderFlagMessage(flag({ correction: { before: 999, after: -999 } }))).toBe(
      '150 exceeds the maximum 100. (corrected: 999 → -999)',
    );
    expect(renderFlagMessage(flag({ correction: { before: 'N/A', after: null } }))).toBe(
      "150 exceeds the maximum 100. (corrected: 'N/A' → null)",
    );
  });

  it('is renderFlag minus the prefix — the suffix has ONE implementation', () => {
    for (const f of [advisory, flag({}), flag({ correction: { before: 'N/A', after: null } })]) {
      expect(renderFlag(f)).toBe(`${f.ruleId}: ${renderFlagMessage(f)}`);
    }
  });
});
