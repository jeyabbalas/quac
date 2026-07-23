// Deterministic HESP mock-data fixture generator (P02).
//
// Parses tests/fixtures/hesp/json_schema/ (the single source of truth for the
// 265-column layout), generates 100 schema-clean household-wave rows, injects
// the seeded violations mandated by testing-strategy.md §3.1 into a dirty
// copy, and emits tests/fixtures/hesp/data/ in five formats plus the
// ground-truth violation log. Byte-determinism contract: two runs produce
// identical bytes (CI gate `fixtures:check`), so the only randomness is
// mulberry32 seeded 20260723 and no timestamps are embedded anywhere.
// One scoping (Verified fact V16): DuckDB's native parquet writer emits
// platform-dependent bytes (macOS arm64 vs Linux x64 differ for identical
// data), so the parquet is byte-stable per platform and content-stable across
// platforms — regeneration keeps the committed file untouched when a DuckDB
// read-back comparison (schema + ordered rows) finds no difference.
//
// Valid-file invariant: zero findings under BOTH the JSON Schema and every
// enabled rule in tests/fixtures/hesp/rules/*.quac.csv (golden journey 7).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** @type {typeof import('exceljs')} */
const ExcelJS = require('exceljs');
/** @type {typeof import('@duckdb/node-api')} */
const duckdb = require('@duckdb/node-api');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SCHEMA_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'hesp', 'json_schema');
const DEFAULT_OUT = join(REPO_ROOT, 'tests', 'fixtures', 'hesp', 'data');

export const SEED = 20260723;
export const BASE_ROWS = 100;

/** Numeric missing-value sentinels reserved by the HESP conventions. */
const SENTINEL_VALUES = new Set([-666, -777, -888, -999, -6666, -7777, -8888, -9999]);
/** Q047 recodes these legacy positive codes; valid data must never contain them. */
const LEGACY_SENTINELS = new Set([777, 888, 999, 999999999]);
/** Q047's target columns (kept free of legacy sentinel values in valid data). */
const Q047_TARGETS = ['wage_income_annual', 'selfemp_income_annual', 'monthly_rent', 'credit_card_balance'];
/** Q021's nine income components plus total. */
const INCOME_COMPONENTS = [
  'wage_income_annual',
  'selfemp_income_annual',
  'interest_dividend_annual',
  'retirement_income_annual',
  'rental_income_annual',
  'child_support_annual',
  'alimony_annual',
  'private_transfer_annual',
  'other_income_annual',
];
const INCOME_TOTAL = 'total_household_income_annual';
/** Q052's debt-balance columns (generated nonnegative-or-sentinel). */
const DEBT_COLUMNS = ['credit_card_balance', 'student_loan_balance', 'auto_loan_balance', 'payday_loan_balance'];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * @template T
 * @param {T | undefined} v
 * @param {string} [msg]
 * @returns {T}
 */
function req(v, msg) {
  if (v === undefined) throw new Error(msg ?? 'unexpected undefined');
  return v;
}

/**
 * @param {boolean} cond
 * @param {string} msg
 * @returns {asserts cond}
 */
function assert(cond, msg) {
  if (!cond) throw new Error(`generator invariant violated: ${msg}`);
}

/**
 * mulberry32 — deterministic across platforms (integer ops + exact dyadic division).
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {() => number} rng
 * @param {number} lo inclusive
 * @param {number} hi inclusive
 */
function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * randInt that never lands on a legacy positive sentinel (777/888/999/…) —
 * Q047 recodes those, and valid data must not trip corrections.
 * @param {() => number} rng
 * @param {number} lo inclusive
 * @param {number} hi inclusive
 */
function amount(rng, lo, hi) {
  for (;;) {
    const v = randInt(rng, lo, hi);
    if (!LEGACY_SENTINELS.has(v)) return v;
  }
}

/**
 * @template T
 * @param {() => number} rng
 * @param {readonly T[]} arr
 * @returns {T}
 */
function pick(rng, arr) {
  assert(arr.length > 0, 'pick from empty array');
  return req(arr[Math.floor(rng() * arr.length)]);
}

// ---------------------------------------------------------------------------
// Schema loading (manual $ref resolution — only the forms present in HESP)
// ---------------------------------------------------------------------------

/**
 * @typedef {{files: Map<string, any>, root: any, rootPath: string}} SchemaSet
 */

/**
 * Loads core.schema.json and every file it (transitively) references.
 * Never globs the directory — README.md and manifest.json must not be parsed.
 * @param {string} schemaDir
 * @returns {SchemaSet}
 */
export function loadSchemaSet(schemaDir) {
  /** @type {Map<string, any>} */
  const files = new Map();
  const rootPath = 'core/core.schema.json';
  /** @type {string[]} */
  const queue = [rootPath];
  while (queue.length > 0) {
    const rel = req(queue.shift());
    if (files.has(rel)) continue;
    const raw = readFileSync(join(schemaDir, rel), 'utf8');
    const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
    files.set(rel, json);
    for (const refTarget of collectFileRefs(json, rel)) {
      if (!files.has(refTarget)) queue.push(refTarget);
    }
  }
  return { files, root: req(files.get(rootPath)), rootPath };
}

/**
 * Collects the file part of every $ref in a document, resolved to a
 * schema-dir-relative POSIX path. Hard-errors on unsupported ref forms.
 * @param {any} node
 * @param {string} fromRel
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function collectFileRefs(node, fromRel, acc = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectFileRefs(item, fromRel, acc);
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        const file = refFilePart(v, fromRel);
        if (file !== null) acc.push(file);
      } else {
        collectFileRefs(v, fromRel, acc);
      }
    }
  }
  return acc;
}

/**
 * @param {string} ref
 * @param {string} fromRel
 * @returns {string | null} schema-dir-relative file path, or null for fragment-only refs
 */
function refFilePart(ref, fromRel) {
  if (ref.startsWith('#')) return null;
  assert(!/^[a-z][a-z0-9+.-]*:/i.test(ref), `absolute/URI $ref not supported: ${ref}`);
  const hashAt = ref.indexOf('#');
  const filePart = hashAt === -1 ? ref : ref.slice(0, hashAt);
  // POSIX-normalize relative to the referencing file's directory.
  const baseSegs = fromRel.split('/').slice(0, -1);
  for (const seg of filePart.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      assert(baseSegs.length > 0, `$ref escapes schema dir: ${ref} from ${fromRel}`);
      baseSegs.pop();
    } else {
      baseSegs.push(seg);
    }
  }
  return baseSegs.join('/');
}

/**
 * Resolves one $ref (file part + optional #/pointer fragment) to its target node.
 * @param {SchemaSet} set
 * @param {string} ref
 * @param {string} fromRel
 * @returns {{node: any, fileRel: string}}
 */
function resolveRef(set, ref, fromRel) {
  const filePart = refFilePart(ref, fromRel);
  const fileRel = filePart ?? fromRel;
  let node = set.files.get(fileRel);
  assert(node !== undefined, `$ref to unloaded file: ${ref} from ${fromRel}`);
  const hashAt = ref.indexOf('#');
  if (hashAt !== -1) {
    const fragment = ref.slice(hashAt + 1);
    assert(fragment.startsWith('/'), `non-pointer fragment not supported: ${ref}`);
    for (const segEnc of fragment.split('/').slice(1)) {
      const seg = segEnc.replace(/~1/g, '/').replace(/~0/g, '~');
      node = node?.[seg];
      assert(node !== undefined, `$ref fragment does not dereference: ${ref} (at ${seg})`);
    }
  }
  return { node, fileRel };
}

/**
 * Resolves a node that may be a bare {$ref} (one hop; HESP never chains refs
 * beyond property → def, and defs are self-contained).
 * @param {SchemaSet} set
 * @param {any} node
 * @param {string} fromRel
 * @returns {{node: any, fileRel: string}}
 */
function deref(set, node, fromRel) {
  if (node !== null && typeof node === 'object' && typeof node.$ref === 'string') {
    const r = resolveRef(set, node.$ref, fromRel);
    // $ref siblings (title, x-*) overlay the target for our purposes.
    return { node: { ...r.node, ...stripRef(node) }, fileRel: r.fileRel };
  }
  return { node, fileRel: fromRel };
}

/** @param {any} node */
function stripRef(node) {
  /** @type {Record<string, any>} */
  const rest = { ...node };
  delete rest.$ref;
  return rest;
}

// ---------------------------------------------------------------------------
// Column derivation (265 columns, classified into generation domains)
// ---------------------------------------------------------------------------

