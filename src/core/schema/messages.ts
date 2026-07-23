/**
 * User-facing copy for every schema-load finding — exact templates from
 * json-schema-subsystem.md §A.5. Pure string builders; unit tests assert
 * these verbatim and the e2e specs match stable prefixes. Errors are always
 * plain and serious — never jokes.
 */
import type { SchemaDraft, SchemaLoadCode, SchemaLoadError } from './types';
import { SCHEMA_LOAD_SEVERITY } from './types';

/** Build a SchemaLoadError with the severity the code implies. */
export function loadError(
  code: SchemaLoadCode,
  message: string,
  extras?: { fileId?: string; meta?: Record<string, unknown> },
): SchemaLoadError {
  const error: SchemaLoadError = { code, severity: SCHEMA_LOAD_SEVERITY[code], message };
  if (extras?.fileId !== undefined) error.fileId = extras.fileId;
  if (extras?.meta !== undefined) error.meta = extras.meta;
  return error;
}

/**
 * `E_PARSE` — "(near position {n})" only when the engine message names one
 * (V8 formats vary; the position tail is stripped from the reason).
 */
export function parseMessage(path: string, engineMessage: string): string {
  const positionMatch = /\s*(?:in JSON)?\s*at position (\d+).*$/.exec(engineMessage);
  if (positionMatch) {
    const reason = engineMessage.slice(0, positionMatch.index).trim().replace(/[.:]$/, '');
    return `\`${path}\` is not valid JSON: ${reason} (near position ${positionMatch[1] ?? ''}).`;
  }
  return `\`${path}\` is not valid JSON: ${engineMessage.trim().replace(/\.$/, '')}.`;
}

export function dupIdMessage(id: string, a: string, b: string): string {
  return `Two files declare the same \`$id\` \`${id}\`: \`${a}\` and \`${b}\`. Each schema file needs a unique \`$id\`.`;
}

export function unresolvedRefMessage(
  path: string,
  ref: string,
  pointer: string,
  expectedName: string,
): string {
  return `\`${path}\` references \`${ref}\` (at ${pointer}), but no loaded file matches. Upload the folder containing \`${expectedName}\`, or check the reference.`;
}

export function badFragmentMessage(
  path: string,
  ref: string,
  fragment: string,
  target: string,
): string {
  return `\`${path}\` references \`${ref}\`, but \`${fragment}\` does not exist in \`${target}\`.`;
}

export function noSchemasMessage(): string {
  return 'None of the loaded files look like JSON Schemas. QuaC looked for keys like `$schema`, `type`, or `properties`.';
}

export function metaMessage(
  path: string,
  draft: SchemaDraft,
  ajvMessage: string,
  instancePath: string,
): string {
  const draftLabel = draft === 'unknown' ? '2020-12' : draft;
  return `\`${path}\` is not a valid ${draftLabel} schema: ${ajvMessage} at \`${instancePath}\`.`;
}

export function mixedDraftMessage(drafts: readonly string[], rootDraft: SchemaDraft): string {
  const rootLabel = rootDraft === 'unknown' ? '2020-12' : rootDraft;
  return `Files use different JSON Schema drafts (${drafts.join(', ')}); QuaC validates using the index file's draft (${rootLabel}).`;
}

export function rootNotTabularMessage(path: string): string {
  return `The index schema \`${path}\` does not describe a table (expected \`type: "array"\` with \`items\`).`;
}

/** `E_FETCH`, CORS-shaped failure (opaque network TypeError — §A.2.7 copy). */
export function fetchCorsMessage(url: string): string {
  return `Couldn't fetch \`${url}\`. The server may not allow cross-origin access. Download the file and upload it instead.`;
}

/** `E_FETCH`, HTTP-status failure. */
export function fetchHttpMessage(url: string, status: number): string {
  return `Couldn't fetch \`${url}\`: the server responded ${String(status)}.`;
}

/** Retrieval-base fallback hit — moved file with a stale `$id` (§A.2.6c). */
export function retrievalFallbackMessage(path: string, ref: string): string {
  return `\`${path}\` resolved \`${ref}\` by file location, not by \`$id\` — the target's \`$id\` may be stale.`;
}

export function rootNotArrayMessage(path: string): string {
  return `The index schema \`${path}\` is not an array-of-objects schema; QuaC expects a table (\`type: "array"\` with object \`items\`).`;
}

/** Dismissible notice for the `auto-preferred` decision (§A.3.4). */
export function autoPreferredMessage(chosen: string, others: readonly string[]): string {
  const list = others.map((p) => `\`${p}\``).join(', ');
  const verb = others.length === 1 ? 'is' : 'are';
  return `Using \`${chosen}\` as the index; ${list} ${verb} also unreferenced.`;
}

export function indexBasenameMessage(indexValue: string, path: string): string {
  return `The shared index reference \`${indexValue}\` matched \`${path}\` by file name only.`;
}

export function indexNoMatchMessage(): string {
  return "The shared index reference didn't match any loaded file.";
}

export function nonSchemaIgnoredMessage(path: string): string {
  return `\`${path}\` doesn't look like a JSON Schema and was ignored.`;
}
