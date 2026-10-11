/**
 * DuckDB type text, as `DESCRIBE` prints it, read into a tree.
 *
 * A JSON or Parquet dataset keeps DuckDB's nested types — `BIGINT[]`,
 * `STRUCT(x DOUBLE, tier VARCHAR)`, `MAP(VARCHAR, BIGINT)`, `JSON` — and QuaC
 * has to tell them apart from scalars in several places: casting must leave
 * them alone, value reads must go through `to_json` (data-table's
 * `bridge.query` documents what Arrow loses inside a nested value: a DATE
 * arrives as epoch milliseconds, a HUGEINT or DECIMAL as a meaningless
 * number), and messages about a value inside one need to know whether a
 * position counts from 1 (a LIST, as SQL and the value inspector count) or
 * from 0 (an array inside a JSON value, as JSONPath counts).
 *
 * Stripping the parameters off the whole text is not enough: `DECIMAL(10,2)[]`
 * would read as `DECIMAL`, and `STRUCT("name" VARCHAR, age BIGINT)[]` — a
 * LIST — as `STRUCT`. Field names are kept as DuckDB wrote them, unquoted;
 * nothing here upper-cases a field name.
 *
 * Pure and dependency-free; never throws. Text the grammar does not cover is a
 * scalar of that name.
 */

export type DuckType =
  /** `T[]` */
  | { readonly kind: 'list'; readonly element: DuckType }
  /** `T[N]`, a fixed-size ARRAY */
  | { readonly kind: 'array'; readonly element: DuckType; readonly size: number }
  | { readonly kind: 'struct'; readonly fields: readonly (readonly [string, DuckType])[] }
  | { readonly kind: 'map'; readonly key: DuckType; readonly value: DuckType }
  | { readonly kind: 'union'; readonly members: readonly (readonly [string, DuckType])[] }
  | { readonly kind: 'json' }
  | { readonly kind: 'variant' }
  /** Everything else, by its base name: `BIGINT`, `DECIMAL`, `TIMESTAMP WITH TIME ZONE`. */
  | { readonly kind: 'scalar'; readonly name: string };

class Cursor {
  pos = 0;
  constructor(readonly text: string) {}

  peek(): string {
    return this.text[this.pos] ?? '';
  }

  skipSpace(): void {
    while (this.pos < this.text.length && /\s/.test(this.peek())) this.pos += 1;
  }

  /** Consume `ch` (after spaces); false when it is not next. */
  eat(ch: string): boolean {
    this.skipSpace();
    if (this.peek() !== ch) return false;
    this.pos += 1;
    return true;
  }

  done(): boolean {
    return this.pos >= this.text.length;
  }
}

/** A base name: words up to `(`, `[`, `,`, `)` or the end — `TIMESTAMP WITH TIME ZONE`. */
function readName(c: Cursor): string {
  c.skipSpace();
  const start = c.pos;
  while (!c.done() && !'([,)]'.includes(c.peek())) c.pos += 1;
  return c.text.slice(start, c.pos).trim();
}

