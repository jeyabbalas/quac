import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCHEMA_DATASET_RULE_IDS,
  schemaAdvisoryRuleId,
  schemaColumnRuleId,
  schemaCondRuleId,
  schemaPropRuleId,
} from '../../../src/core/schema/rule-ids';
import { fixtureDir } from './helpers';

describe('§D.5 ruleId builders', () => {
  it('produce every documented format', () => {
    expect(schemaPropRuleId('age', 'value')).toBe('schema:prop:age:value');
    expect(schemaPropRuleId('age', 'required')).toBe('schema:prop:age:required');
    expect(schemaPropRuleId('age', 'cast')).toBe('schema:prop:age:cast');
    expect(schemaPropRuleId('age', 'precision')).toBe('schema:prop:age:precision');
    expect(schemaCondRuleId(12, 'move_reason')).toBe('schema:cond:12:move_reason');
    expect(schemaColumnRuleId('net_worth', 'missing')).toBe('schema:column:net_worth:missing');
    expect(schemaColumnRuleId('notes', 'unexpected')).toBe('schema:column:notes:unexpected');
    expect(schemaColumnRuleId('AGE', 'case-mismatch')).toBe('schema:column:AGE:case-mismatch');
    expect(schemaAdvisoryRuleId('core/core.schema.json')).toBe('schema:advisory:core/core.schema.json');
    expect(SCHEMA_DATASET_RULE_IDS.duplicateRecords).toBe('schema:dataset:duplicate-records');
    expect(SCHEMA_DATASET_RULE_IDS.minItems).toBe('schema:dataset:min-items');
    expect(SCHEMA_DATASET_RULE_IDS.empty).toBe('schema:dataset:empty');
    expect(SCHEMA_DATASET_RULE_IDS.pertinence).toBe('schema:dataset:pertinence');
  });

  it('cover every schema ruleId pinned by the P02 fixture manifests', () => {
    const seeded = JSON.parse(
      readFileSync(join(fixtureDir('hesp', 'data'), 'seeded-violations.json'), 'utf8'),
    ) as { injections: { expectedRuleIds?: string[] }[] };
    const mini = JSON.parse(
      readFileSync(join(fixtureDir('synthetic', 'mini'), 'mini_expected_flags.json'), 'utf8'),
    ) as { flags: { ruleId: string }[] };
    const pinned = new Set<string>([
      ...seeded.injections.flatMap((i) => i.expectedRuleIds ?? []),
      ...mini.flags.map((f) => f.ruleId),
    ]);

    const reproducible = new Set<string>(Object.values(SCHEMA_DATASET_RULE_IDS));
    for (const id of pinned) {
      if (!id.startsWith('schema:')) continue; // Q*/H* rules-file ids
      const parts = id.split(':');
      if (parts[1] === 'prop') {
        reproducible.add(schemaPropRuleId(parts[2] ?? '', parts[3] as 'value'));
      } else if (parts[1] === 'cond') {
        reproducible.add(schemaCondRuleId(Number(parts[2]), parts[3] ?? ''));
      } else if (parts[1] === 'column') {
        reproducible.add(schemaColumnRuleId(parts[2] ?? '', parts[3] as 'missing'));
      }
    }
    for (const id of pinned) {
      if (id.startsWith('schema:')) expect(reproducible).toContain(id);
    }
  });
});
