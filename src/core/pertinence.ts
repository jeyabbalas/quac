/**
 * Data-pertinence check (json-schema-subsystem.md §E.5) — SHARED module.
 * Consumes schema-derived column expectations now; P12 feeds rules-file
 * target lists through the same shape. Matching is exact and case-sensitive
 * (no silent auto-mapping in v1 — the report must reflect real headers);
 * near-misses are reported for `schema:column:<c>:case-mismatch` warnings.
 *
 * `computePertinence` scores ONE ordered pair. `crossCheckInputs` below runs
 * it over all three pairs the Load view can form — dataset↔schema,
 * dataset↔rules, schema↔rules — and reads the pattern of failures to name
 * which of the three inputs is the odd one out.
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

/* ---- Three-way cross-check ------------------------------------------------
   The Load view holds three artifacts that are all supposed to describe the
   same table, so there are three pairs to check, not one. Each pair is the
   same question `computePertinence` already answers — what fraction of the
   names B expects appear in A's name universe? — so no matching logic is
   added here; this is aggregation and triangulation only. ------------------ */

export type PertinenceEdgeId = 'data-schema' | 'data-rules' | 'schema-rules';
export type PertinenceSuspect = 'dataset' | 'schema' | 'rules';

export interface PertinenceEdge {
  id: PertinenceEdgeId;
  /** Expected names present in the universe — the score's numerator. */
  found: number;
  /** Expected names looked for — the score's denominator. */
  total: number;
  score: number;
  verdict: 'ok' | 'warn' | 'block';
  /** Expected but absent, required first (schema order). Copy quotes three. */
  missing: string[];
  /**
   * Near-misses, in `computePertinence`'s field names: `dataset` is the name
   * found in the UNIVERSE, `schema` the expected name it nearly matches. On
   * the schema-rules edge that means a schema variable and a rule target.
   */
  caseMismatches: { dataset: string; schema: string }[];
}

export interface CrossCheckInput {
  datasetColumns?: readonly string[];
  schemaColumns?: readonly PertinenceColumn[];
  /** Distinct targets of the executable (validate/correct) rules. */
  ruleTargets?: readonly string[];
}

export interface CrossCheck {
  /** Only the computable edges, in `data-schema → data-rules → schema-rules` order. */
  edges: PertinenceEdge[];
  /** The worst edge's verdict; `ok` when there is no edge to judge. */
  verdict: 'ok' | 'warn' | 'block';
  /** Lowest score, ties broken by edge order. Null when `edges` is empty. */
  weakest: PertinenceEdge | null;
  /** The input two bad edges agree on — see `suspectOf`. */
  suspect: PertinenceSuspect | null;
}

/** The two artifacts each edge spans. */
const VERTICES: Record<PertinenceEdgeId, readonly [PertinenceSuspect, PertinenceSuspect]> = {
  'data-schema': ['dataset', 'schema'],
  'data-rules': ['dataset', 'rules'],
  'schema-rules': ['schema', 'rules'],
};

const RANK: Record<PertinenceEdge['verdict'], number> = { ok: 0, warn: 1, block: 2 };

/**
 * The score's denominator, spelled out: `computePertinence` scores against the
 * REQUIRED names, falling back to all declared when none are. The copy quotes
 * `found of total`, so that pair has to be the fraction the verdict came from.
 */
function scoredNames(expected: readonly PertinenceColumn[]): string[] {
  const required = expected.filter((c) => c.required).map((c) => c.name);
  return required.length > 0 ? required : expected.map((c) => c.name);
}

/**
 * Null ⇒ this edge does not exist: one of its two artifacts is absent or
 * carries no names at all, which is not a mismatch, it is nothing to compare.
 */
function buildEdge(
  id: PertinenceEdgeId,
  universe: readonly string[] | undefined,
  expected: readonly PertinenceColumn[] | undefined,
): PertinenceEdge | null {
  if (universe === undefined || universe.length === 0) return null;
  if (expected === undefined || expected.length === 0) return null;
  const result = computePertinence({ schemaColumns: expected, datasetColumns: universe });
  if (result === null) return null;

  const present = new Set(universe);
  const scored = scoredNames(expected);
  return {
    id,
    found: scored.filter((name) => present.has(name)).length,
    total: scored.length,
    score: result.score,
    verdict: result.verdict,
    missing: [...result.missingRequired, ...result.missingOptional],
    caseMismatches: result.caseMismatches,
  };
}

/**
 * Which input is the odd one out. An edge is BAD at `score < 0.5` — the same
 * threshold §E.5 already calls a block; a `warn` edge is ordinary partial
 * data, not a file from another project, so it deliberately does not count.
 *
 * With all three edges present, exactly two bad ones always share exactly one
 * vertex, and that shared artifact is the one both failures run through:
 *
 *   data-schema + data-rules  → the dataset fits neither of the other two
 *   data-schema + schema-rules → the schema fits neither
 *   data-rules  + schema-rules → the rules fit neither
 *
 * Nothing else identifies anyone. One bad edge names a disagreeing PAIR with
 * no third opinion to break the tie; three bad edges mean all three inputs are
 * mutually foreign; fewer than three edges cannot triangulate at all.
 */
function suspectOf(edges: readonly PertinenceEdge[]): PertinenceSuspect | null {
  if (edges.length < 3) return null;
  const bad = edges.filter((e) => e.verdict === 'block');
  if (bad.length !== 2) return null;
  const [first, second] = bad;
  if (first === undefined || second === undefined) return null;
  const shared = VERTICES[first.id].filter((v) => VERTICES[second.id].includes(v));
  return shared.length === 1 ? (shared[0] ?? null) : null;
}

/** Every pairwise check the loaded inputs support, plus the verdict over them. */
export function crossCheckInputs(input: CrossCheckInput): CrossCheck {
  // Rule targets are all "required": a rule that cannot bind its target does
  // not run, so there is no optional tier to fall back to.
  const targets = input.ruleTargets?.map((name) => ({ name, required: true }));
  const schemaNames = input.schemaColumns?.map((c) => c.name);

  const edges = [
    buildEdge('data-schema', input.datasetColumns, input.schemaColumns),
    buildEdge('data-rules', input.datasetColumns, targets),
    buildEdge('schema-rules', schemaNames, targets),
  ].filter((edge) => edge !== null);

  const verdict = edges.reduce<PertinenceEdge['verdict']>(
    (worst, edge) => (RANK[edge.verdict] > RANK[worst] ? edge.verdict : worst),
    'ok',
  );
  const weakest = edges.reduce<PertinenceEdge | null>(
    (lowest, edge) => (lowest === null || edge.score < lowest.score ? edge : lowest),
    null,
  );

  return { edges, verdict, weakest, suspect: suspectOf(edges) };
}
