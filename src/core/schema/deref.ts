/**
 * Read-side ref resolution for the digest walkers (P07+). The load pipeline
 * already resolved every `$ref` into `SchemaFile.refs` (RefEdge, keyed by the
 * JSON Pointer of the `$ref` keyword) — walkers never re-resolve URIs, they
 * look the edge up by pointer and dereference the fragment in the target file.
 */
import type { RefEdge, SchemaFile, SchemaSet } from './types';

/** RFC 6901 escape for one pointer segment (`~` → `~0`, `/` → `~1`). */
export function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** RFC 6901 dereference; segments are URI-decoded then unescaped. */
export function getAtPointer(json: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === '') return { found: true, value: json };
  let node = json;
  for (const rawSegment of pointer.split('/').slice(1)) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return { found: false, value: undefined };
    }
    segment = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return { found: false, value: undefined };
      const index = Number(segment);
      if (index >= node.length) return { found: false, value: undefined };
      node = node[index];
    } else if (node !== null && typeof node === 'object') {
      if (!Object.hasOwn(node, segment)) return { found: false, value: undefined };
      node = (node as Record<string, unknown>)[segment];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: node };
}

/** A schema node addressed by (file, in-file JSON Pointer) — a walk position. */
export interface SchemaSite {
  file: SchemaFile;
  /** Pointer of `node` within `file.json` ('' = document root). */
  pointer: string;
  node: unknown;
}

export interface RefResolver {
  /**
   * Follow the `$ref` whose keyword sits at `fromPointer` in `file`.
   * Null when the edge is unresolved, targets an anchor (digests treat those
   * as opaque), or the fragment does not dereference.
   */
  resolve: (file: SchemaFile, fromPointer: string) => SchemaSite | null;
  fileById: (fileId: string) => SchemaFile | undefined;
}

export function createRefResolver(set: SchemaSet): RefResolver {
  const files = new Map(set.files.map((f) => [f.fileId, f]));
  const edges = new Map<SchemaFile, Map<string, RefEdge>>();
  const edgesFor = (file: SchemaFile): Map<string, RefEdge> => {
    let map = edges.get(file);
    if (map === undefined) {
      map = new Map(file.refs.map((edge) => [edge.fromPointer, edge]));
      edges.set(file, map);
    }
    return map;
  };
  return {
    resolve: (file, fromPointer) => {
      const edge = edgesFor(file).get(fromPointer);
      const targetFileId = edge?.targetFileId ?? null;
      if (edge === undefined || targetFileId === null) return null;
      if (edge.fragmentKind === 'anchor') return null;
      const target = files.get(targetFileId);
      if (target === undefined) return null;
      const pointer = edge.fragment ?? '';
      const at = getAtPointer(target.json, pointer);
      if (!at.found) return null;
      return { file: target, pointer, node: at.value };
    },
    fileById: (fileId) => files.get(fileId),
  };
}
