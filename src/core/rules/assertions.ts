// Column-assertion DSL (qc-rules-format.md §4.1): grammar parser + the exact
// SQL expansion table. Grammar: `name` or `name(arg, …)`; args are numbers,
// 'single-quoted strings' ('' escape), key=value pairs, or positional bare
// identifiers — the §4.1 grammar summary omits the last form, but the monotonic
// signature (`monotonic(increasing, …)`) requires it. Case-insensitive,
// whitespace-tolerant, ONE assertion per rule.
import { quoteIdentifier } from '@jeyabbalas/data-table';

export type AssertionName =
  | 'unique'
  | 'no_nulls'
  | 'not_blank'
  | 'in_range'
  | 'in_enum'
  | 'match_regex'
  | 'monotonic'
  | 'count_distinct_in_range';

const ASSERTION_NAMES: readonly string[] = [
  'unique',
  'no_nulls',
  'not_blank',
  'in_range',
  'in_enum',
  'match_regex',
  'monotonic',
  'count_distinct_in_range',
];

export interface AssertionArg {
  kind: 'number' | 'string' | 'identifier';
  /** Parsed value: numbers as JS number, strings unescaped, identifiers verbatim. */
  value: string | number;
  /** Original token text — re-emitted verbatim into SQL (already SQL-literal grammar). */
  raw: string;
}

export interface ParsedAssertion {
  name: AssertionName;
  positional: AssertionArg[];
  named: Record<string, AssertionArg>; // keys lowercased
}

export type AssertionParseResult =
  { ok: true; assertion: ParsedAssertion } | { ok: false; error: string };

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Split an arg list on top-level commas ('' string escapes respected). */
function splitArgs(body: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= body.length) return null; // unterminated string
        if (body.charAt(j) === "'") {
          if (body.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      current += body.slice(i, j);
      i = j;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }
  parts.push(current);
  return parts;
}

