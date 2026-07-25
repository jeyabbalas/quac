/**
 * §E.5 shared pertinence check: thresholds, case-mismatch near-misses,
 * zero-property skip, required-fallback denominator — and the three-way
 * cross-check built on top of it, whose job is to name which of the three
 * loaded inputs is the odd one out.
 */
import { describe, expect, it } from 'vitest';
import { computePertinence, crossCheckInputs } from '../../../src/core/pertinence';
import type { PertinenceColumn, PertinenceEdgeId } from '../../../src/core/pertinence';

const required = (...names: string[]): PertinenceColumn[] =>
  names.map((name) => ({ name, required: true }));

describe('computePertinence thresholds', () => {
  const schemaColumns = required('a', 'b', 'c', 'd', 'e');

  it('score 0 → block', () => {
    const result = computePertinence({ schemaColumns, datasetColumns: ['x', 'y'] });
    expect(result?.score).toBe(0);
    expect(result?.verdict).toBe('block');
    expect(result?.matched).toEqual([]);
    expect(result?.missingRequired).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result?.extra).toEqual(['x', 'y']);
  });

  it('score 0.4 → block', () => {
    const result = computePertinence({ schemaColumns, datasetColumns: ['a', 'b'] });
    expect(result?.score).toBe(0.4);
    expect(result?.verdict).toBe('block');
  });

  it('score 0.6 → warn', () => {
    const result = computePertinence({ schemaColumns, datasetColumns: ['a', 'b', 'c'] });
    expect(result?.score).toBe(0.6);
    expect(result?.verdict).toBe('warn');
    expect(result?.missingRequired).toEqual(['d', 'e']);
  });

  it('score 1.0 → ok (extras allowed)', () => {
    const result = computePertinence({
      schemaColumns,
      datasetColumns: ['a', 'b', 'c', 'd', 'e', 'extra_1'],
    });
    expect(result?.score).toBe(1);
    expect(result?.verdict).toBe('ok');
    expect(result?.extra).toEqual(['extra_1']);
  });
});

describe('computePertinence details', () => {
  it('detects AGE vs age as a case mismatch, not a match', () => {
    const result = computePertinence({
      schemaColumns: required('age', 'name'),
      datasetColumns: ['AGE', 'name'],
    });
    expect(result?.matched).toEqual(['name']);
    expect(result?.missingRequired).toEqual(['age']);
    expect(result?.caseMismatches).toEqual([{ dataset: 'AGE', schema: 'age' }]);
    expect(result?.score).toBe(0.5);
    expect(result?.verdict).toBe('warn');
  });

  it('folds NFC + trim for near-miss detection only', () => {
    const result = computePertinence({
      schemaColumns: required('née'),
      datasetColumns: ['née '],
    });
    expect(result?.caseMismatches).toEqual([{ dataset: 'née ', schema: 'née' }]);
  });

  it('skips zero-property schemas (null)', () => {
    expect(computePertinence({ schemaColumns: [], datasetColumns: ['a'] })).toBeNull();
  });

  it('falls back to all declared columns when none are required', () => {
    const result = computePertinence({
      schemaColumns: [
        { name: 'a', required: false },
        { name: 'b', required: false },
      ],
      datasetColumns: ['a'],
    });
    expect(result?.score).toBe(0.5);
    expect(result?.missingOptional).toEqual(['b']);
    expect(result?.verdict).toBe('warn');
  });

  it('mixed required/optional: score counts required only', () => {
    const result = computePertinence({
      schemaColumns: [...required('a', 'b'), { name: 'c', required: false }],
      datasetColumns: ['a', 'b'],
    });
    expect(result?.score).toBe(1);
    expect(result?.verdict).toBe('ok');
    expect(result?.missingOptional).toEqual(['c']);
  });
});

const ids = (edges: readonly { id: PertinenceEdgeId }[]): PertinenceEdgeId[] =>
  edges.map((e) => e.id);