/**
 * @typedef {{value: number | string, title: string}} Code
 * @typedef {{kind: 'codes', codes: Code[], sentinels: Code[]}} CodesDomain
 * @typedef {{kind: 'numeric', numType: 'integer' | 'number', min: number, max: number, notEnum: number[], sentinels: Code[]}} NumericDomain
 * @typedef {{kind: 'pattern', tag: 'household_id' | 'record_id' | 'person_id' | 'sample_id' | 'date'}} PatternDomain
 * @typedef {{kind: 'string-codes', tag: 'household_id', sentinels: Code[]}} StringCodesDomain
 * @typedef {CodesDomain | NumericDomain | PatternDomain | StringCodesDomain} Domain
 * @typedef {{name: string, category: string, domain: Domain}} Column
 */

const PATTERN_TAGS = new Map([
  ['^HH[0-9]{8}$', 'household_id'],
  ['^HH[0-9]{8}_W(0[1-9]|1[0-9]|20)$', 'record_id'],
  ['^HH[0-9]{8}_P[0-9]{2}$', 'person_id'],
  ['^S[0-9]{10}$', 'sample_id'],
  ['^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$', 'date'],
]);

/**
 * Walks items.allOf category refs in order and classifies all 265 properties.
 * @param {SchemaSet} set
 * @returns {Column[]}
 */
export function deriveColumns(set) {
  /** @type {Column[]} */
  const columns = [];
  const allOf = set.root?.items?.allOf;
  assert(Array.isArray(allOf), 'root items.allOf missing');
  for (const entry of allOf) {
    if (typeof entry?.$ref !== 'string') continue; // conditionals handled separately
    const { node: category, fileRel } = resolveRef(set, entry.$ref, set.rootPath);
    const categoryName = req(fileRel.split('/').pop()).replace(/\.json$/, '');
    const props = category?.properties;
    assert(props !== null && typeof props === 'object', `category ${fileRel} has no properties`);
    for (const [name, propSchema] of Object.entries(props)) {
      columns.push({ name, category: categoryName, domain: classifyDomain(set, propSchema, fileRel, name) });
    }
  }
  return columns;
}

/**
 * @param {SchemaSet} set
 * @param {any} propSchema
 * @param {string} fileRel
 * @param {string} name
 * @returns {Domain}
 */
function classifyDomain(set, propSchema, fileRel, name) {
  const { node: prop, fileRel: propRel } = deref(set, propSchema, fileRel);
  const branchList = prop.anyOf ?? prop.oneOf ?? [prop];
  /** @type {Code[]} */
  const consts = [];
  /** @type {any[]} */
  const numeric = [];
  /** @type {string[]} */
  const patterns = [];
  for (const rawBranch of branchList) {
    const { node: branch } = deref(set, rawBranch, propRel);
    if (branch.const !== undefined) {
      consts.push({ value: branch.const, title: String(branch.title ?? '') });
    } else if (branch.type === 'integer' || branch.type === 'number') {
      numeric.push(branch);
    } else if (typeof branch.pattern === 'string') {
      patterns.push(branch.pattern);
    } else {
      throw new Error(`unclassifiable branch for ${name} in ${fileRel}: ${JSON.stringify(branch).slice(0, 120)}`);
    }
  }
  const sentinels = consts.filter((c) => typeof c.value === 'number' && SENTINEL_VALUES.has(c.value));
  const stringConsts = consts.filter((c) => typeof c.value === 'string');
  const substantive = consts.filter((c) => !sentinels.includes(c) && !stringConsts.includes(c));

  if (numeric.length > 0) {
    assert(numeric.length === 1, `multiple numeric branches for ${name}`);
    assert(substantive.length === 0 && stringConsts.length === 0, `hybrid numeric+codes domain for ${name}`);
    const b = req(numeric[0]);
    assert(typeof b.minimum === 'number' && typeof b.maximum === 'number', `numeric branch without bounds for ${name}`);
    const notEnum = Array.isArray(b.not?.enum) ? b.not.enum.map((/** @type {any} */ v) => Number(v)) : [];
    return { kind: 'numeric', numType: b.type === 'number' ? 'number' : 'integer', min: b.minimum, max: b.maximum, notEnum, sentinels };
  }
  if (patterns.length > 0) {
    assert(patterns.length === 1, `multiple pattern branches for ${name}`);
    const tag = PATTERN_TAGS.get(req(patterns[0]));
    assert(tag !== undefined, `unknown pattern for ${name}: ${patterns[0]}`);
    if (stringConsts.length > 0) {
      assert(tag === 'household_id', `string-codes domain with unexpected pattern tag for ${name}`);
      return { kind: 'string-codes', tag: 'household_id', sentinels: stringConsts };
    }
    return { kind: 'pattern', tag: /** @type {PatternDomain['tag']} */ (tag) };
  }
  assert(consts.length > 0, `empty domain for ${name}`);
  assert(stringConsts.length === 0, `string consts outside string-codes domain for ${name}`);
  return { kind: 'codes', codes: substantive, sentinels };
}

// ---------------------------------------------------------------------------
// Conditional derivation (the 171 if/then blocks, exact observed shapes only)
// ---------------------------------------------------------------------------

/**
 * @typedef {{t: 'const', v: number | string} | {t: 'enum', vs: (number | string)[]} | {t: 'range', min: number, max: number} | {t: 'nonpos', max: number, notEnum: number[]}} IfTest
 * @typedef {{col: string, test: IfTest}} IfClause
 * @typedef {{t: 'const', v: number | string} | {t: 'not-const', v: number | string} | {t: 'not-enum', vs: (number | string)[]} | {t: 'enum', vs: (number | string)[]} | {t: 'any-of', min: number, max: number, vs: (number | string)[]}} TargetConstraint
 * @typedef {{col: string, c: TargetConstraint}} ThenTarget
 * @typedef {{options: {col: string, v: number | string}[]}} ThenAnyOfGroup
 * @typedef {{allOfIndex: number, comment: string, mode: 'all' | 'any', clauses: IfClause[], targets: ThenTarget[], anyOfGroups: ThenAnyOfGroup[]}} Conditional
 */

/**
 * @param {SchemaSet} set
 * @returns {Conditional[]}
 */
export function deriveConditionals(set) {
  /** @type {Conditional[]} */
  const out = [];
  const allOf = set.root?.items?.allOf;
  assert(Array.isArray(allOf), 'root items.allOf missing');
  allOf.forEach((/** @type {any} */ entry, /** @type {number} */ index) => {
    if (entry === null || typeof entry !== 'object' || !('if' in entry)) return;
    const iff = entry.if;
    const then = entry.then;
    assert(then !== null && typeof then === 'object', `allOf[${index}] if without then`);
    assert(!('else' in entry), `allOf[${index}] has else (unsupported)`);
    /** @type {'all' | 'any'} */
    let mode = 'all';
    /** @type {IfClause[]} */
    const clauses = [];
    if (Array.isArray(iff.anyOf)) {
      mode = 'any';
      for (const d of iff.anyOf) {
        const props = Object.entries(d.properties ?? {});
        assert(props.length === 1, `allOf[${index}] if.anyOf disjunct not single-property`);
        const [col, test] = req(props[0]);
        clauses.push({ col, test: parseIfTest(test, index) });
      }
    } else {
      for (const [col, test] of Object.entries(iff.properties ?? {})) {
        clauses.push({ col, test: parseIfTest(test, index) });
      }
      assert(clauses.length > 0, `allOf[${index}] if has no property tests`);
    }
    /** @type {ThenTarget[]} */
    const targets = [];
    /** @type {ThenAnyOfGroup[]} */
    const anyOfGroups = [];
    collectThen(then, index, targets, anyOfGroups);
    out.push({ allOfIndex: index, comment: String(entry.$comment ?? ''), mode, clauses, targets, anyOfGroups });
  });
  return out;
}

/**
 * @param {any} test
 * @param {number} index
 * @returns {IfTest}
 */
function parseIfTest(test, index) {
  if (test.const !== undefined) return { t: 'const', v: test.const };
  if (Array.isArray(test.enum)) return { t: 'enum', vs: test.enum };
  if (typeof test.minimum === 'number' && typeof test.maximum === 'number') {
    return { t: 'range', min: test.minimum, max: test.maximum };
  }
  if (typeof test.maximum === 'number' && test.not !== undefined) {
    assert(Array.isArray(test.not.enum), `allOf[${index}] if not-test without enum`);
    return { t: 'nonpos', max: test.maximum, notEnum: test.not.enum.map((/** @type {any} */ v) => Number(v)) };
  }
  throw new Error(`allOf[${index}] unrecognized if-test: ${JSON.stringify(test)}`);
}

/**
 * @param {any} then
 * @param {number} index
 * @param {ThenTarget[]} targets
 * @param {ThenAnyOfGroup[]} anyOfGroups
 */
