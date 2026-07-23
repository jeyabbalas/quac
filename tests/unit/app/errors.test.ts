// Node-environment test: importing errors.ts (which imports toast.ts) also
// proves neither module touches the DOM at import time. reportError itself is
// DOM-side (toast) and is covered by e2e/manual checks, not unit tests.
import { describe, expect, it } from 'vitest';

import { QUAC_ERROR_CODES, QuacError, toQuacError } from '../../../src/app/errors';

describe('QuacError', () => {
  it('carries code, userMessage, hint, and cause', () => {
    const cause = new Error('root cause');
    const err = new QuacError('FETCH_CORS', 'Could not fetch the file.', {
      hint: 'Download it yourself and upload it here.',
      cause,
    });
    expect(err.code).toBe('FETCH_CORS');
    expect(err.userMessage).toBe('Could not fetch the file.');
    expect(err.message).toBe(err.userMessage);
    expect(err.hint).toBe('Download it yourself and upload it here.');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('QuacError');
    expect(err).toBeInstanceOf(QuacError);
    expect(err).toBeInstanceOf(Error);
  });

  it('leaves hint undefined when not provided', () => {
    const err = new QuacError('EXPORT_FAILED', 'Export failed.');
    expect(err.hint).toBeUndefined();
  });

  it('pins the closed code set exactly', () => {
    expect(QUAC_ERROR_CODES).toEqual([
      'INGEST_UNSUPPORTED',
      'INGEST_TOO_LARGE',
      'FETCH_CORS',
      'FETCH_HTTP',
      'SCHEMA_INVALID',
      'SCHEMA_AMBIGUOUS_ROOT',
      'RULES_PARSE',
      'RULE_SQL_ERROR',
      'RULE_JS_ERROR',
      'PIPELINE_CANCELLED',
      'EXPORT_FAILED',
      'BRIDGE_FAILED',
    ]);
  });
});

describe('toQuacError', () => {
  it('returns an existing QuacError unchanged (same reference, code kept)', () => {
    const original = new QuacError('RULES_PARSE', 'Bad rules file.');
    expect(toQuacError(original, 'BRIDGE_FAILED')).toBe(original);
  });

  it('wraps an Error with the fallback code and preserves it as cause', () => {
    const boom = new Error('boom');
    const err = toQuacError(boom, 'FETCH_HTTP');
    expect(err.code).toBe('FETCH_HTTP');
    expect(err.userMessage).toBe('boom');
    expect(err.cause).toBe(boom);
  });

  it('uses a non-empty string as the message', () => {
    const err = toQuacError('plain failure text', 'RULES_PARSE');
    expect(err.code).toBe('RULES_PARSE');
    expect(err.userMessage).toBe('plain failure text');
  });

  it('falls back to a generic message for empty strings and non-errors', () => {
    expect(toQuacError('', 'BRIDGE_FAILED').userMessage).toBe('Unexpected error');
    expect(toQuacError(undefined, 'BRIDGE_FAILED').userMessage).toBe('Unexpected error');
    const weird = { weird: true };
    const err = toQuacError(weird, 'BRIDGE_FAILED');
    expect(err.userMessage).toBe('Unexpected error');
    expect(err.cause).toBe(weird);
  });
});
