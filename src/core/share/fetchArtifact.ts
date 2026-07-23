/**
 * CORS-aware fetch wrapper for URL-loaded artifacts (url-params.md §3).
 * Minimal P05 cut: typed FETCH_HTTP/FETCH_CORS failures so the slot can show
 * real guidance; the full CORS host-table popover lands in P16.
 */
import { IngestError } from '../ingest/errors';

export interface FetchedArtifact {
  bytes: ArrayBuffer;
  /** Last path segment of the URL (fallback 'download'). */
  filename: string;
}

export async function fetchArtifact(url: string, signal?: AbortSignal): Promise<FetchedArtifact> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new IngestError('FETCH_HTTP', `That doesn't look like a valid URL: ${url}`, { cause });
  }

  let response: Response;
  try {
    response = await fetch(parsed.href, signal ? { signal } : {});
  } catch (cause) {
    // An opaque TypeError with no status is the browser's CORS signature.
    throw new IngestError('FETCH_CORS', `Couldn't fetch ${parsed.host}.`, {
      hint:
        'The server may not permit browser access (CORS). ' +
        'Download the file yourself and upload it here.',
      cause,
    });
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
