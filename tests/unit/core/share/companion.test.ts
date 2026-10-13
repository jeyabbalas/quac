import { describe, expect, test } from 'vitest';
import {
  COMPANION_MAX_CHARS,
  COMPANION_MAX_FILES,
  COMPANION_PROTOCOL,
  COMPANION_VERSION,
  companionOrigin,
  findingsMessage,
  helloMessage,
  parseCompanionRequest,
  statusMessage,
} from '../../../../src/core/share/companion';
import type { QcFindings } from '../../../../src/core/report/findings';

const env = { protocol: COMPANION_PROTOCOL, version: COMPANION_VERSION };
const file = (path: string, text = '{"type":"object"}') => ({ path, text });
const schemas = (over: Record<string, unknown> = {}) => ({
  ...env,
  kind: 'schemas',
  id: 'r1',
  files: [file('study/study.schema.json'), file('common/defs.json')],
  ...over,
});

describe('companionOrigin', () => {
  test.each([
    ['http://127.0.0.1:8705', 'http://127.0.0.1:8705'],
    ['http://127.0.0.1:8705/', 'http://127.0.0.1:8705'],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://[::1]:8000', 'http://[::1]:8000'],
    ['https://schemify.localhost', 'https://schemify.localhost'],
  ])('accepts the loopback origin %s', (raw, origin) => {
    expect(companionOrigin(raw)).toBe(origin);
  });

  test.each([
    ['another machine', 'https://example.org'],
    ['a look-alike host', 'http://localhost.example.org:8705'],
    ['a dotted look-alike', 'http://127.0.0.1.example.org'],
    ['a path', 'http://127.0.0.1:8705/site/'],
    ['a query', 'http://127.0.0.1:8705?x=1'],
    ['credentials', 'http://user:pw@127.0.0.1:8705'],
    ['another scheme', 'file:///Users/me/schemify/index.html'],
    ['script', 'javascript:alert(1)'],
    ['garbage', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_why, raw) => {
    expect(companionOrigin(raw)).toBeNull();
  });

  test('refuses a missing value', () => {
    expect(companionOrigin(null)).toBeNull();
    expect(companionOrigin(undefined)).toBeNull();
  });
});

describe('parseCompanionRequest', () => {
  test('reads a schemas request, with its root', () => {
    expect(parseCompanionRequest(schemas({ index: 'study/study.schema.json' }))).toEqual({
      kind: 'schemas',
      id: 'r1',
      files: [file('study/study.schema.json'), file('common/defs.json')],
      index: 'study/study.schema.json',
    });
  });

  test('reads ping and close', () => {
    expect(parseCompanionRequest({ ...env, kind: 'ping' })).toEqual({ kind: 'ping' });
    expect(parseCompanionRequest({ ...env, kind: 'close' })).toEqual({ kind: 'close' });
  });

  test.each([
    ['another protocol', { ...schemas(), protocol: 'other' }],
    ['another version', { ...schemas(), version: 2 }],
    ['an unknown kind', { ...env, kind: 'run' }],
    ['no id', schemas({ id: '' })],
    ['no files', schemas({ files: [] })],
    ['a file that is not text', schemas({ files: [{ path: 'a.json', text: 1 }] })],
    ['a path outside the folder', schemas({ files: [file('../secret.json')] })],
    ['an absolute path', schemas({ files: [file('/etc/x.json')] })],
    ['a backslash', schemas({ files: [file('a\\b.json')] })],
    ['an empty segment', schemas({ files: [file('a//b.json')] })],
    ['a file that is not JSON', schemas({ files: [file('data.csv')] })],
    ['a path sent twice', schemas({ files: [file('a.json'), file('a.json')] })],
    ['a root not among the files', schemas({ index: 'elsewhere.json' })],
    ['a string', 'schemas'],
    ['null', null],
  ])('ignores %s', (_why, data) => {
    expect(parseCompanionRequest(data)).toBeNull();
  });

  test('ignores a set too large to be schemas', () => {
    const many = Array.from({ length: COMPANION_MAX_FILES + 1 }, (_, i) =>
      file(`f${String(i)}.json`),
    );
    expect(parseCompanionRequest(schemas({ files: many }))).toBeNull();
    const big = 'x'.repeat(COMPANION_MAX_CHARS / 2 + 1);
    expect(
      parseCompanionRequest(schemas({ files: [file('a.json', big), file('b.json', big)] })),
    ).toBeNull();
  });
});

describe('messages', () => {
  test('carry the protocol marker', () => {
    expect(helloMessage('1.3.0', true)).toEqual({
      ...env,
      kind: 'hello',
      quacVersion: '1.3.0',
      datasetLoaded: true,
    });
    expect(statusMessage('r1', 'needs-dataset')).toEqual({
      ...env,
      kind: 'status',
      id: 'r1',
      status: 'needs-dataset',
    });
    expect(statusMessage(null, 'failed', 'why')).toEqual({
      ...env,
      kind: 'status',
      id: null,
      status: 'failed',
      detail: 'why',
    });
  });

  test('findings go out only when they declare no data', () => {
    const findings = { containsData: false, findingsSchemaVersion: 1 } as unknown as QcFindings;
    expect(findingsMessage('r1', findings)).toEqual({
      ...env,
      kind: 'findings',
      id: 'r1',
      findings,
    });
    const leaky = { containsData: true } as unknown as QcFindings;
    expect(() => findingsMessage('r1', leaky)).toThrow(/containsData/);
    expect(() => findingsMessage('r1', {} as QcFindings)).toThrow(/containsData/);
  });
});
