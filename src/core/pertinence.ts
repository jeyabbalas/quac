/**
 * Data-pertinence check (json-schema-subsystem.md §E.5) — SHARED module.
 * Consumes schema-derived column expectations now; P12 feeds rules-file
 * target lists through the same shape. Matching is exact and case-sensitive
 * (no silent auto-mapping in v1 — the report must reflect real headers);
 * near-misses are reported for `schema:column:<c>:case-mismatch` warnings.
 */

export interface PertinenceColumn {
  name: string;
  required: boolean;
}

export interface PertinenceInput {
  schemaColumns: readonly PertinenceColumn[];
  datasetColumns: readonly string[];
}

export interface PertinenceResult {
  /** matched / max(1, schemaRequired.length || schemaDeclared.length) */
  score: number;
  matched: string[];
  missingRequired: string[];
  missingOptional: string[];
  extra: string[];
  /** NFC+trim+casefold equal, exact unequal. */
  caseMismatches: { dataset: string; schema: string }[];
  verdict: 'ok' | 'warn' | 'block';
}

const fold = (name: string): string => name.normalize('NFC').trim().toLowerCase();

/**
 * Null ⇒ skip (zero-property schema); the `schema:dataset:pertinence` info
 * flag for that case is emitted by the engines (P08+), not here.
 */
export function computePertinence(input: PertinenceInput): PertinenceResult | null {
  const declared = input.schemaColumns;
  if (declared.length === 0) return null;

  const datasetSet = new Set(input.datasetColumns);
  const declaredByName = new Map(declared.map((c) => [c.name, c]));
  const declaredByFold = new Map<string, string>();
  for (const c of declared) {
    if (!declaredByFold.has(fold(c.name))) declaredByFold.set(fold(c.name), c.name);
  }

  const matched = declared.filter((c) => datasetSet.has(c.name)).map((c) => c.name);
  const missing = declared.filter((c) => !datasetSet.has(c.name));
  const missingRequired = missing.filter((c) => c.required).map((c) => c.name);
  const missingOptional = missing.filter((c) => !c.required).map((c) => c.name);
  const extra = input.datasetColumns.filter((name) => !declaredByName.has(name));

  const caseMismatches: { dataset: string; schema: string }[] = [];
  for (const name of extra) {
    const schemaName = declaredByFold.get(fold(name));
    if (schemaName !== undefined && schemaName !== name && !datasetSet.has(schemaName)) {
      caseMismatches.push({ dataset: name, schema: schemaName });
    }
  }

  // Denominator: required variables, falling back to all declared; the
  // numerator uses the same universe so the score stays within [0, 1].
  const requiredNames = declared.filter((c) => c.required).map((c) => c.name);
  const universe = requiredNames.length > 0 ? requiredNames : declared.map((c) => c.name);
  const matchedInUniverse = universe.filter((name) => datasetSet.has(name)).length;
  const score = matchedInUniverse / Math.max(1, universe.length);

  const verdict: PertinenceResult['verdict'] = score < 0.5 ? 'block' : score < 1 ? 'warn' : 'ok';
  return { score, matched, missingRequired, missingOptional, extra, caseMismatches, verdict };
}
