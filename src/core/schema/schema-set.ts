/**
 * Schema-set intake: normalization, BOM strip, JSON parse, classification,
 * `$id`/draft extraction, indexes, manifest-hint capture, `setId` fingerprint
 * (json-schema-subsystem.md §A.2). Pure and node-testable; the assembly
 * orchestrator (`buildSchemaSet`) lives here too once ref-graph and root
 * detection land.
 */
import { dupIdMessage, loadError, parseMessage } from './messages';
import type { IntakeEntry, SchemaDraft, SchemaFile, SchemaLoadError, SchemaSet } from './types';

/** §A.2.3 — one own key from this set ⇒ the JSON object is a schema. */
const SCHEMA_MARKER_KEYS = [
  '$schema',
  '$id',
  'type',
  'properties',
  'items',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  '$defs',
  'definitions',
  '$ref',
  'enum',
  'required',
] as const;

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * §A.2.3. Bare `true`/`false` are valid schemas but cannot be a tabular root
 * ⇒ non-schema (ref-target promotion still rescues them, ledger 8).
 */
export function classifyJson(json: unknown): 'schema' | 'non-schema' {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return 'non-schema';
  const keys = new Set(Object.keys(json));
  return SCHEMA_MARKER_KEYS.some((k) => keys.has(k)) ? 'schema' : 'non-schema';
}

/**
 * Strip the single common leading directory (folder uploads carry the chosen
 * folder's name on every webkitRelativePath). Only one level, and only when
 * every path shares it.
 */
export function stripCommonRoot(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const firstSegments = paths.map((p) => {
    const slash = p.indexOf('/');
    return slash === -1 ? null : p.slice(0, slash);
  });
  const root = firstSegments[0];
  if (root === null || root === undefined || root === '') return [...paths];
  if (!firstSegments.every((s) => s === root)) return [...paths];
  return paths.map((p) => p.slice(root.length + 1));
}