/** Skip one balanced `( … )`, minding quoted text (`ENUM('a)', 'b')`). */
function skipParens(c: Cursor): void {
  let depth = 0;
  let quote: string | null = null;
  while (!c.done()) {
    const ch = c.peek();
    c.pos += 1;
    if (quote !== null) {
      if (ch === quote) {
        if (c.peek() === quote) c.pos += 1; // doubled quote = escaped
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return;
    }
  }
}

/** A STRUCT field or UNION member name: `"q""k"` or a bare word. */
function readFieldName(c: Cursor): string {
  c.skipSpace();
  if (c.peek() === '"') {
    c.pos += 1;
    let name = '';
    while (!c.done()) {
      const ch = c.peek();
      c.pos += 1;
      if (ch === '"') {
        if (c.peek() === '"') {
          name += '"';
          c.pos += 1;
          continue;
        }
        return name;
      }
      name += ch;
    }
    return name;
  }
  const start = c.pos;
  while (!c.done() && !/\s/.test(c.peek())) c.pos += 1;
  return c.text.slice(start, c.pos);
}

function readFields(c: Cursor): [string, DuckType][] {
  const fields: [string, DuckType][] = [];
  if (!c.eat('(')) return fields;
  if (c.eat(')')) return fields;
  for (;;) {
    const name = readFieldName(c);
    fields.push([name, readType(c)]);
    if (c.eat(',')) continue;
    c.eat(')');
    return fields;
  }
}

function readBase(c: Cursor): DuckType {
  const name = readName(c);
  const upper = name.toUpperCase();
  c.skipSpace();
  const opens = c.peek() === '(';
  if (opens && upper === 'STRUCT') return { kind: 'struct', fields: readFields(c) };
  if (opens && upper === 'UNION') return { kind: 'union', members: readFields(c) };
  if (opens && upper === 'MAP') {
    c.eat('(');
    const key = readType(c);
    c.eat(',');
    const value = readType(c);
    c.eat(')');
    return { kind: 'map', key, value };
  }
  if (opens) skipParens(c); // DECIMAL(10,2), ENUM('a', 'b'), VARCHAR(10)
  if (upper === 'JSON') return { kind: 'json' };
  if (upper === 'VARIANT') return { kind: 'variant' };
  return { kind: 'scalar', name: upper };
}

function readType(c: Cursor): DuckType {
  let type = readBase(c);
  for (;;) {
    c.skipSpace();
    if (c.peek() !== '[') return type;
    c.pos += 1;
    const start = c.pos;
    while (!c.done() && c.peek() !== ']') c.pos += 1;
    const inside = c.text.slice(start, c.pos).trim();
    c.pos += 1; // ']'
    type = /^\d+$/.test(inside)
      ? { kind: 'array', element: type, size: Number(inside) }
      : { kind: 'list', element: type };
  }
}

const parsed = new Map<string, DuckType>();

/** Read DuckDB type text into a tree (memoized: a dataset repeats its types). */
export function parseDuckType(text: string): DuckType {
  let type = parsed.get(text);
  if (type === undefined) {
    type = readType(new Cursor(text));
    if (parsed.size > 2_000) parsed.clear();
    parsed.set(text, type);
  }
  return type;
}

/** LIST, ARRAY, STRUCT, MAP, UNION or VARIANT — a value with parts. */
export function isNestedDuckType(text: string): boolean {
  const kind = parseDuckType(text).kind;
  return kind !== 'scalar' && kind !== 'json';
}

/**
 * Whether a value of this type must be read as `to_json` text: every nested
 * type, and JSON itself (whose text IS its value — a JSON column holding `830`
 * and one holding `"830"` differ only there).
 */
export function readsAsJson(text: string): boolean {
  return parseDuckType(text).kind !== 'scalar';
}

/**
 * The outer type's name: `LIST`, `ARRAY`, `STRUCT`, `MAP`, `UNION`, `JSON`,
 * `VARIANT`, or a scalar's base name with its parameters stripped
 * (`DECIMAL(10,2)` → `DECIMAL`). What the casting ladder and the numeric
 * alignment of the preview compare against.
 */
export function duckTypeBase(text: string): string {
  const type = parseDuckType(text);
  return type.kind === 'scalar' ? type.name : type.kind.toUpperCase();
}

/** Integer types whose values can pass ±(2^53 − 1). */
const WIDE_INTEGERS = new Set(['BIGINT', 'UBIGINT', 'HUGEINT', 'UHUGEINT', 'INT8', 'LONG']);

/**
 * Whether a value of this type can hold an integer that a JavaScript number
 * cannot represent exactly: a 64- or 128-bit integer anywhere inside it, a
 * wide DECIMAL, or JSON (whose numbers have no declared width).
 */
export function mayHoldWideIntegers(type: DuckType): boolean {
  switch (type.kind) {
    case 'scalar':
      return WIDE_INTEGERS.has(type.name) || type.name === 'DECIMAL';
    case 'json':
    case 'variant':
      return true;
    case 'list':
    case 'array':
      return mayHoldWideIntegers(type.element);
    case 'map':
      return mayHoldWideIntegers(type.value);
    case 'struct':
      return type.fields.some(([, field]) => mayHoldWideIntegers(field));
    case 'union':
      return type.members.some(([, member]) => mayHoldWideIntegers(member));
  }
}
