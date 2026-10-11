/**
 * One row's Ajv errors as a tree — which errors belong to which applicator —
 * for the translator (translator.ts) to render.
 *
 * Ajv (`allErrors`, `verbose`) reports flat. A failing `anyOf`, `oneOf`,
 * `if`, `contains` or `propertyNames` pushes its sub-errors first, as ONE
 * contiguous block, then its own error (verified against ajv 8.20):
 *
 *   minimum   /v  #/properties/v/anyOf/0/minimum      ┐ branch 0
 *   const     /v  #/$defs/code/const                  ┘ branch 1, via $ref
 *   anyOf     /v  #/properties/v/anyOf                ← the wrapper
 *
 * The block's errors cannot be told by schemaPath — one inside a `$ref`'d
 * subschema carries the TARGET's path — so its size comes from asking Ajv
 * again (`SchemaProbe.errorsAt`): the errors one branch produces on the same
 * value are exactly that branch's share of the block. Sizes are checked
 * against the block (same keywords at the same paths) before they are
 * trusted; a row whose blocks do not check out falls back to the
 * schemaPath reading below, which is what a caller without a probe gets too.
 *
 * Fallback reading (no probe — recorded fixtures, a mismatch): an error
 * belongs to the innermost wrapper whose schemaPath it extends, or — for a
 * union — to one at the same value whose schemaPath is foreign to the
 * union's own schema object (a `$ref`'d branch: HESP's missing-value codes).
 * Order-independent, so it is deterministic for shuffled input.
 *
 * Pure; node-testable.
 */
import type { SchemaProbe } from './schema-probe';
import type { AjvErrorLike } from './translator';

export interface LeafNode {
  kind: 'leaf';
  error: AjvErrorLike;
}

/** A failed `anyOf` / `oneOf`. */
export interface UnionNode {
  kind: 'union';
  error: AjvErrorLike;
  children: ErrorNode[];
  /** Each branch's own nodes (`[]` for a branch that passed or never ran); null when unknown. */
  branches: ErrorNode[][] | null;
}

/** A failed `then` or `else`: its children are that clause's errors. */
export interface IfNode {
  kind: 'if';
  error: AjvErrorLike;
  clause: 'then' | 'else';
  children: ErrorNode[];
}

export interface ContainsNode {
  kind: 'contains';
  error: AjvErrorLike;
  children: ErrorNode[];
  /** How many items matched, when the probe counted them. */
  matches: number | null;
}

/** One bad property NAME: its children say why. */
export interface NamesNode {
  kind: 'propertyNames';
  error: AjvErrorLike;
  children: ErrorNode[];
}

export type ErrorNode = LeafNode | UnionNode | IfNode | ContainsNode | NamesNode;

const WRAPPERS = new Set(['anyOf', 'oneOf', 'if', 'contains', 'propertyNames']);

export const isWrapper = (error: AjvErrorLike): boolean => WRAPPERS.has(error.keyword);

export const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** `#/properties/v/anyOf` → `#/properties/v`. */
export const parentPath = (schemaPath: string): string => {
  const slash = schemaPath.lastIndexOf('/');
  return slash === -1 ? schemaPath : schemaPath.slice(0, slash);
};

