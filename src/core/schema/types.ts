/**
 * JSON-Schema subsystem data model — json-schema-subsystem.md §A.1 verbatim,
 * plus the intake/error/fetch shapes the loader pipeline shares. Pure types;
 * consumed by P06 (loading), P07 (digests), P08/P09 (validation).
 */

export type SchemaDraft = '2020-12' | '2019-09' | 'draft-07' | 'unknown';

/** One file handed to the loader, before parsing/classification. */
export interface IntakeEntry {
  /**
   * Uploads: webkitRelativePath (the loader strips the single common leading
   * directory) or the file's name. URL crawl results: filled by the loader.
   */
  relativePath: string;
  raw: string;
  /** URL mode only: the post-redirect fetched URL. Uploads derive `quac-set:/…`. */
  retrievalUri?: string;
}

export interface SchemaFile {
  /** Stable within the set: relativePath (uploads) or absolute URL (URL mode). */
  fileId: string;
  relativePath: string;
  /** Canonical base for RFC 3986 resolution: `quac-set:/{relativePath}` or the fetched URL. */
  retrievalUri: string;
  raw: string;
  json: unknown;
  /** Root `$id` resolved against retrievalUri (absolute, fragment stripped). */
  declaredId?: string;
  /** 'unknown' ⇒ treated as 2020-12. */
  draft: SchemaDraft;
  classification: 'schema' | 'non-schema' | 'invalid-json';
  refs: RefEdge[];
}

export interface RefEdge {
  /** JSON Pointer of the `$ref` keyword within the file. */
  fromPointer: string;
  refValue: string;
  /** Absolute, fragment stripped. */
  resolvedUri: string;
  /** '#/$defs/yes_no' → '/$defs/yes_no'. */
  fragment: string | null;
  fragmentKind: 'pointer' | 'anchor' | null;
  /** null ⇒ unresolved. */
  targetFileId: string | null;
}

export interface RootCandidate {
  fileId: string;
  declaredId?: string;
  title?: string;
  arrayOfObjects: boolean;
  inDegree: number;
}

export interface RootDetectionResult {
  status: 'auto' | 'auto-preferred' | 'ambiguous' | 'none' | 'error';
  rootFileId?: string;
  /** For the IndexPickerModal. */
  candidates: RootCandidate[];
  /** Shareable id (§A.4). */
  indexFileId?: string;
}

export interface SchemaSet {
  /** SHA-256 over sorted (relativePath, raw) pairs, first 16 hex chars. */
  setId: string;
  origin: 'upload' | 'url';
  files: SchemaFile[];
  /** Classification 'schema' + files promoted by being ref targets. */
  schemas: SchemaFile[];
  ignored: { fileId: string; reason: 'non-schema' | 'not-json' | 'unsupported-extension' }[];
  /** declaredId → fileId. */
  idIndex: Map<string, string>;
  /** retrievalUri → fileId. */
  pathIndex: Map<string, string>;
  root: RootDetectionResult;
  errors: SchemaLoadError[];
  /**
   * FileIds named by a manifest's `entrypoints`, in entrypoint order — used
   * only to order IndexPickerModal candidates, never to auto-select (§A.2.3).
   */
  manifestHints: string[];
}

/** §A.5 pre-check codes plus the loader's warning/notice codes. */
export type SchemaLoadCode =
  | 'E_PARSE'
  | 'E_DUP_ID'
  | 'E_UNRESOLVED_REF'
  | 'E_BAD_FRAGMENT'
  | 'E_NO_SCHEMAS'
  | 'E_META'
  | 'E_MIXED_DRAFT'
  | 'E_ROOT_NOT_TABULAR'
  | 'E_FETCH'
  | 'W_RETRIEVAL_FALLBACK'
  | 'W_ROOT_NOT_ARRAY'
  | 'W_INDEX_BASENAME'
  | 'W_INDEX_NO_MATCH'
  | 'I_AUTO_PREFERRED'
  | 'I_NON_SCHEMA_IGNORED';

export const SCHEMA_LOAD_SEVERITY: Readonly<Record<SchemaLoadCode, 'fatal' | 'warning' | 'info'>> =
  {
    E_PARSE: 'fatal',
    E_DUP_ID: 'fatal',
    E_UNRESOLVED_REF: 'fatal',
    E_BAD_FRAGMENT: 'fatal',
    E_NO_SCHEMAS: 'fatal',
    E_META: 'fatal',
    E_MIXED_DRAFT: 'warning',
    E_ROOT_NOT_TABULAR: 'fatal',
    E_FETCH: 'fatal',
    W_RETRIEVAL_FALLBACK: 'warning',
    W_ROOT_NOT_ARRAY: 'warning',
    W_INDEX_BASENAME: 'warning',
    W_INDEX_NO_MATCH: 'warning',
    I_AUTO_PREFERRED: 'info',
    I_NON_SCHEMA_IGNORED: 'info',
  };

/**
 * One collected pre-check finding. Every stage appends and continues — fatal
 * findings block validation, never schema browsing (§A.5).
 */
export interface SchemaLoadError {
  code: SchemaLoadCode;
  severity: 'fatal' | 'warning' | 'info';
  /** Set when the finding belongs to one file. */
  fileId?: string;
  /** Exact user-facing copy per §A.5 (messages.ts). */
  message: string;
  /** Structured extras: tried URIs, duplicate pair, pointer, … */
  meta?: Record<string, unknown>;
}

/** Injected fetch port — node tests stub it; the browser uses fetch-json.ts. */
export type FetchJson = (url: string) => Promise<{ finalUrl: string; text: string }>;
