/**
 * Ref graph (json-schema-subsystem.md §A.2.5–7): deep `$ref` scan, RFC 3986
 * resolution over the `quac-set:/` synthetic base, the 5-step match order with
 * retrieval-base fallback and URL crawl (caps 64 files / depth 8), fragment
 * pre-checks, and ref-target promotion. Pure and node-testable — network and
 * intake are injected ports (`fetchJson`, `intakeFetched`).
 */
import {
  badFragmentMessage,
  fetchCorsMessage,
  fetchHttpMessage,
  loadError,
  retrievalFallbackMessage,
  unresolvedRefMessage,
} from './messages';
import type { IntakeResult } from './schema-set';
import type { FetchJson, IntakeEntry, SchemaFile, SchemaLoadError } from './types';

/** Keywords whose object value maps NAMES to schemas — keys are not keywords. */
const MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/** Keywords whose value is data, not schema — a `$ref` key inside is not a ref. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples', '$comment']);

export interface RawRef {
  /** JSON Pointer of the `$ref`/`$dynamicRef` keyword itself. */
  fromPointer: string;
  refValue: string;
  /** Effective base at the ref site: nearest ancestor `$id` chain, else the caller's fallback. */
  base: string;
}

function escapeSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * §A.2.5 deep ref scan. `$dynamicRef` is recorded identically to `$ref` for
 * graph purposes; `$ref` siblings are walked too (2020-12 allows them). The
 * in-file `$id` chain is resolved along the walk so each RawRef carries its
 * effective base (§A.2.6a).
 */
export function scanRefs(json: unknown, fallbackBase: string): RawRef[] {
  const refs: RawRef[] = [];

  function walk(node: unknown, pointer: string, base: string): void {
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, `${pointer}/${String(i)}`, base);
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;

    let currentBase = base;
    const embeddedId = record.$id;
    if (typeof embeddedId === 'string' && embeddedId !== '') {
      try {
        currentBase = new URL(embeddedId, base).href;
      } catch {
        // Unresolvable $id: keep the outer base; meta-validation reports it.
      }
    }

    for (const keyword of ['$ref', '$dynamicRef'] as const) {
      if (typeof record[keyword] === 'string') {
        refs.push({
          fromPointer: `${pointer}/${keyword}`,
          refValue: record[keyword],
          base: currentBase,
        });
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (DATA_KEYWORDS.has(key)) continue;
      if (key === '$ref' || key === '$dynamicRef') continue;
      const childPointer = `${pointer}/${escapeSegment(key)}`;
      if (MAP_KEYWORDS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, subSchema] of Object.entries(value)) {
          walk(subSchema, `${childPointer}/${escapeSegment(name)}`, currentBase);
        }
      } else {
        walk(value, childPointer, currentBase);
      }
    }
  }

  walk(json, '', fallbackBase);
  return refs;
}

/** RFC 6901 pointer dereference: URI-decode each segment, then `~1` → `/`, `~0` → `~`. */
function pointerExists(json: unknown, fragment: string): boolean {
  let node = json;
  for (const rawSegment of fragment.split('/').slice(1)) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return false;
    }
    segment = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return false;
      const index = Number(segment);
      if (index >= node.length) return false;
      node = node[index];
    } else if (node !== null && typeof node === 'object') {
      if (!Object.hasOwn(node, segment)) return false;
      node = (node as Record<string, unknown>)[segment];
    } else {
      return false;
    }
  }
  return true;
}

function anchorExists(json: unknown, name: string): boolean {
  if (Array.isArray(json)) return json.some((item) => anchorExists(item, name));
  if (json === null || typeof json !== 'object') return false;
  const record = json as Record<string, unknown>;
  if (record.$anchor === name || record.$dynamicAnchor === name) return true;
  return Object.entries(record).some(
    ([key, value]) => !DATA_KEYWORDS.has(key) && anchorExists(value, name),
  );
}

/** §A.2.6d fragment pre-check (nicer than Ajv's failures). */
export function checkFragment(
  targetJson: unknown,
  fragment: string,
  kind: 'pointer' | 'anchor',
): boolean {
  return kind === 'pointer' ? pointerExists(targetJson, fragment) : anchorExists(targetJson, name(fragment));
}

