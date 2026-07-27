import { describe, expect, it } from 'vitest';
import { parseMessage } from '../../../src/core/schema/messages';

/** The engine message V8 actually produces for a given text. */
function engineMessageFor(text: string): string {
  try {
    JSON.parse(text);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(text)} to fail JSON.parse`);
}

describe('parseMessage (E_PARSE, §A.5)', () => {
  it('drops V8’s self-referential tail instead of stuttering (UX-10)', () => {
    // Current V8: no position, and it closes with this template's own clause.
    const message = parseMessage(
      'http://localhost:4199/synthetic/mixed/notes.txt',
      'Unexpected token \'T\', "This file "... is not valid JSON',
    );
    expect(message).toBe(
      "`http://localhost:4199/synthetic/mixed/notes.txt` is not valid JSON: Unexpected token 'T'.",
    );
    expect(message.match(/is not valid JSON/g)).toHaveLength(1);
  });

  it('says it once for whatever the live engine emits on a non-JSON file', () => {
    // Pinned to the engine rather than to a snapshot of it: the V8 wording has
    // already changed once (the `at position n` form), which is how UX-10 got in.
    const message = parseMessage('notes.txt', engineMessageFor('This file is not JSON.\n'));
    expect(message.match(/is not valid JSON/g)).toHaveLength(1);
    expect(message).toMatch(/^`notes\.txt` is not valid JSON: .+\.$/);
    expect(message).not.toMatch(/,/);
  });

  it('keeps "(near position n)" for both positional forms', () => {
    expect(parseMessage('a.json', 'Unexpected token T in JSON at position 0')).toBe(
      '`a.json` is not valid JSON: Unexpected token T (near position 0).',
    );
    expect(
      parseMessage(
        'a.json',
        "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
      ),
    ).toBe("`a.json` is not valid JSON: Expected property name or '}' (near position 1).");
  });

  it('passes a message with neither a position nor the tail through unchanged', () => {
    expect(parseMessage('empty.json', 'Unexpected end of JSON input')).toBe(
      '`empty.json` is not valid JSON: Unexpected end of JSON input.',
    );
    expect(parseMessage('empty.json', engineMessageFor(''))).toBe(
      '`empty.json` is not valid JSON: Unexpected end of JSON input.',
    );
  });

  it('never truncates at a comma that is not the tail’s (fails closed)', () => {
    expect(parseMessage('a.json', 'Something odd, then more detail')).toBe(
      '`a.json` is not valid JSON: Something odd, then more detail.',
    );
  });
});
