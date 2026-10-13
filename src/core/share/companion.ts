/**
 * Companion channel (companion.md): a page served from the person's own
 * machine — schemify's project website, for one — opens QuaC with
 * `#/load?companion=<its origin>`. Once the person allows it, the page sends
 * JSON Schema files; QuaC loads them, runs the check on the dataset loaded
 * here, and answers with the findings without data. The dataset never crosses:
 * the only payload that leaves is what `buildFindings` admits — definitions
 * and counts.
 *
 * This module is the pure protocol (DOM-free): which origins may be a
 * companion, what a request must look like, and the messages QuaC sends. The
 * window wiring and the consent UI live in `app/companion.ts`.
 */
import type { QcFindings } from '../report/findings';

/** Every message, both ways, carries this marker and the version. */
export const COMPANION_PROTOCOL = 'quac-companion';
export const COMPANION_VERSION = 1;

/** The hash-query key that names the companion's origin. */
export const COMPANION_PARAM = 'companion';

/** Request limits: a schema set is text, but not unbounded text. */
export const COMPANION_MAX_FILES = 500;
export const COMPANION_MAX_CHARS = 20_000_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The origin a `companion=` value names, when it may be one: an exact
 * `http(s)://` origin (no path, query or credentials) on this machine's
 * loopback interface. Anything else is null — QuaC never talks to a page on
 * another machine, so a link someone sends cannot make it report anywhere.
 */
export function companionOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!LOOPBACK_HOSTS.has(url.hostname) && !url.hostname.endsWith('.localhost')) return null;
  // The value must BE an origin: a path, query or fragment means a mistake or a trick.
  if (raw.replace(/\/$/, '') !== url.origin) return null;
  return url.origin;
}

/** One schema file as the companion holds it: its path inside the schema folder, and its text. */
export interface CompanionSchemaFile {
  path: string;
  text: string;
}

/** Load these files as the schema (replacing the slot), then run the check. */
export interface CompanionSchemasRequest {
  kind: 'schemas';
  /** Echoed on every reply about this request. */
  id: string;
  files: CompanionSchemaFile[];
  /** The root schema's path, when several files could be the root. */
  index?: string;
}

export type CompanionRequest = CompanionSchemasRequest | { kind: 'ping' } | { kind: 'close' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A safe relative path: no absolute paths, no `..`, no backslashes or NULs. */
function isSafePath(p: string): boolean {
  if (p === '' || p.length > 500 || p.startsWith('/') || /[\\\0]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Parse a message event's data into a request, or null for anything that is
 * not one — wrong marker or version, unknown kind, malformed or oversized
 * files. Null is silent by design: the page may share its window with other
 * scripts' messages.
 */
export function parseCompanionRequest(data: unknown): CompanionRequest | null {
  if (
    !isRecord(data) ||
    data.protocol !== COMPANION_PROTOCOL ||
    data.version !== COMPANION_VERSION
  ) {
    return null;
  }
  if (data.kind === 'ping' || data.kind === 'close') return { kind: data.kind };
  if (data.kind !== 'schemas') return null;
  if (typeof data.id !== 'string' || data.id === '' || data.id.length > 100) return null;
  if (
    !Array.isArray(data.files) ||
    data.files.length === 0 ||
    data.files.length > COMPANION_MAX_FILES
  ) {
    return null;
  }
  const files: CompanionSchemaFile[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const f of data.files as unknown[]) {
    if (!isRecord(f) || typeof f.path !== 'string' || typeof f.text !== 'string') return null;
    if (!isSafePath(f.path) || !/\.json$/i.test(f.path) || seen.has(f.path)) return null;
    chars += f.text.length;
    if (chars > COMPANION_MAX_CHARS) return null;
    seen.add(f.path);
    files.push({ path: f.path, text: f.text });
  }
  let index: string | undefined;
  if (data.index !== undefined) {
    if (typeof data.index !== 'string' || !seen.has(data.index)) return null;
    index = data.index;
  }
  return { kind: 'schemas', id: data.id, files, ...(index === undefined ? {} : { index }) };
}

/** What QuaC tells the companion about the request in hand. */
export type CompanionStatus =
  /** Loaded; waiting for the person to load a dataset in QuaC. */
  | 'needs-dataset'
  | 'running'
  /** The schema files did not load as a usable set; `detail` says why. */
  | 'schemas-unusable'
  /** The run could not start or did not finish; `detail` says why. */
  | 'failed'
  /** A run is in flight (the person's own, or one for an older request); this one starts when it ends. */
  | 'busy';

interface Envelope {
  protocol: typeof COMPANION_PROTOCOL;
  version: typeof COMPANION_VERSION;
}

export type CompanionMessage = Envelope &
  (
    | { kind: 'hello'; quacVersion: string; datasetLoaded: boolean }
    | { kind: 'status'; id: string | null; status: CompanionStatus; detail?: string }
    | { kind: 'findings'; id: string | null; findings: QcFindings }
    | { kind: 'closed' }
  );

const envelope: Envelope = { protocol: COMPANION_PROTOCOL, version: COMPANION_VERSION };

export function helloMessage(quacVersion: string, datasetLoaded: boolean): CompanionMessage {
  return { ...envelope, kind: 'hello', quacVersion, datasetLoaded };
}

export function statusMessage(
  id: string | null,
  status: CompanionStatus,
  detail?: string,
): CompanionMessage {
  return { ...envelope, kind: 'status', id, status, ...(detail === undefined ? {} : { detail }) };
}

/**
 * The findings, and nothing else of the run. Refuses a document that does not
 * declare itself data-free — the one invariant this channel exists to keep.
 */
export function findingsMessage(id: string | null, findings: QcFindings): CompanionMessage {
  if ((findings as { containsData?: unknown }).containsData !== false) {
    throw new Error('Refusing to send findings that do not declare containsData: false.');
  }
  return { ...envelope, kind: 'findings', id, findings };
}

export function closedMessage(): CompanionMessage {
  return { ...envelope, kind: 'closed' };
}
