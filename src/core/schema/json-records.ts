/**
 * The records of a JSON dataset, exactly as the file wrote them.
 *
 * A JSON dataset is validated against its own records, not against DuckDB's
 * reading of them. DuckDB is a fine table engine and a lossy JSON reader for
 * this purpose: `read_json` turns ISO date, time and UUID strings into DATE,
 * TIMESTAMP and UUID values (dropping a `Z`, applying an offset, swapping the
 * `T` for a space, lower-casing a UUID), and it reads a missing key and an
 * explicit `null` as the same NULL — at the top level and inside a struct.
 * JSON Schema tells all of these apart, so the validator reads the record's
 * own text instead: the table DuckDB built still serves the grid, the rules
 * and the report, and its row order (`__row__`, the file's order) is the
 * order of the array elements here.
 *
 * The split is a single pass over the text that tracks strings and bracket
 * depth; it does not re-validate the JSON (the engine load already parsed the
 * file, or the dataset would not be loaded).
 */

const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

const isSpace = (code: number): boolean => code === SPACE || code === TAB || code === LF || code === CR;

/** Index just past the string whose opening quote is at `start`. */
function endOfString(text: string, start: number): number {
  let from = start + 1;
  for (;;) {
    const quote = text.indexOf('"', from);
    if (quote === -1) throw new SyntaxError(`unterminated string at offset ${String(start)}`);
    let backslashes = 0;
    for (let k = quote - 1; text.charCodeAt(k) === BACKSLASH; k -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}

/**
 * The exact text of every element of the top-level JSON array in `text`, in
 * order. A leading byte-order mark and surrounding whitespace are allowed;
 * anything that is not one array throws a `SyntaxError`.
 */
export function jsonArrayElements(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipSpace = (): void => {
    while (i < n && isSpace(text.charCodeAt(i))) i += 1;
  };
  const fail = (what: string): never => {
    throw new SyntaxError(`${what} at offset ${String(i)}`);
  };

  skipSpace();
  if (text.charCodeAt(i) !== OPEN_BRACKET) fail('expected [');
  i += 1;
  skipSpace();
  if (text.charCodeAt(i) === CLOSE_BRACKET) {
    i += 1;
    skipSpace();
    if (i !== n) fail('unexpected text after the array');
    return out;
  }
  for (;;) {
    skipSpace();
    const start = i;
    const code = text.charCodeAt(i);
    if (code === QUOTE) {
      i = endOfString(text, i);
    } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      let depth = 0;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === QUOTE) {
          i = endOfString(text, i);
          continue;
        }
        if (c === OPEN_BRACE || c === OPEN_BRACKET) depth += 1;
        else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        i += 1;
      }
      if (depth !== 0) fail('unterminated value');
    } else {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === COMMA || c === CLOSE_BRACKET || isSpace(c)) break;
        i += 1;
      }
      if (i === start) fail('expected a value');
    }
    out.push(text.slice(start, i));
    skipSpace();
    const next = text.charCodeAt(i);
    if (next === COMMA) {
      i += 1;
      continue;
    }
    if (next === CLOSE_BRACKET) {
      i += 1;
      break;
    }
    fail('expected , or ]');
  }
  skipSpace();
  if (i !== n) fail('unexpected text after the array');
  return out;
}

/** The dataset's bytes as text, decoded the way the engine load decoded them. */
export function decodeJsonText(bytes: ArrayBuffer | Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
