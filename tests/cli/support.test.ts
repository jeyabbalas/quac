/**
 * The CLI tier's own plumbing, tested. `support.ts`'s `runNode` decides
 * whether a child exited or died, and every exit-code assertion in this
 * project — the public contract a pipeline branches on — is downstream of
 * that one decision.
 *
 * It is tested because it got the decision wrong. A child that never exited
 * resolved with `code: 1`, which is also QuaC's usage code, so a runner that
 * killed a process produced a report indistinguishable from the CLI refusing
 * its arguments: CI run 33587976816 failed as `expected 1 to be +0` against a
 * test whose arguments are fine, and the same suite passed on a re-run and
 * three times locally. These cases pin both halves of the distinction that
 * replaced it — a real exit still arrives as its number, and a death arrives
 * as a rejection that says so.
 */
import { describe, expect, it } from 'vitest';
import { runNode } from './support';

/** Node's own binary, driven with `-e`, is the only fixture any of this needs. */
const evaluate = (source: string): readonly string[] => ['-e', source];

describe('runNode — a child that exits', () => {
  it('resolves 0 for a clean exit', async () => {
    await expect(runNode(evaluate('process.exit(0)'))).resolves.toMatchObject({ code: 0 });
  });

  it('resolves the status for a nonzero exit, rather than rejecting', async () => {
    // A nonzero exit is the point of half this project, so it must resolve.
    await expect(runNode(evaluate('process.exit(6)'))).resolves.toMatchObject({ code: 6 });
  });

  it('resolves 1 for a real exit 1 — the code the old fallback collided with', async () => {
    // The other half of the fix: making death loud must not make QuaC's own
    // usage code unreachable. Exit 1 still means exit 1.
    await expect(runNode(evaluate('process.exit(1)'))).resolves.toMatchObject({ code: 1 });
  });

  it('carries stdout and stderr alongside the code', async () => {
    const run = await runNode(
      evaluate('process.stdout.write("out"); process.stderr.write("err"); process.exit(2)'),
    );
    expect(run).toMatchObject({ code: 2, stdout: 'out', stderr: 'err' });
  });
});

describe('runNode — a child that never exits', () => {
  it('rejects naming the signal, instead of resolving 1', async () => {
    // The regression itself. Resolving anything here is wrong, but resolving
    // 1 is wrong in the specific way that costs an afternoon.
    await expect(runNode(evaluate('process.kill(process.pid, "SIGKILL")'))).rejects.toThrow(
      /never exited \(signal SIGKILL\)/,
    );
  });

  it('rejects naming the errno when the spawn itself fails', async () => {
    // A cwd that does not exist is the cheapest real spawn failure; the old
    // helper reported this as exit 1 too.
    await expect(runNode(evaluate(''), '/quac-no-such-directory')).rejects.toThrow(
      /never exited \(ENOENT\)/,
    );
  });

  it("puts the child's last stderr in the message", async () => {
    // writeSync, not write: an async write to a pipe can lose the race with
    // SIGKILL, and a flaky test about flaky diagnosis helps nobody.
    await expect(
      runNode(
        evaluate(
          'require("node:fs").writeSync(2, "dying words\\n"); process.kill(process.pid, "SIGKILL")',
        ),
      ),
    ).rejects.toThrow(/dying words/);
  });

  it('says the failure is the harness, not an exit code under test', async () => {
    await expect(runNode(evaluate('process.kill(process.pid, "SIGKILL")'))).rejects.toThrow(
      /not an exit code under test/,
    );
  });
});
