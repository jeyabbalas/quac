/**
 * Schema-engine ruleId scheme (json-schema-subsystem.md §D.5) — the grouping
 * key for Sheet-4 tallies. Stable for an unchanged schema set (the allOf index
 * is positional: ids are within-report provenance, not cross-version keys).
 * Consumed by the P08 translator and P09's casting/dataset checks; formats
 * must match the ids pinned in tests/fixtures/hesp/data/seeded-violations.json
 * and tests/fixtures/synthetic/mini/mini_expected_flags.json.
 */

export type SchemaPropKind = 'value' | 'required' | 'cast' | 'precision';
export type SchemaColumnKind = 'missing' | 'unexpected' | 'case-mismatch';

/** `schema:prop:<column>:<kind>` — cell-scope property findings. */
export function schemaPropRuleId(column: string, kind: SchemaPropKind): string {
  return `schema:prop:${column}:${kind}`;
}

/** `schema:cond:<allOfIndex>:<column>` — if/then violation on the THEN target. */
export function schemaCondRuleId(allOfIndex: number, column: string): string {
  return `schema:cond:${String(allOfIndex)}:${column}`;
}

/** `schema:column:<column>:<kind>` — column-scope findings. */
export function schemaColumnRuleId(column: string, kind: SchemaColumnKind): string {
  return `schema:column:${column}:${kind}`;
}

/** `schema:advisory:<fileId>` — category/root-level $comment soft checks. */
export function schemaAdvisoryRuleId(fileId: string): string {
  return `schema:advisory:${fileId}`;
}

/** Dataset-scope ids (emitted by P09's SQL checks in validation-run.ts). */
export const SCHEMA_DATASET_RULE_IDS = {
  duplicateRecords: 'schema:dataset:duplicate-records',
  minItems: 'schema:dataset:min-items',
  empty: 'schema:dataset:empty',
  pertinence: 'schema:dataset:pertinence',
} as const;
