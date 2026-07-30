/**
 * Reading the three inputs off the local filesystem (headless.md §8), the
 * headless counterpart of the browser's drop zones.
 *
 * SCOPE: local paths and directories. URL intake — plus the multi-sheet
 * `--sheet` refusal and the ambiguous-root candidate listing — is P21's
 * (`phase-21-headless-cli.md` task 2), where the CLI tier's `node:http`
 * fixture server can exercise it. A URL passed here is refused by name rather
 * than half-handled.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { assessFileSize } from '../core/ingest/guardrails';
import { sniffFormat } from '../core/ingest/sniff';
import { QuacCliError } from './errors';
import type { IngestFormat } from '../core/ingest/sniff';
import type { IntakeEntry } from '../core/schema/types';

export interface DatasetInput {
  path: string;
  /** The file's basename — what the report and its filename are named for. */
  name: string;
  bytes: ArrayBuffer;
  format: IngestFormat;
  /** ingestion.md §5: ≥ 100 MB is slow but allowed; > 500 MB already threw. */
  sizeVerdict: 'ok' | 'warn';
}

export interface RuleFileInput {
  path: string;
  name: string;
  text: string;
}

const URL_LIKE = /^https?:\/\//i;

/** P21 owns URL intake; refuse by name rather than fail obscurely later. */
function refuseUrl(value: string, flag: string): void {
  if (URL_LIKE.test(value)) {
    throw new QuacCliError(
      'usage',
      `${flag} does not accept URLs yet — pass a local path. ` +
        'Download the file first, or use the browser app for URL-hosted inputs.',
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

export async function readDatasetInput(path: string): Promise<DatasetInput> {
  refuseUrl(path, 'The dataset argument');
  const buffer = await readOrFail(path, 'dataset');
  // Guardrails before anything is parsed, exactly as the browser gates the drop.
  const sizeVerdict = assessFileSize(buffer.byteLength);
  const name = basename(path);
  return {
    path,
    name,
    bytes: toArrayBuffer(buffer),
    format: sniffFormat(name, new Uint8Array(buffer)),
    sizeVerdict,
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
 * Entries are sorted by `relativePath` so a run is reproducible regardless of
 * the filesystem's directory order.
 */
export async function readSchemaEntries(paths: readonly string[]): Promise<IntakeEntry[]> {
  const entries: IntakeEntry[] = [];
  for (const path of paths) {
    refuseUrl(path, '--schema');
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
 * correction order (qc-rules-engine.md §3). Never sorted.
 */
export async function readRuleFiles(paths: readonly string[]): Promise<RuleFileInput[]> {
  const files: RuleFileInput[] = [];
  for (const path of paths) {
    refuseUrl(path, '--rules');
    files.push({
      path,
      name: basename(path),
      text: (await readOrFail(path, 'rules file')).toString('utf8'),
    });
  }
  return files;
}
