import { afterEach, expect, test, vi } from 'vitest';
import { fetchArtifact } from '../../../../src/core/share/fetchArtifact';
import { IngestError } from '../../../../src/core/ingest/errors';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectIngestError(promise: Promise<unknown>): Promise<IngestError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IngestError);
    return err as IngestError;
  }
  return expect.unreachable('should have thrown');
}

test('success returns bytes and the URL filename', async () => {
  const payload = new TextEncoder().encode('a,b\n1,2\n');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(payload, { status: 200 })),
  );
  const { bytes, filename } = await fetchArtifact('https://example.com/data/my%20file.csv?x=1');
  expect(new Uint8Array(bytes)).toEqual(payload);
  expect(filename).toBe('my file.csv');
});

test('pathless URL falls back to "download"', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 200 })));
  const { filename } = await fetchArtifact('https://example.com');
  expect(filename).toBe('download');
});

test('HTTP error becomes FETCH_HTTP with the status in the message', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
  const err = await expectIngestError(fetchArtifact('https://example.com/gone.csv'));
  expect(err.code).toBe('FETCH_HTTP');
  expect(err.message).toContain('404');
});

test('opaque TypeError becomes FETCH_CORS with the upload hint', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  const err = await expectIngestError(fetchArtifact('https://blocked.example.com/data.csv'));
  expect(err.code).toBe('FETCH_CORS');
  expect(err.hint).toMatch(/CORS/);
});

test('invalid URL is a FETCH_HTTP failure, not a crash', async () => {
  const err = await expectIngestError(fetchArtifact('not a url'));
  expect(err.code).toBe('FETCH_HTTP');
});
