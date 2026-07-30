/**
 * "Designed message" — the predicate the P22 error sweep is built on.
 *
 * The rule it encodes is one sentence: **the user always meets QuaC's sentence
 * first.** A DuckDB binder error, a QuickJS stack line or an Ajv keyword dump
 * may follow, but it may never open the message, and it may never be the whole
 * message. That is the difference between "QuaC told me what went wrong" and
 * "something leaked".
 *
 * Two policies, because four codes quote the engine BY DESIGN and existing
 * tests pin that they must:
 *
 *   `pure`    — no engine vocabulary anywhere. The default.
 *   `framed`  — QuaC's sentence, a colon, then the engine tail. Used by
 *               `sql-error`, `js-error`, `E_PARSE` and `E_META`, where the
 *               engine's own words are the only thing that says WHICH
 *               identifier / keyword / byte offset was wrong.
 *
 * Under `framed` the markers are scanned in the PREFIX only — everything up to
 * the first `: ` — so the tail stays free to be verbatim engine output while
 * the opening stays QuaC's.
 */

/**
 * Vocabulary that only an engine, a runtime or QuaC's own internals say.
 * Deliberately specific: `error` and `failed` are QuaC words too, so matching
 * on them would make the predicate useless.
 */
export const ENGINE_MARKERS: readonly RegExp[] = [
  // DuckDB's error classes, as they appear at the head of its messages.
  /\b(?:Binder|Catalog|Parser|Conversion|Constraint|Invalid Input|IO|Out of Memory|Serialization|Transaction|Dependency|Internal|Permission|Not implemented|Fatal)\s+Error\b/i,
  // DuckDB's SQL echo and its hint machinery.
  /\bLINE \d+:/,
  /\bDid you mean "/,
  // DuckDB / Parquet / Thrift plumbing.
  /\bNo magic bytes\b/i,
  /\bTProtocolException\b/,
  /\bread_(?:parquet|csv|json)\w*\s*\(/i,
  // QuaC's internal table and view names — engine-side identifiers a user has
  // never heard of and cannot act on.
  /\bquac_(?:raw|typed|work|display|ingest_tmp|studio_display)\b/,
  /\b__rowid__\b/,
  // JS runtime vocabulary (QuickJS inside the sandbox, and the host).
  /\b(?:SyntaxError|ReferenceError|TypeError|RangeError|InternalError)\b/,
  /\bat <anonymous>/,
  /\bevalCode\b/,
  // Ajv's machine-facing shapes.
  /\bkeyword:\s*'/,
  /\bschemaPath\b/,
  // Anything that is obviously a stack.
  /^\s+at\s+\S+\s+\(/m,
];

/** Every engine marker that fires in `text`, as the matched substrings. */
export function findEngineText(text: string): string[] {
  const hits: string[] = [];
  for (const marker of ENGINE_MARKERS) {
    const match = marker.exec(text);
    if (match !== null) hits.push(match[0]);
  }
  return hits;
}

export type MessagePolicy = 'pure' | 'framed';

/** Shortest thing that can still be a sentence rather than a token dump. */
const MIN_SENTENCE = 12;
/** Fewest words that can still be a sentence. */
const MIN_WORDS = 3;

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Everything wrong with `message` under `policy`, as human-readable lines.
 * Empty means the message is designed. Returning the problems rather than a
 * boolean is what makes a failure readable: the assertion prints them.
 */
export function designProblems(message: string, policy: MessagePolicy): string[] {
  const problems: string[] = [];
  const text = message.trim();

  if (text === '') return ['message is empty'];
  if (text.length < MIN_SENTENCE)
    problems.push(`too short to be a sentence: ${JSON.stringify(text)}`);
  // Deliberately NOT a capitalization check. Lint copy opens with the CSV
  // column it is about (`rule_id is required.`), which is the right sentence
  // for a per-field list and the wrong one for a toast; both are designed.
  if (wordCount(text) < MIN_WORDS) {
    problems.push(`fewer than ${String(MIN_WORDS)} words: ${JSON.stringify(text)}`);
  }

  // The scanned region: everything under `pure`, the opening clause under
  // `framed`. `: ` (with the space) is the separator — a bare colon appears
  // inside engine text and inside `rule_id:` style ids.
  let scanned = text;
  if (policy === 'framed') {
    const cut = text.indexOf(': ');
    if (cut < 0) {
      problems.push(
        'framed messages must be "QuaC sentence: engine tail" — no ": " separator found',
      );
    } else {
      scanned = text.slice(0, cut);
      if (scanned.length < MIN_SENTENCE) {
        problems.push(`the QuaC half is too short: ${JSON.stringify(scanned)}`);
      }
      if (wordCount(scanned) < MIN_WORDS) {
        problems.push(`the QuaC half is not a sentence: ${JSON.stringify(scanned)}`);
      }
      if (text.slice(cut + 2).trim() === '')
        problems.push('framed message has an empty engine tail');
    }
  }

  for (const hit of findEngineText(scanned)) {
    problems.push(
      policy === 'framed'
        ? `engine text before the colon: ${JSON.stringify(hit)}`
        : `engine text in a pure message: ${JSON.stringify(hit)}`,
    );
  }
  return problems;
}

/** True when `message` is a designed message under `policy`. */
export function isDesignedMessage(message: string, policy: MessagePolicy): boolean {
  return designProblems(message, policy).length === 0;
}