function collectThen(then, index, targets, anyOfGroups) {
  for (const [col, c] of Object.entries(then.properties ?? {})) {
    targets.push({ col, c: parseTargetConstraint(c, index) });
  }
  for (const sub of then.allOf ?? []) {
    if (Array.isArray(sub.anyOf)) {
      /** @type {{col: string, v: number | string}[]} */
      const options = [];
      for (const opt of sub.anyOf) {
        const props = Object.entries(opt.properties ?? {});
        assert(props.length === 1, `allOf[${index}] then.allOf anyOf option not single-property`);
        const [col, t] = req(props[0]);
        assert(/** @type {any} */ (t).const !== undefined, `allOf[${index}] then.allOf anyOf option not const`);
        options.push({ col, v: /** @type {any} */ (t).const });
      }
      anyOfGroups.push({ options });
    } else if (sub.properties !== undefined) {
      for (const [col, c] of Object.entries(sub.properties)) {
        targets.push({ col, c: parseTargetConstraint(c, index) });
      }
    } else {
      throw new Error(`allOf[${index}] unrecognized then.allOf element: ${JSON.stringify(sub).slice(0, 120)}`);
    }
  }
  const known = new Set(['properties', 'allOf']);
  for (const k of Object.keys(then)) {
    assert(known.has(k), `allOf[${index}] unrecognized then keyword: ${k}`);
  }
}

/**
 * @param {any} c
 * @param {number} index
 * @returns {TargetConstraint}
 */
function parseTargetConstraint(c, index) {
  if (c.const !== undefined) return { t: 'const', v: c.const };
  if (c.not !== undefined) {
    if (c.not.const !== undefined) return { t: 'not-const', v: c.not.const };
    if (Array.isArray(c.not.enum)) return { t: 'not-enum', vs: c.not.enum };
  }
  if (Array.isArray(c.enum)) return { t: 'enum', vs: c.enum };
  if (Array.isArray(c.anyOf)) {
    /** @type {(number | string)[]} */
    let vs = [];
    let min = NaN;
    let max = NaN;
    for (const b of c.anyOf) {
      if (typeof b.minimum === 'number' && typeof b.maximum === 'number') {
        min = b.minimum;
        max = b.maximum;
      } else if (Array.isArray(b.enum)) {
        vs = b.enum;
      } else {
        throw new Error(`allOf[${index}] unrecognized target anyOf branch: ${JSON.stringify(b)}`);
      }
    }
    assert(Number.isFinite(min) && Number.isFinite(max), `allOf[${index}] target anyOf without range branch`);
    return { t: 'any-of', min, max, vs };
  }
  throw new Error(`allOf[${index}] unrecognized target constraint: ${JSON.stringify(c)}`);
}

// ---------------------------------------------------------------------------
// Row model + evaluation (checker semantics mirror the future translator:
// cast failure suppresses the cell's other flags; a NULL cell only ever
// yields the `required` flag; value and conditional flags may coexist)
// ---------------------------------------------------------------------------

/**
 * @typedef {number | string | null} Cell
 * @typedef {Map<string, Cell>} Row
 */

/**
 * @param {IfTest} test
 * @param {Cell} v
 */
function ifTestPasses(test, v) {
  if (v === null) return false;
  switch (test.t) {
    case 'const':
      return v === test.v;
    case 'enum':
      return test.vs.includes(v);
    case 'range':
      return typeof v === 'number' && v >= test.min && v <= test.max;
    case 'nonpos':
      return typeof v === 'number' && v <= test.max && !test.notEnum.includes(v);
  }
}

/**
 * @param {Conditional} cond
 * @param {Row} row
 */
function conditionFires(cond, row) {
  if (cond.mode === 'any') {
    return cond.clauses.some((cl) => ifTestPasses(cl.test, req(row.get(cl.col), cl.col)));
  }
  return cond.clauses.every((cl) => ifTestPasses(cl.test, req(row.get(cl.col), cl.col)));
}

/**
 * @param {TargetConstraint} c
 * @param {Cell} v
 * @returns {boolean} true when satisfied (absent/null cells are never constrained)
 */
function targetSatisfied(c, v) {
  if (v === null) return true;
  switch (c.t) {
    case 'const':
      return v === c.v;
    case 'not-const':
      return v !== c.v;
    case 'not-enum':
      return !c.vs.includes(v);
    case 'enum':
      return c.vs.includes(v);
    case 'any-of':
      return (typeof v === 'number' && v >= c.min && v <= c.max) || c.vs.includes(v);
  }
}

