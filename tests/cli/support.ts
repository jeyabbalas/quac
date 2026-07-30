/**
 * Shared plumbing for the CLI tier (`testing-strategy.md` §1): everything here
 * black-boxes the BUILT `dist-cli/quac.mjs` that `pretest:cli` produces. No
 * module under `src/` is imported — if the build stopped emitting a working
 * binary, these tests must fail, and importing the source would hide that.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import process from 'node:process';
import type { AddressInfo, Server } from 'node:net';

export const REPO = resolve(__dirname, '..', '..');
export const BIN = join(REPO, 'dist-cli', 'quac.mjs');
export const FIXTURES = join(REPO, 'tests', 'fixtures');
export const HESP_DATA = join(FIXTURES, 'hesp', 'data');
export const HESP_SCHEMA_DIR = join(FIXTURES, 'hesp', 'json_schema');
export const HESP_RULES = [
  'hesp_keys_and_structure',
  'hesp_consistency',
  'hesp_corrections',
].map((name) => join(FIXTURES, 'hesp', 'rules', `${name}.quac.csv`));
export const TINY = join(FIXTURES, 'tiny');
export const TWO_ROOTS = join(FIXTURES, 'synthetic', 'two-roots');

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the binary and resolve with its exit code — a nonzero exit is the POINT
 * of half these tests, so it must not reject.
 *
 * `stdio` is piped, so `process.stderr.isTTY` is false inside: the CLI prints
 * one line per stage instead of rewriting one in place, which is also the
 * shape a CI log gets. The TTY branch is unit-tier territory.
 */
export function quac(args: readonly string[], cwd = REPO): Promise<CliRun> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // On a nonzero exit, execFile reports the status in `err.code` — a
        // number here, but a string errno for a spawn failure, which is a
        // different problem and surfaces as 1.
        const code: unknown = err === null ? 0 : (err as NodeJS.ErrnoException).code;
        resolvePromise({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      },
    );
  });
}

/**
 * This machine may be on Node 22 while CI is on Node 24, so the engines
 * warning is present in one and absent in the other. Tests strip it rather
 * than assert either way — asserting its absence would fail locally, and
 * asserting its presence would fail in CI.
 */
export function meaningfulStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !line.includes('tested on Node'))
    .join('\n');
}

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
};

export interface FixtureServer {
  /** `http://127.0.0.1:<port>` — an ephemeral port, so nothing can collide. */
  origin: string;
  close: () => Promise<void>;
}

/**
 * A static server over `tests/fixtures/`, for the URL-intake cases. No CORS
 * headers anywhere: CORS is a browser concept and headless intake neither
 * sends nor needs them (headless.md §8) — this server is the proof.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const target = join(FIXTURES, path);
    // Path traversal guard: refuse anything that climbs out of the fixtures.
    if (!target.startsWith(FIXTURES + sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    readFile(target).then(
      (bytes) => {
        const ext = target.slice(target.lastIndexOf('.'));
        res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
        res.end(bytes);
      },
      () => {
        res.writeHead(404);
        res.end('not found');
      },
    );
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((done, fail) => {
        server.close((err) => {
          if (err) fail(err);
          else done();
        });
      }),
  };
}
