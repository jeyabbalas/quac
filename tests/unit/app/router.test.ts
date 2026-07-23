// Runs in the Vitest node environment: importing the module here also proves
// that nothing in router.ts touches window/document at module top level.
import { describe, expect, it } from 'vitest';

import { DEFAULT_ROUTE, formatHash, parseHash, ROUTE_IDS } from '../../../src/app/router';

describe('parseHash', () => {
  it('defaults empty fragments to the load route', () => {
    expect(parseHash('')).toEqual({ route: 'load', query: '' });
    expect(parseHash('#')).toEqual({ route: 'load', query: '' });
    expect(parseHash('#/')).toEqual({ route: 'load', query: '' });
  });

  it('parses the three routes', () => {
    expect(parseHash('#/load').route).toBe('load');
    expect(parseHash('#/report').route).toBe('report');
    expect(parseHash('#/studio').route).toBe('studio');
  });

  it('falls back to load on unknown routes without dropping the query', () => {
    expect(parseHash('#/unknown?x=1')).toEqual({ route: 'load', query: 'x=1' });
  });

  it('keeps repeated keys and their order verbatim', () => {
    expect(parseHash('#/load?schema=a&schema=b').query).toBe('schema=a&schema=b');
    expect(parseHash('#/report?schema=b&schema=a').query).toBe('schema=b&schema=a');
  });

  it('splits route from query at the FIRST question mark', () => {
    expect(parseHash('#/load?a=1?b=2')).toEqual({ route: 'load', query: 'a=1?b=2' });
  });

  it('never decodes or re-encodes percent escapes', () => {
    const query = 'schema=https%3A%2F%2Fx%2Fa%20b.json&p=%25';
    expect(parseHash(`#/load?${query}`).query).toBe(query);
  });

  it('tolerates a missing leading slash and a trailing slash', () => {
    expect(parseHash('#load').route).toBe('load');
    expect(parseHash('#/report/').route).toBe('report');
  });

  it('is case-sensitive: unknown casing falls back to load', () => {
    expect(parseHash('#/Report').route).toBe('load');
  });

  it('parses a query-only fragment as the default route', () => {
    expect(parseHash('#?x=1')).toEqual({ route: 'load', query: 'x=1' });
  });
});

describe('formatHash', () => {
  it('formats a bare route and a route with a query', () => {
    expect(formatHash('report', '')).toBe('#/report');
    expect(formatHash('load', 'schema=a&schema=b')).toBe('#/load?schema=a&schema=b');
  });

  it('round-trips every route with awkward queries byte-for-byte', () => {
    const queries = ['', 'schema=a&schema=b', 'a=1?b=2', '%2F%3F%25', '&&', 'x='];
    for (const route of ROUTE_IDS) {
      for (const query of queries) {
        expect(parseHash(formatHash(route, query))).toEqual({ route, query });
      }
    }
  });
});

describe('navigation invariant', () => {
  it('carrying the parsed query into a new route preserves it byte-for-byte', () => {
    const fragments = [
      '#/load?schema=b&schema=a&x=%2F%25',
      '#/nope?keep=1',
      '#?x=1',
      '#/report?a=1?b=2',
      '#/studio?&&',
    ];
    for (const fragment of fragments) {
      const before = parseHash(fragment);
      const after = parseHash(formatHash('studio', before.query));
      expect(after.query).toBe(before.query);
    }
  });

  it('exposes load as the documented default route', () => {
    expect(DEFAULT_ROUTE).toBe('load');
  });
});
