/**
 * The public library entry (headless.md §4) — what `import … from '@jeyabbalas/quac'`
 * resolves to, built to `dist-cli/index.mjs`.
 *
 * Deliberately small. `runQuac` does the work and returns everything it
 * learned; `buildSummary` turns that into the §7 JSON the CLI writes, so a
 * pipeline embedding QuaC in its own Node process gets the same machine-
 * readable record as one shelling out to `quac --summary -`.
 *
 * `buildSummary` lives under `src/cli/` because the summary is a reporting
 * artifact — it carries an exit code — and is re-exported here so callers need
 * one import, not two.
 */
export { runQuac } from './run';
export { QuacCliError } from './errors';
export { buildSummary, SUMMARY_SCHEMA_VERSION } from '../cli/summary';

export type { RunQuacOptions, RunQuacResult, RunQuacDatasetInfo } from './run';
export type { QuacErrorKind } from './errors';
export type { SummaryJson, SummaryContext } from '../cli/summary';
export type { RunArtifacts, RunProgress, RunStage } from '../core/pipeline';
export type { ReportModel } from '../core/report/reportModel';
