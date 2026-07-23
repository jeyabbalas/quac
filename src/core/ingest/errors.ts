/**
 * Core-side typed errors. src/core must not import src/app (architecture.md
 * §2), so this mirrors the QuacError shape structurally: app/errors.ts
 * toQuacError() recognizes the `code` property and preserves it.
 */

/** Subset of QUAC_ERROR_CODES a core ingest/fetch path can raise. */
export type IngestErrorCode =
  | 'INGEST_UNSUPPORTED'
  | 'INGEST_TOO_LARGE'
  | 'FETCH_CORS'
  | 'FETCH_HTTP';

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  readonly hint?: string;

  constructor(code: IngestErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'IngestError';
    this.code = code;
    if (options?.hint !== undefined) this.hint = options.hint;
  }
}
