/**
 * JSON Schema conformance of a whole run: for each JSON dataset under
 * tests/fixtures/conformance/, QuaC's findings must say what a JSON Schema
 * validator says about the same file — record by record, key by key.
 *
 * Two readings of one file:
 * - **direct** — the parsed document validated against the root schema by
 *   QuaC's own validator (buildAjv, the files registered as the worker
 *   registers them), exactly as any JSON Schema validator would treat it;
 * - **QuaC** — `runQuac` end to end: ingest into DuckDB, the record loop, the
 *   translator, the dataset-wide checks.
 * What the pipeline adds between them — DuckDB's reading of the file, row
 * shaping, translation, the column and dataset checks — is what is under
 * test; the validator's own correctness is the JSON Schema Test Suite's job
 * (keywords.test.ts, formats.test.ts).
 *
 * QuaC's conventions are folded in where they are one finding for many: a
 * required variable absent from every record is one `missing` column flag; a
 * column the schema rejects is one `unexpected` column flag; precision
 * warnings and information flags are not errors.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildAjv, registerSchemaFiles } from '../../../src/core/schema/ajv-engine';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { runQuac } from '../../../src/headless/run';
import type { QCFlag } from '../../../src/core/flags/flag';

const DIR = resolve(__dirname, '..', '..', 'fixtures', 'conformance');
const SLOW = 60_000;

interface DirectError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
}

const unescape = (s: string): string => s.replaceAll('~1', '/').replaceAll('~0', '~');

/** The direct verdict, split as QuaC reports: per record key, per record, per dataset. */
interface Verdict {
  cells: Map<string, Set<string>>;
  /** Cells whose every error lies inside a union's branch (`…/anyOf/1/…`, `…/oneOf/0/…`). */
  inUnion: Set<string>;
  rows: Set<number>;
  dataset: Set<string>;
}

const key = (row: number, column: string): string => `${String(row)}|${column}`;

async function direct(dataset: string, schema: string): Promise<Verdict> {
  const set = await buildSchemaSet([{ relativePath: schema, raw: await readFile(join(DIR, schema), 'utf8') }], {
    origin: 'upload',
  });
  const root = set.files.find((f) => f.fileId === set.root.rootFileId);
  if (root === undefined) throw new Error(`${schema}: no root`);
  const ajv = buildAjv(root.draft);
  registerSchemaFiles(
    ajv,
    set.schemas.map((f) => ({ uri: f.retrievalUri, json: f.json })),
    root.draft,
  );
  const validate = ajv.getSchema(root.retrievalUri);
  if (validate === undefined) throw new Error(`${schema}: does not compile`);
  // Synchronous (no `$async` schema here); the verdict is read off `errors`.
  void validate(JSON.parse(await readFile(join(DIR, dataset), 'utf8')) as unknown);
  const verdict: Verdict = { cells: new Map(), inUnion: new Set(), rows: new Set(), dataset: new Set() };
  const outsideUnion = new Set<string>();
  for (const error of (validate.errors ?? []) as DirectError[]) {
    // A non-matching record's errors under a ROOT `contains` are not findings:
    // the `contains` error itself is.
    if (error.instancePath !== '' && /^#\/(?:contains|minContains|maxContains)(?:\/|$)/.test(error.schemaPath)) continue;
    const segments = error.instancePath === '' ? [] : error.instancePath.slice(1).split('/').map(unescape);
    const [rowText, column] = segments;
    if (rowText === undefined) {
      verdict.dataset.add(error.keyword);
      continue;
    }
    const row = Number(rowText);
    const named =
      column ??
      [error.params.missingProperty, error.params.additionalProperty, error.params.unevaluatedProperty, error.params.propertyName].find(
        (p): p is string => typeof p === 'string',
      );
    if (named === undefined) {
      verdict.rows.add(row);
      continue;
    }
    const at = key(row, named);
    const kinds = verdict.cells.get(at) ?? new Set<string>();
    kinds.add(error.keyword);
    verdict.cells.set(at, kinds);
    if (/\/(?:anyOf|oneOf)\/\d+\//.test(error.schemaPath)) verdict.inUnion.add(at);
    else outsideUnion.add(at);
  }
  for (const at of outsideUnion) verdict.inUnion.delete(at);
  return verdict;
}

/** QuaC dataset-scope ids, by the root keyword each one answers. */
const DATASET_KIND: Readonly<Record<string, string>> = {
  uniqueItems: 'duplicate-records',
  minItems: 'min-items',
  maxItems: 'max-items',
  contains: 'contains',
  items: 'items',
  additionalItems: 'items',
  unevaluatedItems: 'items',
};

let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'quac-conformance-'));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function quac(dataset: string, schema: string): Promise<QCFlag[]> {
  const result = await runQuac({
    dataset: join(DIR, dataset),
    schema: [join(DIR, schema)],
    out: outDir,
    applyCorrections: false,
  });
  expect(result.artifacts.stageErrors).toEqual([]);
  return result.artifacts.flagStore
    .all()
    .map((e) => e.flag)
    .filter((f) => f.source === 'schema');
}

