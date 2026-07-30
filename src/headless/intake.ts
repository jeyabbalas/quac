/**
 * Reading the three inputs (headless.md §8), the headless counterpart of the
 * browser's drop zones and URL fields.
 *
 * Local paths, directories and `http(s)` URLs are all accepted for the two
 * check sources; the DATASET is a local path by design — §5's grammar is
 * `quac <dataset>` with no URL form, and a pipeline that streams its data from
 * a URL can fetch it with the tool it already uses.
 *
 * There is no CORS here (§8): CORS is a browser concept, so a URL that the web
 * app cannot reach for want of an `Access-Control-Allow-Origin` header loads
 * fine headless. The CLI never prints the browser's CORS advice.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { assessFileSize } from '../core/ingest/guardrails';
import { openWorkbook } from '../core/ingest/excel';
import { sniffFormat } from '../core/ingest/sniff';
import { fetchArtifact } from '../core/share/fetchArtifact';
import { QuacCliError } from './errors';
import type { IngestFormat } from '../core/ingest/sniff';
import type { FetchJson, IntakeEntry } from '../core/schema/types';

export interface DatasetInput {
  path: string;
  /** The file's basename — what the report and its filename are named for. */
  name: string;
  bytes: ArrayBuffer;
  format: IngestFormat;
  /** ingestion.md §5: ≥ 100 MB is slow but allowed; > 500 MB already threw. */
  sizeVerdict: 'ok' | 'warn';
  /**
   * The worksheet this run will read, resolved and verified — `null` for every
   * non-workbook format, which is how the CLI knows a `--sheet` was pointless.
   */
  sheet: string | null;
}

export interface RuleFileInput {
  path: string;
  name: string;
  text: string;
}

/** Schema paths are one kind or the other, never both — see `readSchemaEntries`. */
export interface SchemaIntake {
  origin: 'upload' | 'url';
  entries: IntakeEntry[];
}

const URL_LIKE = /^https?:\/\//i;
/** Parity with `fetchArtifact`'s default — no request may hang a pipeline. */
const FETCH_TIMEOUT_MS = 30_000;

const isUrl = (value: string): boolean => URL_LIKE.test(value);

/**
 * The `FetchJson` port over Node's global fetch. Deliberately shaped exactly
 * like `browserFetchJson` — including throwing an `Error` carrying `status` —
 * because `buildSchemaSet` hands this to the `$ref` crawler, which reads that
 * field to choose between the two E_FETCH messages (`ref-graph.ts:221-227`).
 * The one addition is the timeout the browser gets from `fetchArtifact`.
 */
export const nodeFetchJson: FetchJson = async (url) => {
  const response = await fetch(url, {
    headers: { Accept: 'application/schema+json, application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${String(response.status)} for ${url}`), {
      status: response.status,
    });
  }
  return { finalUrl: response.url === '' ? url : response.url, text: await response.text() };
};

/** §8: the dataset is a local path. Say so once, plainly. */
function refuseDatasetUrl(value: string): void {
  if (isUrl(value)) {
    throw new QuacCliError(
      'usage',
      'The dataset must be a local file — QuaC does not fetch it for you. ' +
        'Download it first (--schema and --rules do accept URLs).',
      { detail: [value] },
    );
  }
}

/**
 * Node Buffer → a standalone ArrayBuffer. Buffers are views into a shared
 * pool, so the bytes must be copied out, not aliased — and `.buffer` is typed
 * `ArrayBufferLike`, which `ingestDataset` will not take.
 */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

async function readOrFail(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    throw new QuacCliError('input', `Could not read the ${what} '${path}'.`, { cause: err });
  }
}

/**
 * A workbook with more than one sheet is the CLI's SheetPickerModal: a
 * pipeline must not guess which sheet was meant, so both the missing and the
 * unknown `--sheet` refuse with the workbook's own sheet names attached.
 */
async function resolveSheet(
  bytes: ArrayBuffer,
  path: string,
  requested: string | undefined,
): Promise<string> {
  const workbook = await openWorkbook(bytes);
  const names = workbook.sheetNames;
  const first = names[0];
  if (first === undefined) {
    throw new QuacCliError('input', `'${path}' contains no worksheets.`);
  }
  if (requested === undefined) {
    if (names.length > 1) {
      throw new QuacCliError(
        'input',
        `'${path}' has ${String(names.length)} worksheets — name one with --sheet.`,
        { detail: names },
      );
    }
    return first;
  }
  if (!names.includes(requested)) {
    throw new QuacCliError('input', `'${path}' has no worksheet named '${requested}'.`, {
      detail: names,
    });
  }
  return requested;
}

