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
import type { ExecFileException } from 'node:child_process';
import type { AddressInfo, Server } from 'node:net';

export const REPO = resolve(__dirname, '..', '..');
export const BIN = join(REPO, 'dist-cli', 'quac.mjs');
export const FIXTURES = join(REPO, 'tests', 'fixtures');
export const HESP_DATA = join(FIXTURES, 'hesp', 'data');
export const HESP_SCHEMA_DIR = join(FIXTURES, 'hesp', 'json_schema');
export const HESP_RULES = ['hesp_keys_and_structure', 'hesp_consistency', 'hesp_corrections'].map(
  (name) => join(FIXTURES, 'hesp', 'rules', `${name}.quac.csv`),
);
export const TINY = join(FIXTURES, 'tiny');
export const TWO_ROOTS = join(FIXTURES, 'synthetic', 'two-roots');

export interface CliRun {
  /**
   * The status the child EXITED with. A child that never exited does not
   * produce a `CliRun` at all — see `runNode`.
   */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the built binary and resolve with its exit code — a nonzero exit is the
 * POINT of half these tests, so a nonzero exit must not reject.
 *
 * A child that never exited is a different thing, and it does reject. That
 * case used to collapse into `code: 1`, which is also QuaC's own usage code:
 * a process the runner killed was indistinguishable from the CLI refusing its
 * arguments, and surfaced as whatever the next assertion happened to say —
 * `expected 1 to be +0` in CI run 33587976816, reported against a test that
 * parses no arguments wrongly at all. Nothing here interrupts a child on
 * purpose (130 is an open gap; see the exitCodes.test.ts header), so "no exit
 * code" is always an environment or harness failure and never a result under
 * test, which is what makes rejecting the safe reading as well as the useful
 * one.
 *
 * `stdio` is piped, so `process.stderr.isTTY` is false inside: the CLI prints
 * one line per stage instead of rewriting one in place, which is also the
 * shape a CI log gets. The TTY branch is unit-tier territory.
 */
export function quac(args: readonly string[], cwd = REPO): Promise<CliRun> {
  return runNode([BIN, ...args], cwd);
}

/**
 * The spawn `quac()` is a thin wrapper over, with the argv left open.
 *
 * Exported for one reason: a rejection nothing exercises is a rejection nobody
 * can trust, and the only honest way to exercise this one is a child that
 * really dies. Pointing `quac()` at the real binary and waiting for a runner
 * to kill it is not a test. See support.test.ts.
 */
export function runNode(argv: readonly string[], cwd = REPO): Promise<CliRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [...argv],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // `err.code` carries the exit status ONLY when it is a number. Node
        // puts a string errno there for a spawn failure (`ENOENT`) and for a
        // maxBuffer overflow (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), and for a
        // signal it puts nothing there at all, naming the signal instead. So
        // `typeof === 'number'` is precisely the question "did this exit?" —
        // which is why it decides between the two outcomes rather than
        // choosing a fallback number.
        if (err === null) {
          resolvePromise({ code: 0, stdout, stderr });
        } else if (typeof err.code === 'number') {
          resolvePromise({ code: err.code, stdout, stderr });
        } else {
          rejectPromise(new Error(neverExited(err, argv, stderr)));
        }
      },
    );
  });
}

/**
 * The message that rejection carries. It has to name the cause by itself: the
 * failure being fixed here was one that read convincingly as something else,
 * so the child's cause of death and its last words both belong in the text a
 * CI log will show.
 */
function neverExited(err: ExecFileException, argv: readonly string[], stderr: string): string {
  const cause = [
    err.signal == null ? null : `signal ${err.signal}`,
    typeof err.code === 'string' ? err.code : null,
    err.killed === true ? 'killed' : null,
  ].filter((bit): bit is string => bit !== null);
  const tail = stderr.trim().split('\n').slice(-5).join('\n');
  return [
    `child process never exited (${cause.length > 0 ? cause.join(' · ') : err.message}).`,
    'That is an environment or harness failure, not an exit code under test.',
    `argv: ${argv.join(' ')}`,
    tail === '' ? 'stderr was empty.' : `last stderr:\n${tail}`,
  ].join('\n');
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