describe('crossCheckInputs edge presence', () => {
  it('builds all three edges when all three inputs are loaded', () => {
    const check = crossCheckInputs({
      datasetColumns: ['a', 'b'],
      schemaColumns: required('a', 'b'),
      ruleTargets: ['a'],
    });
    expect(ids(check.edges)).toEqual(['data-schema', 'data-rules', 'schema-rules']);
    expect(check.verdict).toBe('ok');
  });

  it('builds the one edge two loaded inputs can form', () => {
    const columns = ['a', 'b'];
    expect(
      ids(crossCheckInputs({ datasetColumns: columns, schemaColumns: required('a') }).edges),
    ).toEqual(['data-schema']);
    expect(ids(crossCheckInputs({ datasetColumns: columns, ruleTargets: ['a'] }).edges)).toEqual([
      'data-rules',
    ]);
    expect(
      ids(crossCheckInputs({ schemaColumns: required('a', 'b'), ruleTargets: ['a'] }).edges),
    ).toEqual(['schema-rules']);
  });

  it('has nothing to say about one input, or none — and never calls that a failure', () => {
    for (const input of [
      {},
      { datasetColumns: ['a'] },
      { schemaColumns: required('a') },
      { ruleTargets: ['a'] },
    ]) {
      const check = crossCheckInputs(input);
      expect(check.edges).toEqual([]);
      expect(check.verdict).toBe('ok');
      expect(check.weakest).toBeNull();
      expect(check.suspect).toBeNull();
    }
  });

  it('drops an edge whose artifact is loaded but carries no names', () => {
    // A zero-column dataset or a zero-property schema is nothing to compare
    // against, not a 0% match.
    expect(
      ids(crossCheckInputs({ datasetColumns: [], schemaColumns: required('a') }).edges),
    ).toEqual([]);
    expect(ids(crossCheckInputs({ datasetColumns: ['a'], schemaColumns: [] }).edges)).toEqual([]);
    expect(
      ids(crossCheckInputs({ datasetColumns: ['a'], schemaColumns: required('a'), ruleTargets: [] }).edges),
    ).toEqual(['data-schema']);
  });
});

