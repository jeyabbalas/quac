/**
 * QuacError — the closed error-code set (architecture.md §7) plus the one
 * reporting path every async UI action funnels through: toast (transient)
 * and, when a slot is given, slot state (persistent). Error copy is always
 * plain and serious — never jokes.
 */
import { showToast } from './toast';
import type { Signal } from './signals';
import type { SlotState } from './store';

export const QUAC_ERROR_CODES = [
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
] as const;
export type QuacErrorCode = (typeof QUAC_ERROR_CODES)[number];

export class QuacError extends Error {
  readonly code: QuacErrorCode;
  /** User-facing sentence; identical to `message`. */
  readonly userMessage: string;
  readonly hint?: string;

  constructor(
    code: QuacErrorCode,
    userMessage: string,
    options?: { hint?: string; cause?: unknown },
  ) {
    super(userMessage, { cause: options?.cause });
    this.name = 'QuacError';
    this.code = code;
    this.userMessage = userMessage;
    if (options?.hint !== undefined) this.hint = options.hint;
  }
}

/** Coerce any thrown value into a QuacError without losing the original. */
export function toQuacError(err: unknown, fallbackCode: QuacErrorCode): QuacError {
  if (err instanceof QuacError) return err;
  if (err instanceof Error) {
    // Core-side errors (e.g. core/ingest IngestError) can't import this
    // module; they carry a structural { code, hint? } instead — preserve it.
    const { code, hint } = err as { code?: unknown; hint?: unknown };
    if (typeof code === 'string' && (QUAC_ERROR_CODES as readonly string[]).includes(code)) {
      return new QuacError(code as QuacErrorCode, err.message, {
        cause: err,
        ...(typeof hint === 'string' ? { hint } : {}),
      });
    }
    return new QuacError(fallbackCode, err.message, { cause: err });
  }
  if (typeof err === 'string' && err !== '') return new QuacError(fallbackCode, err);
  return new QuacError(fallbackCode, 'Unexpected error', { cause: err });
}

export interface ReportErrorOptions {
  fallbackCode: QuacErrorCode;
  /** When the failure belongs to an input slot, park it there persistently. */
  slot?: Signal<SlotState>;
}

export function reportError(err: unknown, options: ReportErrorOptions): QuacError {
  const quacError = toQuacError(err, options.fallbackCode);
  showToast(quacError.userMessage, { kind: 'error', hint: quacError.hint });
  options.slot?.set({ status: 'error', detail: quacError.userMessage });
  return quacError;
}