export async function readDatasetInput(path: string, sheet?: string): Promise<DatasetInput> {
  refuseDatasetUrl(path);
  const buffer = await readOrFail(path, 'dataset');
  // Guardrails before anything is parsed, exactly as the browser gates the drop.
  const sizeVerdict = assessFileSize(buffer.byteLength);
  const name = basename(path);
  const bytes = toArrayBuffer(buffer);
  const format = sniffFormat(name, new Uint8Array(buffer));
  return {
    path,
    name,
    bytes,
    format,
    sizeVerdict,
    sheet: format === 'xlsx' ? await resolveSheet(bytes, path, sheet) : null,
  };
}

/**
 * A directory becomes the browser's folder drop: EVERY file, recursively, no
 * extension filter (a manifest's ordering hints and graceful `not-json`
 * ignores both depend on that), dotfiles skipped, `relativePath` POSIX and
 * relative to the directory — so `stripCommonRoot` behaves identically and the
 * resulting `setId` matches the browser's for the same tree. A plain file
 * becomes a one-entry set named by its basename.
 *
 * Local entries are sorted by `relativePath` so a run is reproducible
 * regardless of the filesystem's directory order; URL entries keep argument
 * order, as `loadSchemaUrls` does.
 *
 * SAME-KIND RULE (§8): `BuildOptions.origin` is a single `'upload' | 'url'`,
 * so a set cannot be half local and half fetched — mixing them is a usage
 * error rather than a silently mis-based ref graph.
 */
export async function readSchemaEntries(paths: readonly string[]): Promise<SchemaIntake> {
  const urls = paths.filter(isUrl);
  if (urls.length > 0 && urls.length < paths.length) {
    throw new QuacCliError(
      'usage',
      'Every --schema value must be either a local path or a URL, not a mix — ' +
        'a schema set resolves its $refs against one kind of base.',
      { detail: [...paths] },
    );
  }
  if (urls.length > 0) return { origin: 'url', entries: await fetchSchemaEntries(urls) };
  return { origin: 'upload', entries: await readLocalSchemaEntries(paths) };
}

/** Mirrors `loadSchemaUrls`: the post-redirect URL is both id and ref base. */
async function fetchSchemaEntries(urls: readonly string[]): Promise<IntakeEntry[]> {
  const entries: IntakeEntry[] = [];
  for (const url of urls) {
    let fetched: { finalUrl: string; text: string };
    try {
      fetched = await nodeFetchJson(url);
    } catch (err) {
      throw new QuacCliError('input', `Could not fetch the schema '${url}'.`, { cause: err });
    }
    entries.push({ relativePath: fetched.finalUrl, raw: fetched.text, retrievalUri: fetched.finalUrl });
  }
  return entries;
}

async function readLocalSchemaEntries(paths: readonly string[]): Promise<IntakeEntry[]> {
  const entries: IntakeEntry[] = [];
  for (const path of paths) {
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(path)).isDirectory();
    } catch (err) {
      throw new QuacCliError('input', `Could not read the schema path '${path}'.`, { cause: err });
    }
    if (!isDirectory) {
      entries.push({ relativePath: basename(path), raw: (await readOrFail(path, 'schema file')).toString('utf8') });
      continue;
    }
    const dirents = await readdir(path, { recursive: true, withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isFile() || dirent.name.startsWith('.')) continue;
      const full = join(dirent.parentPath, dirent.name);
      entries.push({
        relativePath: relative(path, full).split(sep).join('/'),
        raw: (await readOrFail(full, 'schema file')).toString('utf8'),
      });
    }
  }
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

/**
 * Rules files in ARGUMENT ORDER — which is load order, which is the cross-file
 * correction order (qc-rules-engine.md §3). Never sorted, and URLs and local
 * paths may be freely mixed: each file stands alone, so unlike a schema set
 * there is no shared base to keep consistent.
 */
export async function readRuleFiles(paths: readonly string[]): Promise<RuleFileInput[]> {
  const files: RuleFileInput[] = [];
  for (const path of paths) {
    files.push(isUrl(path) ? await fetchRuleFile(path) : await readLocalRuleFile(path));
  }
  return files;
}

async function fetchRuleFile(url: string): Promise<RuleFileInput> {
  try {
    const { bytes, filename } = await fetchArtifact(url, { timeoutMs: FETCH_TIMEOUT_MS });
    return { path: url, name: filename, text: new TextDecoder().decode(bytes) };
  } catch (err) {
    // Never the CORS hint fetchArtifact attaches — that advice is browser-only.
    throw new QuacCliError('input', `Could not fetch the QC rules file '${url}'.`, { cause: err });
  }
}

async function readLocalRuleFile(path: string): Promise<RuleFileInput> {
  return {
    path,
    name: basename(path),
    text: (await readOrFail(path, 'rules file')).toString('utf8'),
  };
}