function parseValueToken(token: string): AssertionArg | null {
  if (NUMBER_RE.test(token)) return { kind: 'number', value: Number(token), raw: token };
  if (token.startsWith("'")) {
    if (token.length < 2 || !token.endsWith("'")) return null;
    const inner = token.slice(1, -1);
    // Reject strings whose interior quotes are not doubled (e.g. 'a'b').
    if (/(?:^|[^'])'(?:[^']|$)/.test(inner)) return null;
    return { kind: 'string', value: inner.replace(/''/g, "'"), raw: token };
  }
  if (IDENT_RE.test(token)) return { kind: 'identifier', value: token, raw: token };
  return null;
}

export function parseAssertion(text: string): AssertionParseResult {
  const fail = (error: string): AssertionParseResult => ({ ok: false, error });
  const trimmed = text.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?$/s.exec(trimmed);
  if (!m) {
    return fail(
      'not an assertion — expected `name` or `name(arg, …)` (column-scope conditions use the assertion vocabulary, not SQL)',
    );
  }
  const name = (m[1] ?? '').toLowerCase();
  if (!ASSERTION_NAMES.includes(name)) {
    return fail(`unknown assertion "${name}" — known: ${ASSERTION_NAMES.join(', ')}`);
  }
  const assertion: ParsedAssertion = {
    name: name as AssertionName,
    positional: [],
    named: {},
  };

  const body = m[2];
  if (body !== undefined) {
    if (body.trim() !== '') {
      const parts = splitArgs(body);
      if (parts === null) return fail('unterminated string in argument list');
      for (const part of parts) {
        const token = part.trim();
        if (token === '') return fail('empty argument');
        const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s.exec(token);
        if (kv) {
          const key = (kv[1] ?? '').toLowerCase();
          const value = parseValueToken((kv[2] ?? '').trim());
          if (!value) return fail(`malformed value for ${key}=`);
          if (key in assertion.named) return fail(`duplicate argument ${key}=`);
          assertion.named[key] = value;
        } else {
          if (Object.keys(assertion.named).length > 0) {
            return fail('positional argument after key=value argument');
          }
          const value = parseValueToken(token);
          if (!value) return fail(`malformed argument "${token}"`);
          assertion.positional.push(value);
        }
      }
    }
  }
  const validationError = validate(assertion);
  return validationError === null ? { ok: true, assertion } : fail(validationError);
}

const MONOTONIC_DIRS = ['increasing', 'strict_increasing', 'decreasing', 'strict_decreasing'];

/** Per-assertion arity/type table; returns an error message or null. */
function validate(a: ParsedAssertion): string | null {
  const { name, positional, named } = a;
  const namedKeys = Object.keys(named);
  const noNamed = (): string | null =>
    namedKeys.length > 0 ? `${name} takes no key=value arguments` : null;
  switch (name) {
    case 'unique':
    case 'no_nulls':
    case 'not_blank':
      if (positional.length > 0) return `${name} takes no arguments`;
      return noNamed();
    case 'in_range':
    case 'count_distinct_in_range': {
      if (positional.length !== 2) return `${name}(lo, hi) needs exactly 2 arguments`;
      const wantNumber = name === 'count_distinct_in_range';
      for (const arg of positional) {
        if (arg.kind === 'identifier') return `${name} arguments must be literals`;
        if (wantNumber && arg.kind !== 'number') return `${name} arguments must be numbers`;
      }
      return noNamed();
    }
    case 'in_enum':
      if (positional.length === 0) return 'in_enum(v1, …) needs at least 1 value';
      if (positional.some((arg) => arg.kind === 'identifier')) {
        return 'in_enum values must be numbers or quoted strings';
      }
      return noNamed();
    case 'match_regex':
      if (positional.length !== 1 || positional[0]?.kind !== 'string') {
        return "match_regex('re') needs exactly 1 quoted-string argument";
      }
      return noNamed();
    case 'monotonic': {
      const dir = positional[0];
      if (positional.length !== 1 || dir?.kind !== 'identifier') {
        return 'monotonic(dir, …) needs exactly 1 direction argument';
      }
      if (!MONOTONIC_DIRS.includes(String(dir.value).toLowerCase())) {
        return `monotonic direction must be one of ${MONOTONIC_DIRS.join(' | ')}`;
      }
      for (const key of namedKeys) {
        if (key !== 'order_by' && key !== 'partition_by') {
          return `monotonic does not take ${key}=`;
        }
        if (named[key]?.kind === 'number') return `${key}= must name a column`;
      }
      return null;
    }
  }
}

export type AssertionExpansion =
  | { kind: 'row-condition'; sql: string }
  | { kind: 'column-aggregate'; countSql: string; lo: number; hi: number };

/**
 * §4.1 expansion table — violation-condition SQL per target ({c} applied to each
 * target), except count_distinct_in_range which is a whole-column aggregate with
 * host-side inclusive-bounds comparison (violation iff n < lo OR n > hi).
 */
export function expandAssertion(a: ParsedAssertion, target: string): AssertionExpansion {
  const c = quoteIdentifier(target);
  switch (a.name) {
    case 'unique':
      return {
        kind: 'row-condition',
        sql: `(${c} IS NOT NULL AND COUNT(*) OVER (PARTITION BY ${c}) > 1)`,
      };
    case 'no_nulls':
      return { kind: 'row-condition', sql: `(${c} IS NULL)` };
    case 'not_blank':
      return { kind: 'row-condition', sql: `(${c} IS NULL OR TRIM(CAST(${c} AS VARCHAR)) = '')` };
    case 'in_range': {
      const [lo, hi] = a.positional;
      return {
        kind: 'row-condition',
        sql: `(${c} IS NOT NULL AND (${c} < ${lo?.raw ?? ''} OR ${c} > ${hi?.raw ?? ''}))`,
      };
    }
    case 'in_enum': {
      const vals = a.positional.map((v) => v.raw).join(', ');
      return { kind: 'row-condition', sql: `(${c} IS NOT NULL AND ${c} NOT IN (${vals}))` };
    }
    case 'match_regex': {
      const re = a.positional[0]?.raw ?? "''";
      return {
        kind: 'row-condition',
        sql: `(${c} IS NOT NULL AND NOT regexp_full_match(CAST(${c} AS VARCHAR), ${re}))`,
      };
    }
    case 'monotonic': {
      const dir = String(a.positional[0]?.value ?? '').toLowerCase();
      const cmp =
        dir === 'increasing'
          ? '<'
          : dir === 'strict_increasing'
            ? '<='
            : dir === 'decreasing'
              ? '>'
              : '>=';
      const orderBy = a.named.order_by;
      const partitionBy = a.named.partition_by;
      const o = quoteIdentifier(orderBy ? String(orderBy.value) : '__row__');
      const over = partitionBy
        ? `PARTITION BY ${quoteIdentifier(String(partitionBy.value))} ORDER BY ${o}`
        : `ORDER BY ${o}`;
      return {
        kind: 'row-condition',
        sql: `(${c} IS NOT NULL AND LAG(${c}) OVER (${over}) IS NOT NULL AND ${c} ${cmp} LAG(${c}) OVER (${over}))`,
      };
    }
    case 'count_distinct_in_range': {
      const [lo, hi] = a.positional;
      return {
        kind: 'column-aggregate',
        countSql: `SELECT COUNT(DISTINCT ${c}) FROM data`,
        lo: Number(lo?.value ?? Number.NaN),
        hi: Number(hi?.value ?? Number.NaN),
      };
    }
  }
}