describe('crossCheckInputs edges', () => {
  it('scores each edge against its own universe', () => {
    const check = crossCheckInputs({
      datasetColumns: ['a', 'b', 'x'],
      schemaColumns: required('a', 'b', 'c', 'd'),
      ruleTargets: ['a', 'b'],
    });
    const [dataSchema, dataRules, schemaRules] = check.edges;
    // 2 of the schema's 4 variables are in the dataset…
    expect(dataSchema).toMatchObject({ found: 2, total: 4, score: 0.5, verdict: 'warn' });
    // …both rule targets are columns…
    expect(dataRules).toMatchObject({ found: 2, total: 2, score: 1, verdict: 'ok' });
    // …and both are declared, so only the dataset is short.
    expect(schemaRules).toMatchObject({ found: 2, total: 2, score: 1, verdict: 'ok' });
  });

  it('keeps found/total as the fraction the verdict came from', () => {
    for (const columns of [[], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e']]) {
      const edge = crossCheckInputs({
        datasetColumns: ['a', 'b', 'c', 'd', 'e'],
        schemaColumns: required(...columns, 'z'),
      }).edges[0];
      if (edge === undefined) continue;
      expect(edge.found / edge.total).toBe(edge.score);
    }
  });

  it('scores against required names, falling back to all declared', () => {
    const optional = crossCheckInputs({
      datasetColumns: ['a'],
      schemaColumns: [
        { name: 'a', required: false },
        { name: 'b', required: false },
      ],
    }).edges[0];
    expect(optional).toMatchObject({ found: 1, total: 2, score: 0.5 });

    const mixed = crossCheckInputs({
      datasetColumns: ['a', 'b'],
      schemaColumns: [...required('a', 'b'), { name: 'c', required: false }],
    }).edges[0];
    expect(mixed).toMatchObject({ found: 2, total: 2, score: 1, verdict: 'ok' });
    // Still absent, still worth naming — just not worth scoring against.
    expect(mixed?.missing).toEqual(['c']);
  });

  it('lists missing names required-first, and passes near-misses through', () => {
    const edge = crossCheckInputs({
      datasetColumns: ['AGE', 'name'],
      schemaColumns: [...required('name', 'height'), { name: 'weight', required: false }, ...required('age')],
    }).edges[0];
    expect(edge?.missing).toEqual(['height', 'age', 'weight']);
    expect(edge?.caseMismatches).toEqual([{ dataset: 'AGE', schema: 'age' }]);
  });

  it('applies the §E.5 thresholds per edge', () => {
    const at = (columns: string[]): string | undefined =>
      crossCheckInputs({ datasetColumns: columns, schemaColumns: required('a', 'b', 'c', 'd', 'e') })
        .edges[0]?.verdict;
    expect(at(['a', 'b'])).toBe('block'); // 0.4
    expect(at(['a', 'b', 'c'])).toBe('warn'); // 0.6
    expect(at(['a', 'b', 'c', 'd', 'e'])).toBe('ok'); // 1.0
  });
});

describe('crossCheckInputs verdict and weakest', () => {
  it('takes the worst edge as the overall verdict', () => {
    const check = crossCheckInputs({
      datasetColumns: ['a', 'b', 'c'],
      schemaColumns: required('a', 'b', 'c'), // ok
      ruleTargets: ['a', 'x', 'y', 'z'], // 1/4 against both = block
    });
    expect(check.edges.map((e) => e.verdict)).toEqual(['ok', 'block', 'block']);
    expect(check.verdict).toBe('block');
  });

  it('picks the lowest-scoring edge, ties broken by edge order', () => {
    const check = crossCheckInputs({
      datasetColumns: ['a', 'b', 'c'],
      schemaColumns: required('a', 'b', 'c', 'd'), // 3/4
      ruleTargets: ['a', 'x'], // 1/2 against the dataset, 1/2 against the schema
    });
    expect(check.weakest?.id).toBe('data-rules');
    expect(check.weakest?.score).toBe(0.5);
  });

  it('is `ok` with no edges rather than undefined', () => {
    expect(crossCheckInputs({}).verdict).toBe('ok');
  });
});

describe('crossCheckInputs triangulation', () => {
  // Three inputs that agree, one at a time swapped for a stranger's.
  const MINE = { columns: ['a', 'b', 'c'], targets: ['a', 'b'] };
  const THEIRS = { columns: ['x', 'y', 'z'], targets: ['x', 'y'] };

  it('names the dataset when it fits neither of the other two', () => {
    const check = crossCheckInputs({
      datasetColumns: THEIRS.columns,
      schemaColumns: required(...MINE.columns),
      ruleTargets: MINE.targets,
    });
    expect(check.edges.filter((e) => e.verdict === 'block').map((e) => e.id)).toEqual([
      'data-schema',
      'data-rules',
    ]);
    expect(check.suspect).toBe('dataset');
  });

  it('names the schema when it fits neither of the other two', () => {
    const check = crossCheckInputs({
      datasetColumns: MINE.columns,
      schemaColumns: required(...THEIRS.columns),
      ruleTargets: MINE.targets,
    });
    expect(check.edges.filter((e) => e.verdict === 'block').map((e) => e.id)).toEqual([
      'data-schema',
      'schema-rules',
    ]);
    expect(check.suspect).toBe('schema');
  });

  it('names the rules when they fit neither of the other two', () => {
    const check = crossCheckInputs({
      datasetColumns: MINE.columns,
      schemaColumns: required(...MINE.columns),
      ruleTargets: THEIRS.targets,
    });
    expect(check.edges.filter((e) => e.verdict === 'block').map((e) => e.id)).toEqual([
      'data-rules',
      'schema-rules',
    ]);
    expect(check.suspect).toBe('rules');
  });

  it('names nobody when every edge holds', () => {
    const check = crossCheckInputs({
      datasetColumns: MINE.columns,
      schemaColumns: required(...MINE.columns),
      ruleTargets: MINE.targets,
    });
    expect(check.verdict).toBe('ok');
    expect(check.suspect).toBeNull();
  });

  it('names nobody on ONE bad edge — a disagreeing pair with no tiebreaker', () => {
    const check = crossCheckInputs({
      datasetColumns: ['a', 'b'],
      schemaColumns: required('a', 'b', 'c', 'd', 'e'), // 2/5 → block
      ruleTargets: ['a'], // fits the dataset AND the schema
    });
    expect(check.edges.filter((e) => e.verdict === 'block')).toHaveLength(1);
    expect(check.suspect).toBeNull();
  });

  it('names nobody on THREE bad edges — all three are mutually foreign', () => {
    const check = crossCheckInputs({
      datasetColumns: ['a', 'b'],
      schemaColumns: required('m', 'n'),
      ruleTargets: ['x', 'y'],
    });
    expect(check.edges.every((e) => e.verdict === 'block')).toBe(true);
    expect(check.suspect).toBeNull();
  });

  it('does not triangulate on warnings — 50% coverage is partial data, not a stranger', () => {
    const check = crossCheckInputs({
      datasetColumns: ['a', 'b'],
      schemaColumns: required('a', 'b', 'c', 'd'), // 2/4 → warn
      ruleTargets: ['a', 'b', 'c', 'd'], // 2/4 against the dataset → warn, 4/4 against the schema
    });
    expect(check.edges.map((e) => e.verdict)).toEqual(['warn', 'warn', 'ok']);
    expect(check.verdict).toBe('warn');
    // The pattern points at the dataset, but a half-loaded column list is an
    // ordinary partial file — only `block` edges accuse anyone.
    expect(check.suspect).toBeNull();
  });

  it('cannot triangulate with fewer than three edges', () => {
    const check = crossCheckInputs({
      datasetColumns: ['a', 'b', 'c'],
      schemaColumns: required(...THEIRS.columns),
    });
    expect(check.verdict).toBe('block');
    expect(check.suspect).toBeNull();
  });
});