/** Numeric-string shape accepted by the DuckDB cast ladder (json-schema-subsystem §C.1). */
const NUMERIC_STRING = /^-?(\d+)(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Checks one cell against its column domain.
 * @param {Domain} domain
 * @param {Cell} v
 * @returns {'ok' | 'required' | 'cast' | 'value'}
 */
function checkCell(domain, v) {
  if (v === null) return 'required';
  switch (domain.kind) {
    case 'numeric': {
      if (typeof v === 'string') {
        const t = v.trim();
        if (t === '') return 'required';
        return NUMERIC_STRING.test(t) && domain.numType === 'number' ? 'value' : 'cast';
      }
      if (domain.sentinels.some((s) => s.value === v)) return 'ok';
      if (domain.numType === 'integer' && !Number.isInteger(v)) return 'cast';
      if (v < domain.min || v > domain.max) return 'value';
      if (domain.notEnum.includes(v)) return 'value';
      return 'ok';
    }
    case 'codes':
      return domain.codes.some((c) => c.value === v) || domain.sentinels.some((s) => s.value === v) ? 'ok' : 'value';
    case 'pattern': {
      if (typeof v !== 'string') return 'value';
      return patternRegex(domain.tag).test(v) ? 'ok' : 'value';
    }
    case 'string-codes': {
      if (typeof v !== 'string') return 'value';
      return patternRegex('household_id').test(v) || domain.sentinels.some((s) => s.value === v) ? 'ok' : 'value';
    }
  }
}

/** @param {PatternDomain['tag']} tag */
function patternRegex(tag) {
  for (const [pattern, t] of PATTERN_TAGS) {
    if (t === tag) return new RegExp(pattern);
  }
  throw new Error(`no pattern for tag ${tag}`);
}

/**
 * Computes every schema-level finding for a set of rows, as
 * `${ruleId}@${row}` strings (column-scope entries use `@-`), mirroring the
 * §D.5 ruleId formats the app's translator will emit.
 * @param {Row[]} rows
 * @param {Column[]} columns
 * @param {Conditional[]} conditionals
 * @param {string[]} extraColumns columns present in rows but absent from the schema
 * @returns {Set<string>}
 */
export function checkRows(rows, columns, conditionals, extraColumns = []) {
  /** @type {Set<string>} */
  const findings = new Set();
  rows.forEach((row, r) => {
    /** @type {Set<string>} */
    const castCells = new Set();
    /** @type {Set<string>} */
    const nullCells = new Set();
    for (const col of columns) {
      const verdict = checkCell(col.domain, req(row.get(col.name), `${col.name} missing in row ${r}`));
      if (verdict === 'required') {
        findings.add(`schema:prop:${col.name}:required@${r}`);
        nullCells.add(col.name);
      } else if (verdict === 'cast') {
        findings.add(`schema:prop:${col.name}:cast@${r}`);
        castCells.add(col.name);
      } else if (verdict === 'value') {
        findings.add(`schema:prop:${col.name}:value@${r}`);
      }
    }
    for (const cond of conditionals) {
      if (!conditionFires(cond, row)) continue;
      for (const target of cond.targets) {
        if (castCells.has(target.col) || nullCells.has(target.col)) continue;
        if (!targetSatisfied(target.c, req(row.get(target.col), target.col))) {
          findings.add(`schema:cond:${cond.allOfIndex}:${target.col}@${r}`);
        }
      }
      for (const group of cond.anyOfGroups) {
        const ok = group.options.some((o) => row.get(o.col) === o.v);
        assert(ok, `row ${r}: then.allOf anyOf group violated at allOf[${cond.allOfIndex}] (fixtures never seed this)`);
      }
    }
  });
  for (const name of extraColumns) {
    findings.add(`schema:column:${name}:unexpected@-`);
  }
  // Full-row duplicates (schema uniqueItems, evaluated dataset-side by the app).
  /** @type {Map<string, number>} */
  const seen = new Map();
  rows.forEach((row, r) => {
    const key = JSON.stringify([...row.values()]);
    if (seen.has(key)) findings.add('schema:dataset:duplicate-records@-');
    else seen.set(key, r);
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Valid-data generation
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   householdId: string, sampleId: string, entryWave: number, waves: number[],
 *   entryAge: number, education: number | string, tenure: number, partner: number,
 *   adultCount: number, childCount: number, receipts: boolean[], allReceipts: boolean
 * }} Household
 */

/**
 * Builds the deterministic household plan: 6×3-wave + 8×2-wave + 66×1-wave
 * = 100 rows over 80 households (14 multi-wave; spec floor is 6).
 * @param {() => number} rng
 * @param {(number | string)[]} educationCodes
 * @returns {Household[]}
 */
function buildHouseholdPlan(rng, educationCodes) {
  /** @type {Household[]} */
  const households = [];
  /** @param {number} k @param {number[]} waves */
  const make = (k, waves) => {
    const allReceipts = households.length < 2; // first two 3-wave households anchor Q021
    households.push({
      householdId: `HH${String(10000000 + k * 13).padStart(8, '0')}`,
      sampleId: `S${String(1000000000 + k * 7).padStart(10, '0')}`,
      entryWave: req(waves[0]),
      waves,
      entryAge: randInt(rng, 25, 75),
      education: pick(rng, educationCodes),
      tenure: pick(rng, [1, 1, 1, 2, 2, 3, 3, 3, 3, 4, 5]),
      partner: rng() < 0.55 ? 1 : 0,
      adultCount: 0, // fixed up below
      childCount: randInt(rng, 0, 3),
      receipts: allReceipts
        ? INCOME_COMPONENTS.map(() => true)
        : [rng() < 0.7, rng() < 0.2, rng() < 0.3, rng() < 0.25, rng() < 0.1, rng() < 0.2, rng() < 0.05, rng() < 0.1, rng() < 0.1],
      allReceipts,
    });
  };
  let k = 0;
  for (let i = 0; i < 6; i++) make(k++, [1, 2, 3]);
  for (let i = 0; i < 8; i++) make(k++, i < 4 ? [1, 2] : [2, 3]);
  for (let i = 0; i < 66; i++) make(k++, [1 + (i % 5)]);
  for (const h of households) {
    h.adultCount = 1 + h.partner + (rng() < 0.2 ? 1 : 0);
  }
  return households;
}

/**
 * Generates the 100 schema-clean, rules-clean base rows.
 * @param {Column[]} columns
 * @param {Conditional[]} conditionals
 * @returns {Row[]}
 */
export function generateValid(columns, conditionals) {
  const rng = mulberry32(SEED);
  const colByName = new Map(columns.map((c) => [c.name, c]));
  const educationDomain = req(colByName.get('reference_education'), 'reference_education column').domain;
  assert(educationDomain.kind === 'codes', 'reference_education is a codes column');
  const educationCodes = educationDomain.codes.map((c) => c.value);
  const households = buildHouseholdPlan(rng, educationCodes);

  /** @type {{h: Household, wave: number}[]} */
  const rowPlan = [];
  for (const h of households) for (const wave of h.waves) rowPlan.push({ h, wave });
  rowPlan.sort((a, b) => a.wave - b.wave || (a.h.householdId < b.h.householdId ? -1 : 1));
  assert(rowPlan.length === BASE_ROWS, `row plan has ${rowPlan.length} rows`);

  /** @type {Row[]} */
  const rows = rowPlan.map(({ h, wave }) => {
    /** @type {Row} */
    const row = new Map();
    const year = 2019 + wave;
    for (const col of columns) {
      row.set(col.name, initialValue(col, h, wave, year, rng));
    }
    return row;
  });

  repairConditionals(rows, conditionals, colByName, rng);

  // Q021: exact component sums (all rows get total = sum of substantive
  // components; the guard only binds where every component is substantive).
  for (const row of rows) {
    let sum = 0;
    for (const comp of INCOME_COMPONENTS) {
      const v = req(row.get(comp), comp);
      if (typeof v === 'number' && v >= 0) sum += v;
    }
    row.set(INCOME_TOTAL, sum);
  }
  repairConditionals(rows, conditionals, colByName, rng);

  // Q038: tie the top two substantive rents per wave so the per-wave maximum
  // never exceeds quantile_cont(0.995) — otherwise valid data would flag.
  /** @type {Map<number, number[]>} */
  const rentersByWave = new Map();
  rows.forEach((row, i) => {
    const rent = req(row.get('monthly_rent'));
    if (req(row.get('tenure')) === 3 && typeof rent === 'number' && rent > 0) {
      const wave = Number(req(row.get('wave')));
      const list = rentersByWave.get(wave) ?? [];
      list.push(i);
      rentersByWave.set(wave, list);
    }
  });
  for (const [wave, idxs] of rentersByWave) {
    assert(idxs.length !== 0, `wave ${wave} renter bookkeeping`);
    if (idxs.length < 2) continue; // single renter: max never exceeds its own quantile
    const sorted = [...idxs].sort(
      (a, b) => Number(req(req(rows[b]).get('monthly_rent'))) - Number(req(req(rows[a]).get('monthly_rent'))),
    );
    const top = Number(req(req(rows[req(sorted[0])]).get('monthly_rent')));
    req(rows[req(sorted[1])]).set('monthly_rent', top);
  }
  repairConditionals(rows, conditionals, colByName, rng);

  assertValidInvariants(rows, columns, conditionals, rowPlan);
  return rows;
}

/**
 * @param {Column} col
 * @param {Household} h
 * @param {number} wave
 * @param {number} year
 * @param {() => number} rng
 * @returns {Cell}
 */
function initialValue(col, h, wave, year, rng) {
  const { name, domain } = col;
  // Identity & panel bookkeeping (drivers of key rules, set exactly).
  switch (name) {
    case 'record_id':
      return `${h.householdId}_W${String(wave).padStart(2, '0')}`;
    case 'household_id':
      return h.householdId;
    case 'respondent_id':
      return `${h.householdId}_P01`;
    case 'sample_household_id':
      return h.sampleId;
    case 'interview_date':
      return `${year}-${String(3 + randInt(rng, 0, 3)).padStart(2, '0')}-${String(randInt(rng, 5, 27)).padStart(2, '0')}`;
    case 'reference_year':
      return year - 1;
    case 'wave':
      return wave;
    case 'panel_entry_wave':
      return h.entryWave;
    case 'baseline_record':
      return wave === h.entryWave ? 1 : 0;
    case 'reference_age':
      return h.entryAge + (wave - h.entryWave);
    case 'reference_education':
      return h.education;
    case 'tenure':
      return h.tenure;
    case 'partner_present':
      return h.partner;
    case 'marital_status':
      return h.partner === 1 ? pick(rng, [1, 2]) : pick(rng, [3, 4, 5, 6]);
    case 'adult_count':
      return h.adultCount;
    case 'child_count':
      return h.childCount;
    case 'household_size':
      return h.adultCount + h.childCount; // Q011 arithmetic (not schema-enforced)
    case 'monthly_rent':
      return h.tenure === 3 ? amount(rng, 400, 3500) : -666;
    // Both force tenure=3 through conditionals (allOf 44/45); initialize them
    // consistently with the archetype so repair doesn't flip tenure.
    case 'public_housing':
      return h.tenure === 3 && rng() < 0.25 ? 1 : 0;
    case 'housing_assistance_received':
      return h.tenure === 3 && rng() < 0.35 ? 1 : 0;
    default:
      break;
  }
  const receiptIdx = INCOME_COMPONENTS.indexOf(name.replace(/_received$/, '_annual'));
  if (name.endsWith('_received') && receiptIdx !== -1) {
    return req(h.receipts[receiptIdx]) ? 1 : 0;
  }
  const componentIdx = INCOME_COMPONENTS.indexOf(name);
  if (componentIdx !== -1) {
    if (!req(h.receipts[componentIdx])) return -666;
    return name === 'wage_income_annual' ? amount(rng, 15000, 120000) : amount(rng, 500, 30000);
  }
  if (name === INCOME_TOTAL) return 0; // exact sum applied post-repair
  return domainValue(domain, rng, name);
}

/**
 * Domain-driven fill with a small deterministic sentinel share for realism.
 * @param {Domain} domain
 * @param {() => number} rng
 * @param {string} name
 * @returns {Cell}
 */
function domainValue(domain, rng, name) {
  switch (domain.kind) {
    case 'codes': {
      if (domain.codes.length === 0) return req(domain.sentinels[0], `${name} has no codes`).value;
      if (domain.sentinels.length > 0 && rng() < 0.06) return pick(rng, domain.sentinels).value;
      return pick(rng, domain.codes).value;
    }
    case 'numeric': {
      if (domain.sentinels.length > 0 && rng() < 0.06) return pick(rng, domain.sentinels).value;
      return numericSubstantive(domain, rng, name, new Set());
    }
    case 'pattern':
      // Only reachable for date-tagged leftovers (all id patterns are set explicitly).
      assert(domain.tag === 'date', `unhandled pattern column ${name}`);
      return `2024-${String(randInt(rng, 1, 12)).padStart(2, '0')}-${String(randInt(rng, 1, 28)).padStart(2, '0')}`;
    case 'string-codes':
      return req(domain.sentinels[0], `${name} needs a string sentinel`).value;
  }
}

/**
 * Generates a substantive (non-sentinel) numeric value inside the domain,
 * clamped to a plausible window, avoiding excluded and forbidden values.
 * @param {NumericDomain} domain
 * @param {() => number} rng
 * @param {string} name
 * @param {Set<number | string>} avoid
 * @returns {number}
 */
function numericSubstantive(domain, rng, name, avoid) {
  const lo = Math.max(domain.min, 0);
  const window = domain.max - lo > 250000 ? 250000 : domain.max - lo;
  const hi = lo + window;
  const forbidden = Q047_TARGETS.includes(name) ? LEGACY_SENTINELS : new Set();
  for (let attempt = 0; attempt < 50; attempt++) {
    let v;
    if (domain.numType === 'integer') {
      v = randInt(rng, lo, hi);
    } else {
      v = Math.round((lo + rng() * (hi - lo)) * 100) / 100; // k/100 grid
    }
    if (domain.notEnum.includes(v) || forbidden.has(v) || avoid.has(v)) continue;
    if (DEBT_COLUMNS.includes(name) && v < 0) continue;
    if (name === 'monthly_rent' && v >= 20000) continue; // Q050 threshold
    return v;
  }
  throw new Error(`could not generate substantive value for ${name}`);
}

/**
 * Iterates all conditionals over all rows to a fixpoint, mutating rows so
 * every fired conditional's targets are satisfied.
 * @param {Row[]} rows
 * @param {Conditional[]} conditionals
 * @param {Map<string, Column>} colByName
 * @param {() => number} rng
 */
function repairConditionals(rows, conditionals, colByName, rng) {
  for (let pass = 0; pass < 10; pass++) {
    let changes = 0;
    for (const row of rows) {
      for (const cond of conditionals) {
        if (!conditionFires(cond, row)) continue;
        for (const target of cond.targets) {
          const current = req(row.get(target.col), target.col);
          if (targetSatisfied(target.c, current)) continue;
          row.set(target.col, repairValue(target.c, req(colByName.get(target.col), target.col).domain, rng, target.col));
          changes++;
        }
        for (const group of cond.anyOfGroups) {
          if (group.options.some((o) => row.get(o.col) === o.v)) continue;
          const first = req(group.options[0]);
          row.set(first.col, first.v);
          changes++;
        }
      }
    }
    if (changes === 0) return;
  }
  throw new Error('conditional repair did not converge within 10 passes');
}

/**
 * @param {TargetConstraint} c
 * @param {Domain} domain
 * @param {() => number} rng
 * @param {string} name
 * @returns {Cell}
 */
function repairValue(c, domain, rng, name) {
  switch (c.t) {
    case 'const':
      return c.v;
    case 'enum':
      return req(c.vs[0]);
    case 'not-const':
    case 'not-enum': {
      const avoid = new Set(c.t === 'not-const' ? [c.v] : c.vs);
      if (domain.kind === 'numeric') return numericSubstantive(domain, rng, name, avoid);
      if (domain.kind === 'codes') {
        const ok = domain.codes.filter((code) => !avoid.has(code.value));
        assert(ok.length > 0, `no substantive code available for ${name}`);
        return pick(rng, ok).value;
      }
      if (domain.kind === 'string-codes') {
        const ok = domain.sentinels.filter((s) => !avoid.has(s.value));
        assert(ok.length > 0, `no string code available for ${name}`);
        return req(ok[0]).value;
      }
      throw new Error(`cannot repair not-const on pattern column ${name}`);
    }
    case 'any-of': {
      assert(domain.kind === 'numeric' || domain.kind === 'codes', `any-of repair on ${name}`);
      return randInt(rng, c.min, c.max);
    }
  }
}

/**
 * Full valid-file gate: zero schema findings AND the hand-checkable
 * invariants behind every enabled rule in the three example files.
 * @param {Row[]} rows
 * @param {Column[]} columns
 * @param {Conditional[]} conditionals
 * @param {{h: Household, wave: number}[]} rowPlan
 */
function assertValidInvariants(rows, columns, conditionals, rowPlan) {
  const findings = checkRows(rows, columns, conditionals);
  assert(findings.size === 0, `valid rows have schema findings: ${[...findings].slice(0, 8).join(', ')}`);

  /** @type {Set<string>} */
  const recordIds = new Set();
  /** @type {Set<string>} */
  const hhWaves = new Set();
  /** @type {Map<string, Map<number, Row>>} */
  const byHousehold = new Map();
  rows.forEach((row) => {
    const recordId = String(req(row.get('record_id')));
    const hh = String(req(row.get('household_id')));
    const wave = Number(req(row.get('wave')));
    assert(!recordIds.has(recordId), `Q001: duplicate record_id ${recordId}`);
    recordIds.add(recordId);
    assert(!hhWaves.has(`${hh}|${wave}`), `Q002/H005: duplicate household-wave ${hh} ${wave}`);
    hhWaves.add(`${hh}|${wave}`);
    assert(recordId === `${hh}_W${String(wave).padStart(2, '0')}`, `Q003: bad composition ${recordId}`);
    const entry = Number(req(row.get('panel_entry_wave')));
    const baseline = Number(req(row.get('baseline_record')));
    assert(entry <= wave && (baseline === 1) === (wave === entry), `Q007: panel logic ${recordId}`);
    const date = String(req(row.get('interview_date')));
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(req(y), req(m) - 1, req(d)));
    assert(dt.getUTCMonth() === req(m) - 1 && dt.getUTCDate() === req(d), `H004: bad date ${date}`);
    const size = req(row.get('household_size'));
    const adults = req(row.get('adult_count'));
    const children = req(row.get('child_count'));
    if (typeof size === 'number' && size >= 1 && typeof adults === 'number' && adults >= 0 && typeof children === 'number' && children >= 0) {
      assert(adults + children === size, `Q011: roster arithmetic ${recordId}`);
    }
    const partner = req(row.get('partner_present'));
    const marital = req(row.get('marital_status'));
    assert(!(partner === 1 && typeof marital === 'number' && [3, 4, 5, 6].includes(marital)), `Q013: ${recordId}`);
    const components = INCOME_COMPONENTS.map((c) => req(row.get(c)));
    const total = req(row.get(INCOME_TOTAL));
    if (typeof total === 'number' && total >= 0 && components.every((v) => typeof v === 'number' && v >= 0)) {
      let sum = 0;
      for (const v of components) sum += Number(v);
      assert(Math.abs(sum - total) <= Math.max(50, 0.01 * total), `Q021: income sum ${recordId}`);
    }
    for (const name of Q047_TARGETS) {
      const v = req(row.get(name));
      assert(!(typeof v === 'number' && LEGACY_SENTINELS.has(v)), `Q047: legacy sentinel in ${name} ${recordId}`);
    }
    const tenure = req(row.get('tenure'));
    const rent = req(row.get('monthly_rent'));
    assert(!(typeof tenure === 'number' && [1, 2, 4, 5].includes(tenure) && rent !== -666), `Q048: ${recordId}`);
    assert(!(typeof rent === 'number' && rent >= 20000), `Q050: cents-scale rent ${recordId}`);
    for (const name of DEBT_COLUMNS) {
      const v = req(row.get(name));
      assert(!(typeof v === 'number' && v < 0 && !SENTINEL_VALUES.has(v)), `Q052: negative debt ${name} ${recordId}`);
    }
    const perWave = byHousehold.get(hh) ?? new Map();
    perWave.set(wave, row);
    byHousehold.set(hh, perWave);
  });
  // Longitudinal invariants (Q008 age deltas, Q055 education stability).
  for (const [hh, perWave] of byHousehold) {
    const waves = [...perWave.keys()].sort((a, b) => a - b);
    for (let i = 1; i < waves.length; i++) {
      const w0 = req(waves[i - 1]);
      const w1 = req(waves[i]);
      if (w1 - w0 !== 1) continue;
      const a0 = req(req(perWave.get(w0)).get('reference_age'));
      const a1 = req(req(perWave.get(w1)).get('reference_age'));
      if (typeof a0 === 'number' && a0 >= 0 && typeof a1 === 'number' && a1 >= 0) {
        assert(a1 - a0 >= 0 && a1 - a0 <= 2, `Q008: age regression in ${hh}`);
      }
      const e0 = req(req(perWave.get(w0)).get('reference_education'));
      const e1 = req(req(perWave.get(w1)).get('reference_education'));
      assert(!(typeof e1 === 'number' && SENTINEL_VALUES.has(e1) && typeof e0 === 'number' && e0 >= 1 && e0 <= 6), `Q055: ${hh}`);
    }
  }
  // Q038: within each wave the maximum substantive rent must not be unique.
  /** @type {Map<number, number[]>} */
  const rentsByWave = new Map();
  for (const row of rows) {
    const rent = req(row.get('monthly_rent'));
    if (typeof rent === 'number' && rent > 0) {
      const wave = Number(req(row.get('wave')));
      const list = rentsByWave.get(wave) ?? [];
      list.push(rent);
      rentsByWave.set(wave, list);
    }
  }
  for (const [wave, rents] of rentsByWave) {
    if (rents.length < 2) continue;
    const max = Math.max(...rents);
    assert(rents.filter((r) => r === max).length >= 2, `Q038: unique max rent in wave ${wave}`);
  }
  assert(rowPlan.filter(({ h, wave }) => h.allReceipts && wave >= 1).length >= 2, 'Q021 needs all-receipt rows');
}

// ---------------------------------------------------------------------------
// Violation injection (testing-strategy §3.1 kinds, ground truth hand-authored
// and machine-cross-checked against checkRows)
// ---------------------------------------------------------------------------

/**
 * @typedef {{kind: string, rows: number[], column: string | null, before: Cell, after: Cell, expectedRuleIds: string[]}} Injection
 */

export const EXTRA_COLUMN = 'notes';

/**
 * @param {Row[]} validRows
 * @param {Column[]} columns
 * @param {Conditional[]} conditionals
 * @returns {{dirtyRows: Row[], injections: Injection[]}}
 */
export function injectViolations(validRows, columns, conditionals) {
  /** @type {Row[]} */
  const rows = validRows.map((row) => new Map(row));
  rows.forEach((row, i) => row.set(EXTRA_COLUMN, `memo-${i % 4}`));

  /** @type {Set<number>} */
  const used = new Set();
  /**
   * First row matching the predicate that no earlier injection touched.
   * @param {(row: Row, i: number) => boolean} predicate
   * @param {string} label
   */
  const pickRow = (predicate, label) => {
    for (let i = 0; i < rows.length; i++) {
      if (!used.has(i) && predicate(req(rows[i]), i)) {
        used.add(i);
        return i;
      }
    }
    throw new Error(`no eligible row for injection: ${label}`);
  };
  /** @type {Injection[]} */
  const injections = [];
  /**
   * @param {string} kind
   * @param {number} r
   * @param {string} column
   * @param {Cell} after
   * @param {string[]} expectedRuleIds
   */
  const setCell = (kind, r, column, after, expectedRuleIds) => {
    const row = req(rows[r]);
    const before = req(row.get(column), column);
    row.set(column, after);
    injections.push({ kind, rows: [r], column, before, after, expectedRuleIds });
  };

  const wave = (/** @type {Row} */ row) => Number(req(row.get('wave')));
  /** @type {Map<string, number>} */
  const wavesPerHousehold = new Map();
  for (const row of rows) {
    const hh = String(req(row.get('household_id')));
    wavesPerHousehold.set(hh, (wavesPerHousehold.get(hh) ?? 0) + 1);
  }
  const isSingleWave = (/** @type {Row} */ row) => wavesPerHousehold.get(String(req(row.get('household_id')))) === 1;
  /** Top-two substantive rents per wave (tie partners must not be disturbed). */
  const topRentRows = new Set();
  /** @type {Map<number, {i: number, rent: number}[]>} */
  const rentersByWave = new Map();
  rows.forEach((row, i) => {
    const rent = req(row.get('monthly_rent'));
    if (typeof rent === 'number' && rent > 0) {
      const list = rentersByWave.get(wave(row)) ?? [];
      list.push({ i, rent });
      rentersByWave.set(wave(row), list);
    }
  });
  for (const list of rentersByWave.values()) {
    list.sort((a, b) => b.rent - a.rent);
    for (const { i } of list.slice(0, 2)) topRentRows.add(i);
  }

  // -- Schema-level breaks -------------------------------------------------
  {
    const r = pickRow((row) => isSingleWave(row), 'pattern-break');
    setCell('pattern-break', r, 'record_id', `HH1234_W${String(wave(req(rows[r]))).padStart(2, '0')}`, [
      'schema:prop:record_id:value',
      'Q003',
    ]);
  }
  {
    const r = pickRow(() => true, 'range-break');
    setCell('range-break', r, 'reference_year', 2150, ['schema:prop:reference_year:value']);
  }
  {
    const r = pickRow((row) => row.get('wage_income_received') === 1, 'sentinel-in-numeric-branch');
    setCell('sentinel-in-numeric-branch', r, 'wage_income_annual', -555, ['schema:prop:wage_income_annual:value']);
  }
  {
    const r = pickRow((row) => row.get('baseline_record') === 1, 'ifthen-const-break');
    setCell('ifthen-const-break', r, 'move_reason', 3, ['schema:cond:12:move_reason']);
  }
  {
    const r = pickRow((row) => row.get('moved_since_last_wave') === 1, 'ifthen-notconst-break');
    setCell('ifthen-notconst-break', r, 'move_reason', -666, ['schema:cond:14:move_reason']);
  }
  {
    const r = pickRow(() => true, 'cast-non-numeric');
    setCell('cast-non-numeric', r, 'sample_stratum', 'twelve hundred', ['schema:prop:sample_stratum:cast']);
  }
  {
    const r = pickRow(() => true, 'cast-non-integral');
    setCell('cast-non-integral', r, 'sample_psu', '412.75', ['schema:prop:sample_psu:cast']);
  }
  {
    const r = pickRow((row) => row.get('partner_present') === 1, 'empty-cell');
    setCell('empty-cell', r, 'partner_age', null, ['schema:prop:partner_age:required']);
  }
  {
    const r = pickRow(() => true, 'empty-cell-key');
    setCell('empty-cell-key', r, 'interview_date', null, ['schema:prop:interview_date:required', 'H002']);
  }

  // -- Rules-level breaks (schema-clean by construction) ---------------------
  {
    const r = pickRow((row) => isSingleWave(row), 'record-id-decomposition');
    setCell('record-id-decomposition', r, 'record_id', `HH99999901_W${String(wave(req(rows[r]))).padStart(2, '0')}`, ['Q003']);
  }
  {
    // Last wave of a 2-wave household: exactly one adjacent pair is affected.
    const r = pickRow((row) => {
      const hh = String(req(row.get('household_id')));
      return wavesPerHousehold.get(hh) === 2 && Number(req(row.get('wave'))) > Number(req(row.get('panel_entry_wave')));
    }, 'age-regression');
    const before = Number(req(req(rows[r]).get('reference_age')));
    setCell('age-regression', r, 'reference_age', before - 5, ['Q008']);
  }
  {
    const r = pickRow((row) => typeof row.get('household_size') === 'number', 'roster-arithmetic');
    const before = Number(req(req(rows[r]).get('household_size')));
    setCell('roster-arithmetic', r, 'household_size', before + 1, ['Q011']);
  }
  {
    const r = pickRow(
      (row) =>
        INCOME_COMPONENTS.every((c) => {
          const v = row.get(c);
          return typeof v === 'number' && v >= 0;
        }) && typeof row.get(INCOME_TOTAL) === 'number',
      'income-sum-tolerance',
    );
    const before = Number(req(req(rows[r]).get(INCOME_TOTAL)));
    setCell('income-sum-tolerance', r, INCOME_TOTAL, before + 5000, ['Q021']);
  }
  {
    const r = pickRow(
      (row, i) => row.get('tenure') === 3 && Number(req(row.get('monthly_rent'))) > 777 && !topRentRows.has(i),
      'legacy-sentinel-777',
    );
    setCell('legacy-sentinel-777', r, 'monthly_rent', 777, ['Q047']);
  }
  {
    const r = pickRow((row) => Number(req(row.get('credit_card_balance'))) > 0, 'legacy-sentinel-888');
    setCell('legacy-sentinel-888', r, 'credit_card_balance', 888, ['Q047']);
  }
  {
    const r = pickRow(
      (row) =>
        row.get('wage_income_received') === 1 &&
        INCOME_COMPONENTS.some((c) => {
          const v = row.get(c);
          return typeof v === 'number' && v < 0;
        }),
      'legacy-sentinel-999',
    );
    setCell('legacy-sentinel-999', r, 'wage_income_annual', 999, ['Q047']);
  }
  {
    const r = pickRow((row, i) => row.get('tenure') === 3 && Number(req(row.get('monthly_rent'))) > 0 && !topRentRows.has(i), 'cents-scaled-rent');
    setCell('cents-scaled-rent', r, 'monthly_rent', 49500, ['Q050', 'Q038']);
  }
  {
    const r = pickRow((row) => Number(req(row.get('credit_card_balance'))) > 0, 'negative-debt');
    setCell('negative-debt', r, 'credit_card_balance', -1200, ['schema:prop:credit_card_balance:value', 'Q052']);
  }
  {
    const r = pickRow((row) => isSingleWave(row), 'malformed-household-id');
    setCell('malformed-household-id', r, 'household_id', 'hh-42', ['schema:prop:household_id:value', 'H001', 'H006', 'Q003']);
  }
  {
    const r = pickRow(() => true, 'invalid-calendar-date');
    setCell('invalid-calendar-date', r, 'interview_date', '2026-02-30', ['H004']);
  }

  // -- Duplicates & the extra column ----------------------------------------
  {
    // Edit household_id only: same-wave collision between two single-wave households.
    const k = pickRow((row) => isSingleWave(row), 'duplicate-household-wave (edited row)');
    const kWave = wave(req(rows[k]));
    const j = pickRow((row, i) => i !== k && isSingleWave(row) && wave(row) === kWave, 'duplicate-household-wave (collision partner)');
    const before = req(req(rows[k]).get('household_id'));
    const after = req(req(rows[j]).get('household_id'));
    req(rows[k]).set('household_id', after);
    injections.push({ kind: 'duplicate-household-wave', rows: [j, k], column: 'household_id', before, after, expectedRuleIds: ['Q002', 'Q003', 'H005'] });
  }
  {
    const r = pickRow((row) => isSingleWave(row), 'duplicate-full-row');
    const copy = new Map(req(rows[r]));
    rows.push(copy);
    injections.push({
      kind: 'duplicate-full-row',
      rows: [r, rows.length - 1],
      column: null,
      before: null,
      after: null,
      expectedRuleIds: ['schema:dataset:duplicate-records', 'Q001', 'Q002', 'H005'],
    });
  }
  injections.push({
    kind: 'extra-column',
    rows: [],
    column: EXTRA_COLUMN,
    before: null,
    after: null,
    expectedRuleIds: [`schema:column:${EXTRA_COLUMN}:unexpected`],
  });

  crossCheckSchemaFindings(rows, columns, conditionals, injections);
  return { dirtyRows: rows, injections };
}

/**
 * The hand-authored schema-level expectations must equal checkRows' output
 * exactly — in both directions — so unforeseen cascades cannot ship silently.
 * @param {Row[]} rows
 * @param {Column[]} columns
 * @param {Conditional[]} conditionals
 * @param {Injection[]} injections
 */
function crossCheckSchemaFindings(rows, columns, conditionals, injections) {
  /** @type {Set<string>} */
  const expected = new Set();
  for (const inj of injections) {
    for (const id of inj.expectedRuleIds) {
      if (!id.startsWith('schema:')) continue;
      if (id.startsWith('schema:column:') || id.startsWith('schema:dataset:')) {
        expected.add(`${id}@-`);
      } else {
        for (const r of inj.rows) expected.add(`${id}@${r}`);
      }
    }
  }
  const actual = checkRows(rows, columns, conditionals, [EXTRA_COLUMN]);
  const missing = [...expected].filter((f) => !actual.has(f));
  const surplus = [...actual].filter((f) => !expected.has(f));
  assert(
    missing.length === 0 && surplus.length === 0,
    `schema findings mismatch — missing: [${missing.join(', ')}] surplus: [${surplus.join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Serialization (all byte-deterministic; LF everywhere; no timestamps)
// ---------------------------------------------------------------------------

/** @param {Cell} v */
function textCell(v) {
  if (v === null) return '';
  const s = String(v);
  assert(!/[",\t\r\n]/.test(s), `cell value needs quoting (unsupported by design): ${s}`);
  return s;
}

/**
 * @param {Row[]} rows
 * @param {string[]} header
 * @param {string} sep
 */
export function serializeDelimited(rows, header, sep) {
  const lines = [header.join(sep)];
  for (const row of rows) {
    lines.push(header.map((c) => textCell(req(row.get(c), c))).join(sep));
  }
  return lines.join('\n') + '\n';
}

/**
 * One row object per line for reviewable diffs.
 * @param {Row[]} rows
 * @param {string[]} header
 */
function serializeJson(rows, header) {
  const lines = rows.map((row) => {
    /** @type {Record<string, Cell>} */
    const obj = {};
    for (const c of header) obj[c] = req(row.get(c), c);
    return '  ' + JSON.stringify(obj);
  });
  return '[\n' + lines.join(',\n') + '\n]\n';
}

/**
 * A tiny strict CSV parser for the generator's own output (no quoting by
 * construction). Exported for the unit tests — PapaParse arrives in P10.
 * @param {string} text
 * @param {string} [sep]
 * @returns {{header: string[], rows: string[][]}}
 */
export function parseDelimited(text, sep = ',') {
  const lines = text.split('\n');
  assert(req(lines.pop()) === '', 'file must end with exactly one trailing newline');
  const header = req(lines.shift(), 'empty file').split(sep);
  const rows = lines.map((line) => line.split(sep));
  for (const row of rows) assert(row.length === header.length, 'ragged row');
  return { header, rows };
}

/**
 * Converts parsed CSV strings back into typed cells using the column domains
 * (numbers for numeric/codes columns when they parse; null for empties).
 * @param {{header: string[], rows: string[][]}} parsed
 * @param {Column[]} columns
 * @returns {Row[]}
 */
export function typeCsvRows(parsed, columns) {
  const domainByName = new Map(columns.map((c) => [c.name, c.domain]));
  return parsed.rows.map((cells) => {
    /** @type {Row} */
    const row = new Map();
    parsed.header.forEach((name, i) => {
      const raw = req(cells[i]);
      const domain = domainByName.get(name);
      if (raw === '') {
        row.set(name, null);
      } else if (domain !== undefined && (domain.kind === 'numeric' || domain.kind === 'codes') && NUMERIC_STRING.test(raw)) {
        row.set(name, Number(raw));
      } else {
        row.set(name, raw);
      }
    });
    return row;
  });
}

// -- XLSX -------------------------------------------------------------------

/** Fixed DOS datetime 1980-01-01 00:00:00 for zip entries (determinism). */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

/**
 * exceljs (via jszip) stamps wall-clock mtimes into every zip entry; rewrite
 * them in both the central directory and each local header.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function normalizeZipTimestamps(buf) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  assert(eocd !== -1, 'zip EOCD not found');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n++) {
    assert(buf.readUInt32LE(offset) === 0x02014b50, 'central directory signature expected');
    buf.writeUInt16LE(DOS_TIME, offset + 12);
    buf.writeUInt16LE(DOS_DATE, offset + 14);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    assert(buf.readUInt32LE(localOffset) === 0x04034b50, 'local header signature expected');
    buf.writeUInt16LE(DOS_TIME, localOffset + 10);
    buf.writeUInt16LE(DOS_DATE, localOffset + 12);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return buf;
}

/**
 * @param {Row[]} rows
 * @param {string[]} header
 * @returns {Promise<Buffer>}
 */
async function buildXlsx(rows, header) {
  const workbook = new ExcelJS.Workbook();
  const fixed = new Date(Date.UTC(2026, 6, 23));
  workbook.creator = 'QuaC fixtures';
  workbook.lastModifiedBy = 'QuaC fixtures';
  workbook.created = fixed;
  workbook.modified = fixed;
  const sheet = workbook.addWorksheet('hesp_dirty_100');
  sheet.addRow(header);
  for (const row of rows) {
    sheet.addRow(header.map((c) => req(row.get(c), c)));
  }
  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  return normalizeZipTimestamps(buf);
}

/**
 * P05 append: tests/fixtures/tiny/two_sheets.xlsx — the SheetPickerModal e2e
 * fixture (the HESP workbook is single-sheet). Sheet names and cell values
 * are distinctive so the test can assert WHICH sheet was ingested. Written
 * only on default runs (fixtures:check gates drift); the `--out` determinism
 * harness in generator.test.ts keeps covering the hesp set untouched.
 * @returns {Promise<Buffer>}
 */
async function buildTwoSheetsXlsx() {
  const workbook = new ExcelJS.Workbook();
  const fixed = new Date(Date.UTC(2026, 6, 23));
  workbook.creator = 'QuaC fixtures';
  workbook.lastModifiedBy = 'QuaC fixtures';
  workbook.created = fixed;
  workbook.modified = fixed;

  const notes = workbook.addWorksheet('notes');
  notes.addRow(['about']);
  notes.addRow(['decoy sheet — the data lives on the second sheet']);

  const people = workbook.addWorksheet('people');
  people.addRow(['pet_id', 'pet_name', 'species']);
  people.addRow(['D001', 'Quackers', 'duck']);
  people.addRow(['D002', 'Waddles', 'duck']);
  people.addRow(['D003', 'Bill', 'duck']);
  people.addRow(['D004', 'Puddle', 'goose']);

  const buf = Buffer.from(await workbook.xlsx.writeBuffer());
  return normalizeZipTimestamps(buf);
}

// -- Parquet ------------------------------------------------------------------

/**
 * @param {Row[]} rows
 * @param {string[]} header
 * @param {Column[]} columns
 * @param {string} outFile
 */
async function writeParquet(rows, header, columns, outFile) {
  const domainByName = new Map(columns.map((c) => [c.name, c.domain]));
  /** @type {Map<string, string>} */
  const sqlTypes = new Map();
  for (const name of header) {
    const domain = domainByName.get(name);
    let t = 'VARCHAR';
    if (domain !== undefined) {
      if (domain.kind === 'numeric') t = domain.numType === 'number' ? 'DOUBLE' : 'BIGINT';
      else if (domain.kind === 'codes') t = 'BIGINT';
    }
    // Columns carrying string injections must stay VARCHAR (a real-world
    // dirty parquet cannot hold text in a numeric column any other way).
    if (t !== 'VARCHAR' && rows.some((row) => typeof row.get(name) === 'string')) t = 'VARCHAR';
    sqlTypes.set(name, t);
  }
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run('SET threads=1');
  const colDefs = header.map((name) => `"${name}" ${req(sqlTypes.get(name))}`).join(', ');
  await conn.run(`CREATE TABLE dirty (${colDefs})`);
  const chunkSize = 20;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values = chunk
      .map((row) => '(' + header.map((name) => sqlLiteral(req(row.get(name), name), req(sqlTypes.get(name)))).join(', ') + ')')
      .join(',\n');
    await conn.run(`INSERT INTO dirty VALUES\n${values}`);
  }
  await conn.run(`COPY dirty TO '${outFile.replace(/\\/g, '/')}' (FORMAT parquet)`);
  conn.closeSync();
  instance.closeSync();
}

/**
 * Content equality of two parquet files: identical column schema (DESCRIBE)
 * and identical ordered rows (row_number-paired EXCEPT ALL in both
 * directions). Needed because DuckDB's native parquet bytes differ across
 * platform builds for the same data (V16), so `fixtures:check` cannot rely on
 * byte equality for this one format.
 * @param {string} fileA
 * @param {string} fileB
 * @returns {Promise<boolean>}
 */
export async function parquetFilesEqual(fileA, fileB) {
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    await conn.run('SET threads=1');
    const a = fileA.replace(/\\/g, '/').replace(/'/g, "''");
    const b = fileB.replace(/\\/g, '/').replace(/'/g, "''");
    const schemaA = await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${a}')`);
    const schemaB = await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${b}')`);
    if (JSON.stringify(schemaA.getRows()) !== JSON.stringify(schemaB.getRows())) return false;
    await conn.run(`CREATE TABLE ta AS SELECT row_number() OVER () AS __rn, * FROM read_parquet('${a}')`);
    await conn.run(`CREATE TABLE tb AS SELECT row_number() OVER () AS __rn, * FROM read_parquet('${b}')`);
    const diff = await conn.runAndReadAll(
      'SELECT count(*) FROM ((SELECT * FROM ta EXCEPT ALL SELECT * FROM tb) UNION ALL (SELECT * FROM tb EXCEPT ALL SELECT * FROM ta))',
    );
    return Number(diff.getRows()[0]?.[0]) === 0;
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

/**
 * Writes the parquet but leaves an existing target untouched when the fresh
 * output is content-identical (V16: bytes legitimately differ across
 * platforms; a byte rewrite would permanently dirty `fixtures:check` for
 * every platform except the one that committed the file).
 * @param {Row[]} rows
 * @param {string[]} header
 * @param {Column[]} columns
 * @param {string} outFile
 */
async function writeParquetStable(rows, header, columns, outFile) {
  if (!existsSync(outFile)) {
    await writeParquet(rows, header, columns, outFile);
    return;
  }
  const freshFile = `${outFile}.fresh`;
  await writeParquet(rows, header, columns, freshFile);
  if (await parquetFilesEqual(freshFile, outFile)) {
    rmSync(freshFile);
    return;
  }
  renameSync(freshFile, outFile);
}

/**
 * @param {Cell} v
 * @param {string} sqlType
 */
function sqlLiteral(v, sqlType) {
  if (v === null) return 'NULL';
  if (sqlType === 'VARCHAR') return `'${String(v).replace(/'/g, "''")}'`;
  assert(typeof v === 'number', `numeric SQL literal expected, got ${typeof v}`);
  return String(v);
}

// ---------------------------------------------------------------------------
// Violation log + main
// ---------------------------------------------------------------------------

/**
 * @param {Injection[]} injections
 * @param {number} dirtyRowCount
 * @param {number} columnCount
 */
function violationLog(injections, dirtyRowCount, columnCount) {
  return {
    $comment:
      'Ground truth for the seeded violations in hesp_dirty_100.*. Row indices are 0-based data-row ' +
      'positions (the future __row__), header excluded. expectedRuleIds mixes schema ruleIds ' +
      '(json-schema-subsystem §D.5 formats) with Q*/H* ids from tests/fixtures/hesp/rules/. ' +
      'P07-P14 refine these entries into full QCFlag manifests.',
    seed: SEED,
    rowIndexBase: 0,
    baseRows: BASE_ROWS,
    dirtyRows: dirtyRowCount,
    columns: columnCount,
    kinds: injections.map((i) => i.kind),
    injections,
  };
}

/**
 * Generates every fixture file into outDir.
 * @param {string} outDir
 */
export async function generateAll(outDir) {
  const set = loadSchemaSet(SCHEMA_DIR);
  const columns = deriveColumns(set);
  assert(columns.length === 265, `expected 265 columns, derived ${columns.length}`);
  const conditionals = deriveConditionals(set);
  assert(conditionals.length === 171, `expected 171 conditionals, derived ${conditionals.length}`);

  const validRows = generateValid(columns, conditionals);
  const { dirtyRows, injections } = injectViolations(validRows, columns, conditionals);

  const validHeader = columns.map((c) => c.name);
  const dirtyHeader = [...validHeader, EXTRA_COLUMN];

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'hesp_valid_100.csv'), serializeDelimited(validRows, validHeader, ','));
  writeFileSync(join(outDir, 'hesp_dirty_100.csv'), serializeDelimited(dirtyRows, dirtyHeader, ','));
  writeFileSync(join(outDir, 'hesp_dirty_100.tsv'), serializeDelimited(dirtyRows, dirtyHeader, '\t'));
  writeFileSync(join(outDir, 'hesp_dirty_100.json'), serializeJson(dirtyRows, dirtyHeader));
  writeFileSync(join(outDir, 'hesp_dirty_100.xlsx'), await buildXlsx(dirtyRows, dirtyHeader));
  await writeParquetStable(dirtyRows, dirtyHeader, columns, join(outDir, 'hesp_dirty_100.parquet'));
  writeFileSync(join(outDir, 'seeded-violations.json'), JSON.stringify(violationLog(injections, dirtyRows.length, dirtyHeader.length), null, 2) + '\n');

  return { columns, conditionals, validRows, dirtyRows, injections };
}

async function main() {
  const outFlag = process.argv.indexOf('--out');
  const outDir = outFlag !== -1 ? resolve(req(process.argv[outFlag + 1], '--out needs a path')) : DEFAULT_OUT;
  const { columns, conditionals, validRows, dirtyRows, injections } = await generateAll(outDir);
  if (outDir === DEFAULT_OUT) {
    const tinyDir = join(REPO_ROOT, 'tests', 'fixtures', 'tiny');
    mkdirSync(tinyDir, { recursive: true });
    writeFileSync(join(tinyDir, 'two_sheets.xlsx'), await buildTwoSheetsXlsx());
  }
  console.log(
    `fixtures: ${validRows.length} valid rows, ${dirtyRows.length} dirty rows, ` +
      `${columns.length} columns, ${conditionals.length} conditionals, ${injections.length} injections -> ${outDir}`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
