/**
 * CORS-aware fetch wrapper for URL-loaded artifacts (url-params.md §3).
 * Typed failures so slots can show real guidance:
 *   - HTTP error (status available)  → FETCH_HTTP ("Server responded 404 …").
 *   - Opaque TypeError (no status)   → FETCH_CORS (the browser's CORS signature).
 *   - Timeout / abort                → FETCH_HTTP with a timeout message.
 * Never silently hangs: an internal timeout aborts the request; every failure
 * leaves the slot's drop zone active as the fallback. `retries` is a hook for
 * callers (default 0) — it re-attempts only the CORS-shaped opaque failure.
 */
import { IngestError } from '../ingest/errors';

export interface FetchedArtifact {
  bytes: ArrayBuffer;
  /** Last path segment of the URL (fallback 'download'). */
  filename: string;
}

export interface FetchArtifactOptions {
  /** Caller cancellation — combined with the internal timeout. */
  signal?: AbortSignal;
  /** Internal timeout before the request is aborted (default 30 s). */
  timeoutMs?: number;
  /** Extra attempts on a CORS-shaped failure (default 0 — off). */
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const CORS_HINT =
  'The server may not permit browser access (CORS). ' +
  'Download the file yourself and upload it here.';

export async function fetchArtifact(
  url: string,
  options: FetchArtifactOptions = {},
): Promise<FetchedArtifact> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new IngestError('FETCH_HTTP', `That doesn't look like a valid URL: ${url}`, { cause });
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchOnce(parsed, options.signal, timeoutMs);
    } catch (err) {
      const retriable = err instanceof IngestError && err.code === 'FETCH_CORS';
      if (retriable && attempt < retries) continue;
      throw err;
    }
  }
}

async function fetchOnce(
  parsed: URL,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<FetchedArtifact> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(parsed.href, { signal: controller.signal });
  } catch (cause) {
    // Timer-fired abort (not a caller cancel) is a timeout, not CORS.
    if (controller.signal.aborted && !(callerSignal?.aborted ?? false)) {
      throw new IngestError(
        'FETCH_HTTP',
        `Timed out fetching ${parsed.host} after ${String(Math.round(timeoutMs / 1000))}s.`,
        { cause },
      );
    }
    // An opaque TypeError with no status is the browser's CORS signature.
    throw new IngestError('FETCH_CORS', `Couldn't fetch ${parsed.host}.`, { hint: CORS_HINT, cause });
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    throw new IngestError(
      'FETCH_HTTP',
      `Server responded ${String(response.status)} for ${parsed.href}`,
    );
  }

  const bytes = await response.arrayBuffer();
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  const filename = decodeURIComponent(segments[segments.length - 1] ?? '') || 'download';
  return { bytes, filename };
}