export function stableErrorOrder(a: AjvErrorLike, b: AjvErrorLike): number {
  if (a.instancePath !== b.instancePath) return a.instancePath < b.instancePath ? -1 : 1;
  if (a.schemaPath !== b.schemaPath) return a.schemaPath < b.schemaPath ? -1 : 1;
  if (a.keyword !== b.keyword) return a.keyword < b.keyword ? -1 : 1;
  const pa = JSON.stringify(a.params);
  const pb = JSON.stringify(b.params);
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * Build the tree. With a probe, from Ajv's own order and exact block sizes;
 * without one (or when a block does not check out), from schemaPaths.
 */
export function buildErrorTree(errors: readonly AjvErrorLike[], probe?: SchemaProbe): ErrorNode[] {
  if (probe !== undefined && errors.some(isWrapper)) {
    const ordered = parseOrdered(errors, probe);
    if (ordered !== null) return ordered;
  }
  return parseBySchemaPath(errors);
}

// ---------------------------------------------------------------------------
// With a probe: Ajv's order, exact sizes
// ---------------------------------------------------------------------------

interface Expected {
  keyword: string;
  instancePath: string;
}

interface BlockPlan {
  /** Per segment: a union's branches, or a single segment for the others. */
  sizes: number[];
  expected: Expected[];
  matches?: number;
}

const expect = (errors: readonly AjvErrorLike[], prefix: string): Expected[] =>
  errors.map((e) => ({ keyword: e.keyword, instancePath: `${prefix}${e.instancePath}` }));

/** Where a keyword's subschema sits: the value's own location, or its parent's plus the keyword. */
function keywordLocation(error: AjvErrorLike, probe: SchemaProbe): { uri: string; pointer: string } | null {
  const own = probe.locate(error.schema);
  if (own !== null) return own;
  const parent = probe.locate(error.parentSchema);
  return parent === null ? null : { uri: parent.uri, pointer: `${parent.pointer}/${error.keyword}` };
}

function planBlock(error: AjvErrorLike, probe: SchemaProbe): BlockPlan | null {
  switch (error.keyword) {
    case 'anyOf':
    case 'oneOf': {
      const at = keywordLocation(error, probe);
      const branches = Array.isArray(error.schema)
        ? error.schema
        : (error.parentSchema as Record<string, unknown> | undefined)?.[error.keyword];
      if (at === null || !Array.isArray(branches)) return null;
      const passing = error.params.passingSchemas;
      // oneOf stops at the second passing branch: those after it never ran.
      const passed = Array.isArray(passing) ? passing.filter((p): p is number => typeof p === 'number') : [];
      const last = passed.length > 0 ? Math.max(...passed) : Infinity;
      const sizes: number[] = [];
      const expected: Expected[] = [];
      for (let j = 0; j < branches.length; j += 1) {
        if (error.keyword === 'oneOf' && passed.length > 0 && (j >= last || passed.includes(j))) {
          sizes.push(0);
          continue;
        }
        const errs = probe.errorsAt(at.uri, `${at.pointer}/${String(j)}`, error.data);
        if (errs === null) return null;
        sizes.push(errs.length);
        expected.push(...expect(errs, error.instancePath));
      }
      return { sizes, expected };
    }
    case 'if': {
      const clause = error.params.failingKeyword;
      if (clause !== 'then' && clause !== 'else') return null;
      const parent = probe.locate(error.parentSchema);
      if (parent === null) return null;
      const errs = probe.errorsAt(parent.uri, `${parent.pointer}/${clause}`, error.data);
      if (errs === null) return null;
      return { sizes: [errs.length], expected: expect(errs, error.instancePath) };
    }
    case 'contains': {
      const at = keywordLocation(error, probe);
      if (at === null || !Array.isArray(error.data)) return null;
      const min = typeof error.params.minContains === 'number' ? error.params.minContains : 1;
      const max = typeof error.params.maxContains === 'number' ? error.params.maxContains : undefined;
      let matches = 0;
      let total = 0;
      const expected: Expected[] = [];
      // Ajv's own walk: stop at the first match (min 1, no max), at `min`
      // matches, or once matches pass `max`.
      for (let i = 0; i < error.data.length; i += 1) {
        const errs = probe.errorsAt(at.uri, at.pointer, error.data[i]);
        if (errs === null) return null;
        if (errs.length === 0) {
          matches += 1;
          if (max === undefined ? matches >= min : matches > max) break;
          continue;
        }
        total += errs.length;
        expected.push(...expect(errs, `${error.instancePath}/${String(i)}`));
      }
      return { sizes: [total], expected, matches };
    }
    case 'propertyNames': {
      const at = keywordLocation(error, probe);
      const name = error.params.propertyName;
      if (at === null || typeof name !== 'string') return null;
      const errs = probe.errorsAt(at.uri, at.pointer, name);
      if (errs === null) return null;
      return { sizes: [errs.length], expected: expect(errs, error.instancePath) };
    }
    default:
      return null;
  }
}

function makeNode(error: AjvErrorLike, segments: ErrorNode[][], plan: BlockPlan | null): ErrorNode {
  const children = segments.flat();
  switch (error.keyword) {
    case 'anyOf':
    case 'oneOf':
      return { kind: 'union', error, children, branches: plan === null ? null : segments };
    case 'if':
      return { kind: 'if', error, clause: error.params.failingKeyword === 'else' ? 'else' : 'then', children };
    case 'contains':
      return { kind: 'contains', error, children, matches: plan?.matches ?? null };
    default:
      return { kind: 'propertyNames', error, children };
  }
}

function parseOrdered(errors: readonly AjvErrorLike[], probe: SchemaProbe): ErrorNode[] | null {
  const parseRange = (start: number, end: number): ErrorNode[] | null => {
    const out: ErrorNode[] = [];
    let i = end - 1;
    while (i >= start) {
      const error = errors[i];
      if (error === undefined) return null;
      if (!isWrapper(error)) {
        out.push({ kind: 'leaf', error });
        i -= 1;
        continue;
      }
      const plan = planBlock(error, probe);
      if (plan === null) return null;
      const size = plan.sizes.reduce((a, b) => a + b, 0);
      const from = i - size;
      if (from < start) return null;
      for (let k = 0; k < size; k += 1) {
        const got = errors[from + k];
        const want = plan.expected[k];
        if (got === undefined || want === undefined) return null;
        if (got.keyword !== want.keyword || got.instancePath !== want.instancePath) return null;
      }
      const segments: ErrorNode[][] = [];
      let offset = from;
      for (const segmentSize of plan.sizes) {
        const segment = parseRange(offset, offset + segmentSize);
        if (segment === null) return null;
        segments.push(segment);
        offset += segmentSize;
      }
      out.push(makeNode(error, segments, plan));
      i = from - 1;
    }
    return out.reverse();
  };
  return parseRange(0, errors.length);
}

// ---------------------------------------------------------------------------
// Without one: schemaPaths
// ---------------------------------------------------------------------------

const startsWithSeg = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** True when `path` lies strictly inside `prefix`. */
const strictlyInside = (path: string, prefix: string): boolean => path.startsWith(`${prefix}/`);

const CONDITIONAL_SEGMENT = /\/(?:if|then|else)(?:\/|$)/;

/** `…#/$defs/refused` for `…#/$defs/refused/const`: the definition an error sits in, if any. */
function definitionOf(path: string): string | null {
  const match = /^(.*\/(?:\$defs|definitions)\/[^/]+)(?:\/|$)/.exec(path);
  return match?.[1] ?? null;
}

/** The document part of a schemaPath: `../../common/defs.json` of `../../common/defs.json#/$defs/x`, '' of `#/x`. */
const documentOf = (path: string): string => {
  const hash = path.indexOf('#');
  return hash === -1 ? path.slice(0, Math.max(0, path.indexOf('/'))) : path.slice(0, hash);
};

/**
 * An error from a `$ref`'d subschema, whose errors carry the target's path:
 * another document, or a definition that does not hold the wrapper (a code
 * list's `oneOf` sits at `#/oneOf` when its def is the `$ref` target, its
 * branches' refs at `#/$defs/refused/const`) — and from no conditional
 * clause (a root `then` is its `if`'s, never a union's). Another path in the
 * same document is a sibling, not a branch: a second union on the same value
 * is never the first one's member.
 */
function foreignTo(path: string, wrapperPath: string): boolean {
  if (CONDITIONAL_SEGMENT.test(path)) return false;
  if (documentOf(path) !== documentOf(wrapperPath)) return true;
  const definition = definitionOf(path);
  return definition !== null && !startsWithSeg(wrapperPath, definition);
}

/** 0 = not a member; 1 = a foreign member; 2 = a member by schemaPath prefix. */
function membership(e: AjvErrorLike, w: AjvErrorLike): 0 | 1 | 2 {
  const S = w.schemaPath;
  const P = w.instancePath;
  switch (w.keyword) {
    case 'anyOf':
    case 'oneOf':
      if (!isUnder(e.instancePath, P)) return 0;
      if (strictlyInside(e.schemaPath, S)) return 2;
      return e.instancePath === P && foreignTo(e.schemaPath, S) ? 1 : 0;
    case 'if': {
      const clause = w.params.failingKeyword;
      if (clause !== 'then' && clause !== 'else') return 0;
      if (!isUnder(e.instancePath, P)) return 0;
      return startsWithSeg(e.schemaPath, `${parentPath(S)}/${clause}`) ? 2 : 0;
    }
    case 'contains':
      if (e.instancePath === P || !isUnder(e.instancePath, P)) return 0;
      return strictlyInside(e.schemaPath, S) ? 2 : 0;
    case 'propertyNames': {
      if (e.instancePath !== P) return 0;
      const name = w.params.propertyName;
      const mine = e.propertyName !== undefined ? e.propertyName === name : e.data === name;
      if (!mine) return 0;
      if (strictlyInside(e.schemaPath, S)) return 2;
      return foreignTo(e.schemaPath, S) ? 1 : 0;
    }
    default:
      return 0;
  }
}

function compareScore(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The branch index a union child's schemaPath names, or null (a foreign member). */
function branchIndex(child: AjvErrorLike, union: AjvErrorLike): number | null {
  if (!strictlyInside(child.schemaPath, union.schemaPath)) return null;
  const segment = child.schemaPath.slice(union.schemaPath.length + 1).split('/')[0];
  return segment !== undefined && /^\d+$/.test(segment) ? Number(segment) : null;
}

/** `/a/b/c` → `''`, `/a`, `/a/b`, `/a/b/c`: every value an error at the path is inside. */
function enclosingPaths(instancePath: string): string[] {
  const paths = [''];
  let at = 0;
  while (at < instancePath.length) {
    const next = instancePath.indexOf('/', at + 1);
    const end = next === -1 ? instancePath.length : next;
    paths.push(instancePath.slice(0, end));
    at = end;
  }
  return paths;
}

function parseBySchemaPath(errors: readonly AjvErrorLike[]): ErrorNode[] {
  const sorted = [...errors].sort(stableErrorOrder);
  // A wrapper only owns errors at or below its own value: index by that.
  const wrappersAt = new Map<string, AjvErrorLike[]>();
  for (const w of sorted) {
    if (!isWrapper(w)) continue;
    const list = wrappersAt.get(w.instancePath);
    if (list === undefined) wrappersAt.set(w.instancePath, [w]);
    else list.push(w);
  }
  const owner = new Map<AjvErrorLike, AjvErrorLike>();
  const createsCycle = (child: AjvErrorLike, candidate: AjvErrorLike): boolean => {
    for (let at: AjvErrorLike | undefined = candidate; at !== undefined; at = owner.get(at)) {
      if (at === child) return true;
    }
    return false;
  };
  for (const e of sorted) {
    const candidates: { w: AjvErrorLike; score: number[] }[] = [];
    for (const path of enclosingPaths(e.instancePath)) {
      for (const w of wrappersAt.get(path) ?? []) {
        if (w === e) continue;
        const how = membership(e, w);
        if (how === 0) continue;
        candidates.push({ w, score: [how, w.instancePath.length, w.schemaPath.length] });
      }
    }
    candidates.sort((a, b) => compareScore(b.score, a.score) || stableErrorOrder(a.w, b.w));
    const chosen = candidates.find((c) => !createsCycle(e, c.w));
    if (chosen !== undefined) owner.set(e, chosen.w);
  }

  const childrenOf = new Map<AjvErrorLike, AjvErrorLike[]>();
  for (const e of sorted) {
    const w = owner.get(e);
    if (w === undefined) continue;
    const list = childrenOf.get(w);
    if (list === undefined) childrenOf.set(w, [e]);
    else list.push(e);
  }

  const build = (error: AjvErrorLike): ErrorNode => {
    if (!isWrapper(error)) return { kind: 'leaf', error };
    const kids = childrenOf.get(error) ?? [];
    const children = kids.map(build);
    if (error.keyword === 'anyOf' || error.keyword === 'oneOf') {
      const count = Array.isArray(error.schema)
        ? error.schema.length
        : Math.max(0, ...kids.map((k) => (branchIndex(k, error) ?? -1) + 1));
      const branches: ErrorNode[][] = Array.from({ length: count }, () => []);
      let complete = true;
      for (let i = 0; i < kids.length; i += 1) {
        const kid = kids[i];
        const node = children[i];
        const j = kid === undefined ? null : branchIndex(kid, error);
        if (j === null || j >= count || node === undefined) complete = false;
        else branches[j]?.push(node);
      }
      return { kind: 'union', error, children, branches: complete ? branches : null };
    }
    return makeNode(error, [children], null);
  };

  return sorted.filter((e) => !owner.has(e)).map(build);
}