/** Every disagreement between the two readings, in words. */
async function disagreements(dataset: string, schema: string): Promise<string[]> {
  const want = await direct(dataset, schema);
  const flags = await quac(dataset, schema);
  const errors = flags.filter((f) => f.severity === 'error');
  const columnKinds = new Map<string, Set<string>>();
  for (const f of errors.filter((e) => e.scope === 'column')) {
    const kinds = columnKinds.get(f.column ?? '') ?? new Set<string>();
    kinds.add(f.ruleId.split(':').at(-1) ?? '');
    columnKinds.set(f.column ?? '', kinds);
  }
  const quacCells = new Map<string, QCFlag[]>();
  const quacRows = new Set<number>();
  for (const f of errors) {
    if (f.row === undefined) continue;
    quacRows.add(f.row);
    if (f.column === undefined) continue;
    const at = key(f.row, f.column);
    quacCells.set(at, [...(quacCells.get(at) ?? []), f]);
  }
  const out: string[] = [];
  const quacRowScope = new Set(errors.filter((f) => f.scope === 'row').map((f) => f.row ?? -1));
  for (const [at, kinds] of want.cells) {
    if (quacCells.has(at)) continue;
    // A record-level union no branch of which holds is one record flag
    // ("the record needs exactly one of: 'spouse', 'note'"), not one per branch.
    if (want.inUnion.has(at) && quacRowScope.has(Number(at.slice(0, at.indexOf('|'))))) continue;
    const column = at.slice(at.indexOf('|') + 1);
    const folded = columnKinds.get(column);
    const coveredByMissing = folded?.has('missing') === true && [...kinds].every((k) => k === 'required');
    const coveredByUnexpected =
      folded?.has('unexpected') === true &&
      [...kinds].every((k) => k === 'additionalProperties' || k === 'unevaluatedProperties');
    if (!coveredByMissing && !coveredByUnexpected) out.push(`missed ${at}: ${[...kinds].join(', ')}`);
  }
  for (const [at, found] of quacCells) {
    const row = Number(at.slice(0, at.indexOf('|')));
    if (!want.cells.has(at) && !want.rows.has(row)) out.push(`extra ${at}: ${found.map((f) => f.message).join(' | ')}`);
  }
  for (const row of want.rows) if (!quacRows.has(row)) out.push(`missed row ${String(row)}`);
  for (const f of errors.filter((e) => e.scope === 'row')) {
    const row = f.row ?? -1;
    const hasDirect = want.rows.has(row) || [...want.cells.keys()].some((at) => at.startsWith(`${String(row)}|`));
    if (!hasDirect) out.push(`extra row ${String(row)}: ${f.message}`);
  }
  const quacDataset = new Set(
    errors.filter((f) => f.scope === 'dataset').map((f) => f.ruleId.replace('schema:dataset:', '')),
  );
  for (const keyword of want.dataset) {
    const kind = DATASET_KIND[keyword];
    if (kind === undefined || !quacDataset.has(kind)) out.push(`missed dataset ${keyword}`);
  }
  for (const kind of quacDataset) {
    const answers = Object.entries(DATASET_KIND).filter(([, k]) => k === kind).map(([keyword]) => keyword);
    if (!answers.some((keyword) => want.dataset.has(keyword))) out.push(`extra dataset ${kind}`);
  }
  return out;
}

const CASES: [string, string, string][] = [
  ['ISO date-times, dates, times with and without offsets — and the malformed ones', 'temporal.json', 'temporal.schema.json'],
  ['explicit null beside a missing key, top level and nested', 'nulls.json', 'nulls.schema.json'],
  ['nested objects whose keys come and go', 'nested-presence.json', 'nested-presence.schema.json'],
  ['conditions, dependentRequired and oneOf on missing and null properties', 'conditions.json', 'conditions.schema.json'],
  ['values in the wrong JSON type, both ways', 'types.json', 'types.schema.json'],
  ['integers past 2^53 and 2^64, 1.0, -0, 1e400, numeric strings', 'numbers.json', 'numbers.schema.json'],
  ['decimals under multipleOf', 'money.json', 'money.schema.json'],
  ['UUIDs in both cases and with a urn:uuid: prefix', 'uuids.json', 'uuids.schema.json'],
  ['records equal as JSON but written differently (uniqueItems)', 'unique.json', 'unique.schema.json'],
  ['prefixItems, contains, maxItems and uniqueItems on the dataset', 'root.json', 'root-a.schema.json'],
  ['a draft-07 tuple of records', 'root.json', 'root-b.schema.json'],
  ['a root that is only a $ref', 'root.json', 'root-c.schema.json'],
];

describe('QuaC agrees with a JSON Schema validator run on the file', () => {
  test.each(CASES)(
    '%s',
    async (_label, dataset, schema) => {
      expect(await disagreements(dataset, schema)).toEqual([]);
    },
    SLOW,
  );

  test('and the comparison is not vacuous: every case has findings to agree on', async () => {
    for (const [, dataset, schema] of CASES) {
      const verdict = await direct(dataset, schema);
      expect(verdict.cells.size + verdict.rows.size + verdict.dataset.size, schema).toBeGreaterThan(0);
    }
  });
});