/** SHA-256 over sorted, length-prefixed (relativePath, raw) pairs; first 16 hex chars. */
export async function computeSetId(entries: readonly IntakeEntry[]): Promise<string> {
  const sorted = [...entries].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  const payload = sorted
    .map(
      (e) =>
        `${String(e.relativePath.length)}:${e.relativePath}${String(e.raw.length)}:${e.raw}`,
    )
    .join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * §A.2.3 manifest hint: exactly one non-schema file with an `entrypoints`
 * object ⇒ its values, in insertion order, matched against loaded
 * relativePaths. Dangling entries are tolerated (HESP's manifest names a file
 * that does not exist); matching is only an ordering hint, never a selection.
 */
export function extractManifestHints(files: readonly SchemaFile[]): string[] {
  const manifests = files.filter((f) => {
    if (f.classification !== 'non-schema') return false;
    const json = f.json;
    return (
      json !== null &&
      typeof json === 'object' &&
      !Array.isArray(json) &&
      typeof (json as Record<string, unknown>).entrypoints === 'object' &&
      (json as Record<string, unknown>).entrypoints !== null
    );
  });
  if (manifests.length !== 1) return [];
  const manifest = manifests[0];
  if (!manifest) return [];
  const entrypoints = (manifest.json as Record<string, unknown>).entrypoints as Record<
    string,
    unknown
  >;
  const byPath = new Map(files.map((f) => [f.relativePath, f.fileId]));
  const hints: string[] = [];
  for (const value of Object.values(entrypoints)) {
    if (typeof value !== 'string') continue;
    const fileId = byPath.get(value);
    if (fileId !== undefined && !hints.includes(fileId)) hints.push(fileId);
  }
  return hints;
}

/** POSIX-normalize an upload path and escape URL-hostile characters. */
function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** `quac-set:/{relativePath}` — the synthetic base scheme (§B.2), URL-normalized. */
export function quacSetUri(relativePath: string): string {
  const escaped = relativePath.replaceAll('#', '%23').replaceAll('?', '%3F');
  return new URL(`quac-set:/${escaped}`).href;
}

function draftOf(json: unknown): SchemaDraft {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return 'unknown';
  const declared = (json as Record<string, unknown>).$schema;
  if (typeof declared !== 'string') return 'unknown';
  if (declared.includes('2020-12')) return '2020-12';
  if (declared.includes('2019-09')) return '2019-09';
  if (declared.includes('draft-07')) return 'draft-07';
  return 'unknown';
}

function declaredIdOf(json: unknown, retrievalUri: string): string | undefined {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const id = (json as Record<string, unknown>).$id;
  if (typeof id !== 'string' || id === '') return undefined;
  try {
    const url = new URL(id, retrievalUri);
    url.hash = '';
    return url.href.replace(/#$/, '');
  } catch {
    return undefined;
  }
}

export interface IntakeResult {
  /** Every parsed `.json` file, all classifications, sorted by relativePath. */
  files: SchemaFile[];
  /** Non-JSON-extension uploads (README.md, .DS_Store) — silently ignored. */
  ignored: SchemaSet['ignored'];
  idIndex: Map<string, string>;
  pathIndex: Map<string, string>;
  /** E_PARSE and E_DUP_ID findings, in file order. */
  errors: SchemaLoadError[];
}

/**
 * §A.2 steps 1–4 for a single entry, appending into the accumulator. Also the
 * intake path for URL-crawled files (ref-graph injects it, mirroring
 * FetchJson). Returns the SchemaFile, or undefined for ignored extensions.
 */
export function intakeEntry(
  entry: IntakeEntry,
  origin: 'upload' | 'url',
  acc: IntakeResult,
): SchemaFile | undefined {
  const isUpload = entry.retrievalUri === undefined;
  if (isUpload && !/\.json$/i.test(entry.relativePath)) {
    acc.ignored.push({ fileId: entry.relativePath, reason: 'unsupported-extension' });
    return undefined;
  }
  const retrievalUri = entry.retrievalUri ?? quacSetUri(entry.relativePath);
  const fileId = origin === 'url' ? retrievalUri : entry.relativePath;
  const raw = stripBom(entry.raw);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    acc.errors.push(loadError('E_PARSE', parseMessage(entry.relativePath, reason), { fileId }));
    const file: SchemaFile = {
      fileId,
      relativePath: entry.relativePath,
      retrievalUri,
      raw,
      json: undefined,
      draft: 'unknown',
      classification: 'invalid-json',
      refs: [],
    };
    acc.files.push(file);
    return file;
  }

  const file: SchemaFile = {
    fileId,
    relativePath: entry.relativePath,
    retrievalUri,
    raw,
    json,
    draft: draftOf(json),
    classification: classifyJson(json),
    refs: [],
  };
  const declaredId = declaredIdOf(json, retrievalUri);
  if (declaredId !== undefined) {
    file.declaredId = declaredId;
    const holder = acc.idIndex.get(declaredId);
    if (holder !== undefined) {
      // First declarer keeps the index slot; the set is fatal anyway.
      const holderPath = acc.files.find((f) => f.fileId === holder)?.relativePath ?? holder;
      acc.errors.push(
        loadError('E_DUP_ID', dupIdMessage(declaredId, holderPath, entry.relativePath), {
          fileId,
          meta: { id: declaredId, files: [holder, fileId] },
        }),
      );
    } else {
      acc.idIndex.set(declaredId, fileId);
    }
  }
  acc.pathIndex.set(retrievalUri, fileId);
  acc.files.push(file);
  return file;
}

/**
 * §A.2 steps 1–4 for one batch of entries. Deterministic: files are processed
 * in relativePath order, and the first declarer of an `$id` keeps the index
 * slot when `E_DUP_ID` fires.
 */
export function intakeFiles(
  entries: readonly IntakeEntry[],
  origin: 'upload' | 'url',
): IntakeResult {
  const normalized = entries.map((e) => ({ ...e, relativePath: normalizePath(e.relativePath) }));
  const stripped = stripCommonRoot(normalized.map((e) => e.relativePath));
  const sorted = normalized
    .map((e, i) => ({ ...e, relativePath: stripped[i] ?? e.relativePath }))
    .sort((a, b) =>
      a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
    );

  const acc: IntakeResult = {
    files: [],
    ignored: [],
    idIndex: new Map(),
    pathIndex: new Map(),
    errors: [],
  };
  for (const entry of sorted) intakeEntry(entry, origin, acc);
  return acc;
}
