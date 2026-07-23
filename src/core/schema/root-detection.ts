/**
 * Root detection (json-schema-subsystem.md §A.3) and the `indexFileId` share
 * contract (§A.4): in-degree-0 candidates over the file digraph, the
 * arrayOfObjects shape heuristic, the four-way decision, manifest-hint
 * candidate ordering, post-selection checks, and `index=` resolution.
 */
import {
  autoPreferredMessage,
  indexBasenameMessage,
  indexNoMatchMessage,
  loadError,
  noSchemasMessage,
  rootNotArrayMessage,
  rootNotTabularMessage,
} from './messages';
import type {
  RootCandidate,
  RootDetectionResult,
  SchemaFile,
  SchemaLoadError,
  SchemaSet,
} from './types';

/**
 * §A.3.3 — root has `type:"array"` (or no `type` but `items`) AND `items` is
 * an object/$ref (not tuple/boolean).
 */
export function arrayOfObjects(json: unknown): boolean {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false;
  const record = json as Record<string, unknown>;
  const shapeOk =
    record.type === 'array' || (record.type === undefined && record.items !== undefined);
  if (!shapeOk) return false;
  const items = record.items;
  return items !== null && typeof items === 'object' && !Array.isArray(items);
}

function hasItems(json: unknown): boolean {
  return (
    json !== null && typeof json === 'object' && !Array.isArray(json) && Object.hasOwn(json, 'items')
  );
}

function candidateOf(file: SchemaFile, inDegree: number): RootCandidate {
  const candidate: RootCandidate = {
    fileId: file.fileId,
    arrayOfObjects: arrayOfObjects(file.json),
    inDegree,
  };
  if (file.declaredId !== undefined) candidate.declaredId = file.declaredId;
  const title =
    file.json !== null && typeof file.json === 'object' && !Array.isArray(file.json)
      ? (file.json as Record<string, unknown>).title
      : undefined;
  if (typeof title === 'string') candidate.title = title;
  return candidate;
}

export interface DetectRootArgs {
  files: readonly SchemaFile[];
  schemaIds: ReadonlySet<string>;
  manifestHints: readonly string[];
}

/**
 * §A.3.1–4. Returns the decision without post-selection checks — callers run
 * `applyRootSelection` for auto decisions, `index=` matches, and modal picks
 * alike, so the checks live in one place.
 */
