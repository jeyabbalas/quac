/**
 * `types/quac.d.ts` is hand-written — the repo is `noEmit`, so nothing
 * generates it and nothing would notice it going stale. This is the noticer:
 * every row of `TYPE_CHECKS` below is verified by `npm run typecheck`, and a
 * field added, removed or retyped on either side makes `true` stop being
 * assignable to its slot.
 *
 * Direction matters, so the data shapes are asserted BOTH ways:
 *   declared → real   an object a caller writes against the published types
 *                     must be accepted by the implementation
 *   real → declared   everything the implementation produces must be
 *                     describable by the published types
 *
 * `RunQuacResult.artifacts`, `.model` and three `inputs` members are `unknown`
 * in the published types on purpose — deep pipeline structures QuaC does not
 * want to owe compatibility on. `unknown` accepts anything but satisfies
 * nothing, so those are checkable only real → declared. That asymmetry is why
 * `RunQuacResult` appears once here and not twice.
 */
import { describe, expect, it } from 'vitest';
import { SUMMARY_SCHEMA_VERSION, buildSummary } from '../../../src/cli/summary';
import { runQuac } from '../../../src/headless/run';
import { QuacCliError } from '../../../src/headless/errors';
import type * as Declared from '../../../types/quac';
import type { SummaryContext, SummaryJson } from '../../../src/cli/summary';
import type { RunQuacDatasetInfo, RunQuacOptions, RunQuacResult } from '../../../src/headless/run';
import type { QuacErrorKind } from '../../../src/headless/errors';
import type { RunProgress } from '../../../src/core/pipeline';

/**
 * `true` when A is assignable to B, otherwise a shape `true` cannot satisfy —
 * so the failure is a compile error naming both sides. The `[A] extends [B]`
 * tuple wrapping suppresses distribution, without which a union like
 * `QuacErrorKind` would pass on any single matching member.
 */
type Assignable<A, B> = [A] extends [B] ? true : { NOT_ASSIGNABLE: [A, B] };

const TYPE_CHECKS: [
  // what a caller writes
  Assignable<Declared.RunQuacOptions, RunQuacOptions>,
  Assignable<RunQuacOptions, Declared.RunQuacOptions>,
  Assignable<Declared.RunQuacOptions, Parameters<typeof Declared.runQuac>[0]>,
  Assignable<Parameters<typeof runQuac>[0], RunQuacOptions>,
  Assignable<Declared.RunProgress, RunProgress>,
  Assignable<RunProgress, Declared.RunProgress>,
  // what a run returns
  Assignable<RunQuacResult, Declared.RunQuacResult>,
  Assignable<Awaited<ReturnType<typeof runQuac>>, Declared.RunQuacResult>,
  Assignable<Declared.RunQuacDatasetInfo, RunQuacDatasetInfo>,
  Assignable<RunQuacDatasetInfo, Declared.RunQuacDatasetInfo>,
  // the JSON scripts parse
  Assignable<Declared.SummaryJson, SummaryJson>,
  Assignable<SummaryJson, Declared.SummaryJson>,
  Assignable<ReturnType<typeof buildSummary>, Declared.SummaryJson>,
  Assignable<Declared.SummaryContext, SummaryContext>,
  Assignable<SummaryContext, Declared.SummaryContext>,
  // the refusal kinds an exit code is derived from
  Assignable<Declared.QuacErrorKind, QuacErrorKind>,
  Assignable<QuacErrorKind, Declared.QuacErrorKind>,
] = [
  true, true, true, true, true, true,
  true, true, true, true,
  true, true, true, true, true,
  true, true,
];

describe('public type surface', () => {
  it('matches the implementation, field for field', () => {
    // The assertion is the annotation above; this pins the count so a check
    // cannot be deleted along with its row and leave the suite still green.
    // (There is nothing to assert at runtime: the compiler already proved
    // every element is `true`, which is exactly what makes this a guard.)
    expect(TYPE_CHECKS).toHaveLength(17);
  });

  it('declares the runtime values the package exports', () => {
    const version: typeof Declared.SUMMARY_SCHEMA_VERSION = SUMMARY_SCHEMA_VERSION;
    expect(version).toBe(1);
    expect(typeof runQuac).toBe('function');
    expect(typeof buildSummary).toBe('function');

    const declaredErr: Declared.QuacCliError = new QuacCliError('usage', 'x', { detail: ['y'] });
    expect(declaredErr.kind).toBe('usage');
    expect(declaredErr.detail).toEqual(['y']);
    expect(declaredErr).toBeInstanceOf(Error);
  });
});
