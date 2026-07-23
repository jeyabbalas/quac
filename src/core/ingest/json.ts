/**
 * JSON dataset intake: a cheap streamed prefix check before handing the whole
 * payload to the engine loader (typed values are kept — the all-varchar rule
 * applies only to delimited text, ingestion.md §2).
 */
import { IngestError } from './errors';

/**
 * Assert the payload looks like a top-level array of objects by decoding
 * only the first few KB. Throws INGEST_UNSUPPORTED otherwise.
 */
export function checkJsonArrayPrefix(bytes: Uint8Array): void {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096));
  const trimmed = head.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed.startsWith('[')) {
    throw new IngestError(
      'INGEST_UNSUPPORTED',
      'This JSON file is not a top-level array — QuaC expects an array of row objects.',
      { hint: 'Expected shape: [{"col": "value", …}, …]' },
    );
  }
  const afterBracket = trimmed.slice(1).trimStart();
  if (afterBracket !== '' && afterBracket !== ']' && !afterBracket.startsWith('{')) {
    throw new IngestError(
      'INGEST_UNSUPPORTED',
      'This JSON array does not contain row objects.',
      { hint: 'Expected shape: [{"col": "value", …}, …]' },
    );
  }
}