export function detectRoot(args: DetectRootArgs): {
  root: RootDetectionResult;
  errors: SchemaLoadError[];
} {
  const schemas = args.files.filter((f) => args.schemaIds.has(f.fileId));
  if (schemas.length === 0) {
    return {
      root: { status: 'error', candidates: [] },
      errors: [loadError('E_NO_SCHEMAS', noSchemasMessage())],
    };
  }

  const inDegree = new Map<string, number>(schemas.map((f) => [f.fileId, 0]));
  for (const file of schemas) {
    // Self and parallel edges collapse: distinct targets only (§A.3.1).
    const targets = new Set(
      file.refs
        .map((r) => r.targetFileId)
        .filter((t): t is string => t !== null && t !== file.fileId && inDegree.has(t)),
    );
    for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }

  const byPath = (file: SchemaFile) => file.relativePath;
  const hintRank = (fileId: string) => {
    const index = args.manifestHints.indexOf(fileId);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const order = (list: SchemaFile[]): SchemaFile[] =>
    [...list].sort((a, b) => {
      const hint = hintRank(a.fileId) - hintRank(b.fileId);
      if (hint !== 0) return hint;
      const shape = Number(arrayOfObjects(b.json)) - Number(arrayOfObjects(a.json));
      if (shape !== 0) return shape;
      return byPath(a) < byPath(b) ? -1 : byPath(a) > byPath(b) ? 1 : 0;
    });
  const toCandidates = (list: SchemaFile[]): RootCandidate[] =>
    list.map((f) => candidateOf(f, inDegree.get(f.fileId) ?? 0));

  const unreferenced = schemas.filter((f) => inDegree.get(f.fileId) === 0);

  if (unreferenced.length === 1) {
    const root = unreferenced[0];
    if (root === undefined) throw new Error('unreachable');
    return {
      root: { status: 'auto', rootFileId: root.fileId, candidates: toCandidates([root]) },
      errors: [],
    };
  }

  if (unreferenced.length > 1) {
    const arrayShaped = unreferenced.filter((f) => arrayOfObjects(f.json));
    if (arrayShaped.length === 1) {
      const root = arrayShaped[0];
      if (root === undefined) throw new Error('unreachable');
      const others = unreferenced.filter((f) => f.fileId !== root.fileId).map(byPath);
      return {
        root: {
          status: 'auto-preferred',
          rootFileId: root.fileId,
          candidates: toCandidates(order(unreferenced)),
        },
        errors: [
          loadError('I_AUTO_PREFERRED', autoPreferredMessage(byPath(root), others), {
            fileId: root.fileId,
          }),
        ],
      };
    }
    return {
      root: { status: 'ambiguous', candidates: toCandidates(order(unreferenced)) },
      errors: [],
    };
  }

  // |C| = 0 with schemas present: a cycle — the user picks the entry point.
  return { root: { status: 'none', candidates: toCandidates(order([...schemas])) }, errors: [] };
}

/** §A.4 — first available of declaredId, absolute URL (URL mode), relativePath. */
export function computeIndexFileId(file: SchemaFile, origin: 'upload' | 'url'): string {
  return file.declaredId ?? (origin === 'url' ? file.fileId : file.relativePath);
}

export type IndexMatch =
  | {
      fileId: string;
      matchedBy: 'declaredId' | 'retrievalUri' | 'relativePath' | 'basename';
      warning?: SchemaLoadError;
    }
  | { fileId: null; warning: SchemaLoadError };

/**
 * §A.4 `index=` resolution: exact `declaredId` → exact retrievalUri/URL →
 * exact relativePath → unique basename (warning) → no match (warning; the
 * caller shows the modal anyway). A match always suppresses the modal.
 */
export function resolveIndexParam(set: SchemaSet, indexValue: string): IndexMatch {
  const schemas = set.schemas;
  const byDeclaredId = schemas.find((f) => f.declaredId === indexValue);
  if (byDeclaredId) return { fileId: byDeclaredId.fileId, matchedBy: 'declaredId' };
  const byRetrieval = schemas.find(
    (f) => f.retrievalUri === indexValue || (set.origin === 'url' && f.fileId === indexValue),
  );
  if (byRetrieval) return { fileId: byRetrieval.fileId, matchedBy: 'retrievalUri' };
  const byPath = schemas.find((f) => f.relativePath === indexValue);
  if (byPath) return { fileId: byPath.fileId, matchedBy: 'relativePath' };
  const byBasename = schemas.filter((f) => f.relativePath.split('/').pop() === indexValue);
  const only = byBasename[0];
  if (byBasename.length === 1 && only !== undefined) {
    return {
      fileId: only.fileId,
      matchedBy: 'basename',
      warning: loadError('W_INDEX_BASENAME', indexBasenameMessage(indexValue, only.relativePath), {
        fileId: only.fileId,
      }),
    };
  }
  return { fileId: null, warning: loadError('W_INDEX_NO_MATCH', indexNoMatchMessage()) };
}

const POST_SELECTION_CODES = new Set(['W_ROOT_NOT_ARRAY', 'E_ROOT_NOT_TABULAR']);

/**
 * Record a root choice (auto, `index=` match, or modal pick): sets
 * `rootFileId` + `indexFileId`, replaces previous post-selection findings
 * (§A.3.5: non-array roots warn; an `items`-less root is fatal). Pure — a
 * fresh SchemaSet snapshot comes back.
 */
export function applyRootSelection(set: SchemaSet, fileId: string): SchemaSet {
  const file = set.files.find((f) => f.fileId === fileId);
  if (file === undefined) return set;
  const errors = set.errors.filter((e) => !POST_SELECTION_CODES.has(e.code));
  if (!arrayOfObjects(file.json)) {
    if (!hasItems(file.json)) {
      errors.push(
        loadError('E_ROOT_NOT_TABULAR', rootNotTabularMessage(file.relativePath), { fileId }),
      );
    } else {
      errors.push(
        loadError('W_ROOT_NOT_ARRAY', rootNotArrayMessage(file.relativePath), { fileId }),
      );
    }
  }
  return {
    ...set,
    errors,
    root: {
      ...set.root,
      rootFileId: fileId,
      indexFileId: computeIndexFileId(file, set.origin),
    },
  };
}