function name(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export interface RefGraphOptions {
  intake: IntakeResult;
  origin: 'upload' | 'url';
  fetchJson?: FetchJson;
  /** Intake for crawled files — wire to `intakeEntry(e, 'url', acc)`. */
  intakeFetched?: (entry: IntakeEntry) => SchemaFile | undefined;
  caps?: { maxFiles?: number; maxDepth?: number };
}

export interface RefGraphResult {
  /** classification 'schema' plus every promoted ref target (§A.2.3). */
  schemaIds: Set<string>;
  errors: SchemaLoadError[];
}

function basenameOf(uri: string): string {
  const path = uri.split('#')[0] ?? uri;
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

function stripHash(url: URL): string {
  url.hash = '';
  return url.href.replace(/#$/, '');
}

/**
 * §A.2 steps 5–7: scan every schema (and every file promoted by being a ref
 * target), resolve each ref through the match order, crawl URL sets, and
 * collect ALL errors — resolution never stops at the first failure.
 */
export async function resolveRefGraph(options: RefGraphOptions): Promise<RefGraphResult> {
  const { intake, origin } = options;
  const caps = { maxFiles: options.caps?.maxFiles ?? 64, maxDepth: options.caps?.maxDepth ?? 8 };
  const byId = new Map(intake.files.map((f) => [f.fileId, f]));
  const errors: SchemaLoadError[] = [];

  const schemaIds = new Set<string>();
  const queue: string[] = [];
  const scanned = new Set<string>();
  const depths = new Map<string, number>();
  for (const file of intake.files) {
    depths.set(file.fileId, 0);
    if (file.classification === 'schema') {
      schemaIds.add(file.fileId);
      queue.push(file.fileId);
    }
  }

  /** requested URI → fileId, so redirects and repeats never re-fetch. */
  const fetchedAlias = new Map<string, string>();
  const failedFetches = new Set<string>();

  const lookup = (uri: string): string | undefined =>
    intake.idIndex.get(uri) ?? intake.pathIndex.get(uri) ?? fetchedAlias.get(uri);

  async function crawl(uri: string, fromFileId: string): Promise<string | undefined> {
    if (options.fetchJson === undefined || options.intakeFetched === undefined) return undefined;
    if (failedFetches.has(uri)) return undefined;
    const known = lookup(uri);
    if (known !== undefined) return known;
    if (!/^https?:$/.test(new URL(uri).protocol)) return undefined;
    const depth = (depths.get(fromFileId) ?? 0) + 1;
    if (depth > caps.maxDepth || intake.files.length >= caps.maxFiles) return undefined;

    let fetched: { finalUrl: string; text: string };
    try {
      fetched = await options.fetchJson(uri);
    } catch (err) {
      failedFetches.add(uri);
      const status = (err as { status?: unknown }).status;
      const message =
        typeof status === 'number' ? fetchHttpMessage(uri, status) : fetchCorsMessage(uri);
      errors.push(loadError('E_FETCH', message, { meta: { url: uri } }));
      return undefined;
    }

    const existing = lookup(fetched.finalUrl);
    if (existing !== undefined) {
      fetchedAlias.set(uri, existing);
      return existing;
    }
    const file = options.intakeFetched({
      relativePath: fetched.finalUrl,
      raw: fetched.text,
      retrievalUri: fetched.finalUrl,
    });
    if (file === undefined) return undefined;
    byId.set(file.fileId, file);
    depths.set(file.fileId, depth);
    fetchedAlias.set(uri, file.fileId);
    return file.fileId;
  }

  async function resolveOne(file: SchemaFile, rawRef: RawRef): Promise<void> {
    const hashIndex = rawRef.refValue.indexOf('#');
    const uriPart = hashIndex === -1 ? rawRef.refValue : rawRef.refValue.slice(0, hashIndex);
    const rawFragment = hashIndex === -1 ? '' : rawRef.refValue.slice(hashIndex + 1);
    const fragment = rawFragment === '' ? null : rawFragment;
    const fragmentKind = fragment === null ? null : fragment.startsWith('/') ? 'pointer' : 'anchor';

    const finishEdge = (resolvedUri: string, targetFileId: string | null): void => {
      file.refs.push({
        fromPointer: rawRef.fromPointer,
        refValue: rawRef.refValue,
        resolvedUri,
        fragment,
        fragmentKind,
        targetFileId,
      });
      if (targetFileId === null) return;
      const target = byId.get(targetFileId);
      if (target === undefined) return;
      // Referenced-file override: any ref target joins `schemas` and gets scanned.
      if (target.classification !== 'invalid-json' && !schemaIds.has(targetFileId)) {
        schemaIds.add(targetFileId);
      }
      if (!scanned.has(targetFileId)) queue.push(targetFileId);
      if (fragment !== null && fragmentKind !== null && target.classification !== 'invalid-json') {
        if (!checkFragment(target.json, fragment, fragmentKind)) {
          errors.push(
            loadError(
              'E_BAD_FRAGMENT',
              badFragmentMessage(
                file.relativePath,
                rawRef.refValue,
                `#${fragment}`,
                target.relativePath,
              ),
              { fileId: file.fileId, meta: { pointer: rawRef.fromPointer } },
            ),
          );
        }
      }
    };

    // Fragment-only refs resolve to the same file — no graph edge (§A.2.6b).
    if (uriPart === '') {
      finishEdge(stripHash(new URL(file.retrievalUri)), file.fileId);
      return;
    }

    let resolvedUri: string;
    try {
      resolvedUri = stripHash(new URL(uriPart, rawRef.base));
    } catch {
      errors.push(
        loadError(
          'E_UNRESOLVED_REF',
          unresolvedRefMessage(
            file.relativePath,
            rawRef.refValue,
            rawRef.fromPointer,
            basenameOf(rawRef.refValue),
          ),
          { fileId: file.fileId, meta: { triedUris: [], pointer: rawRef.fromPointer } },
        ),
      );
      file.refs.push({
        fromPointer: rawRef.fromPointer,
        refValue: rawRef.refValue,
        resolvedUri: rawRef.refValue,
        fragment,
        fragmentKind,
        targetFileId: null,
      });
      return;
    }

    const tried = [resolvedUri];
    let target = lookup(resolvedUri);

    // Retrieval-base fallback: moved files with stale `$id`s (§A.2.6c step 3).
    let retrievalUri = resolvedUri;
    if (target === undefined && rawRef.base !== file.retrievalUri) {
      try {
        retrievalUri = stripHash(new URL(uriPart, file.retrievalUri));
      } catch {
        retrievalUri = resolvedUri;
      }
      if (retrievalUri !== resolvedUri) {
        tried.push(retrievalUri);
        target = lookup(retrievalUri);
        if (target !== undefined) {
          errors.push(
            loadError(
              'W_RETRIEVAL_FALLBACK',
              retrievalFallbackMessage(file.relativePath, rawRef.refValue),
              { fileId: file.fileId, meta: { pointer: rawRef.fromPointer } },
            ),
          );
        }
      }
    }

    // URL sets only: crawl the retrieval-base URI. Relative refs only (edge
    // ledger 6) — an absolute ref is `$id`-territory and is never fetched.
    const isRelativeRef = !/^[a-z][a-z0-9+.-]*:/i.test(uriPart);
    if (target === undefined && origin === 'url' && isRelativeRef) {
      target = await crawl(retrievalUri, file.fileId);
    }

    if (target === undefined) {
      errors.push(
        loadError(
          'E_UNRESOLVED_REF',
          unresolvedRefMessage(
            file.relativePath,
            rawRef.refValue,
            rawRef.fromPointer,
            basenameOf(resolvedUri),
          ),
          { fileId: file.fileId, meta: { triedUris: tried, pointer: rawRef.fromPointer } },
        ),
      );
      finishEdge(resolvedUri, null);
      return;
    }
    finishEdge(resolvedUri, target);
  }

  while (queue.length > 0) {
    const fileId = queue.shift();
    if (fileId === undefined) break;
    if (scanned.has(fileId)) continue;
    scanned.add(fileId);
    const file = byId.get(fileId);
    if (file === undefined || file.classification === 'invalid-json') continue;
    const rawRefs = scanRefs(file.json, file.declaredId ?? file.retrievalUri);
    for (const rawRef of rawRefs) {
      await resolveOne(file, rawRef);
    }
  }

  return { schemaIds, errors };
}
