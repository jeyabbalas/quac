/**
 * `runQuac()` — the whole QC pipeline under Node (headless.md §4).
 *
 * Every seam this uses already existed for the browser; the headless side just
 * supplies Node implementations:
 *
 *   bridge                → headless/nodeBridge.ts   (over @duckdb/node-api)
 *   executors.harden      → headless/harden.ts
 *   executors.exportDisplay → stubbed (no grid to feed)
 *   createWorker          → headless/validationWorker.ts (in-process Ajv engine)
 *   present               → no-op
 *
 * The one piece with no browser counterpart at this layer is step 3, the
 * typed-sync mirror. `src/app/typedSync.ts` does it reactively when a schema
 * and a dataset are both present; here it is a straight line, and it is
 * load-bearing: without it the rules lint dry-runs against the all-VARCHAR
 * copy and DuckDB's binder refuses every arithmetic rule (V23) — 12 of the 22
 * HESP rules silently excluded from the run.
 *
 * SCOPE (phase-20): no argv, no stdout, no exit codes, no summary JSON — this
 * function throws `QuacCliError` and P21's `main()` translates. `RunQuacResult`
 * carries the resolved inputs so P21's §7 summary is pure assembly.
 */
import { stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { APP_VERSION } from '../app/version';
import { QUAC_TYPED, refreshDataView, reportRowsSQL, swapWorkTable } from '../core/bridge/tables';
import { ingestDataset } from '../core/ingest/ingest';
import { runPipeline } from '../core/pipeline';
import { ANNOTATION_CAP } from '../core/report/annotations';
import { writeReportWorkbook } from '../core/report/excelWriter';
import { buildReportModel } from '../core/report/reportModel';
import { FLAG_CAP_DEFAULT } from '../core/flags/flagStore';
import { createBridgeRunner } from '../core/rules/engine';
import { executableRuleFile } from '../core/rules/executable';
import { lintRuleFilesWithDataset } from '../core/rules/lint';
import { parseRuleFile } from '../core/rules/parse';
import { loadJSSandbox } from '../core/rules/sandbox-loader';
import { crossCheckInputs } from '../core/pertinence';
import { applyCastPlan, buildCastPlan, describeColumns } from '../core/schema/casting';
import { columnDigest } from '../core/schema/column-meta';
import { buildSchemaSet } from '../core/schema/schema-set';
import { runSchemaValidation } from '../core/schema/validation-run';
import { QuacCliError } from './errors';
import { nodeHarden } from './harden';
import { nodeFetchJson, readDatasetInput, readRuleFiles, readSchemaEntries } from './intake';
import { createNodeBridge } from './nodeBridge';
import { createInProcessValidationWorker } from './validationWorker';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import type { IngestFormat } from '../core/ingest/sniff';
import type { CrossCheck } from '../core/pertinence';
import type { RunArtifacts, RunProgress, RunStage } from '../core/pipeline';
import type { ReportDataRow, ReportRowSource } from '../core/report/excelWriter';
import type { ReportModel, RunInfoInput } from '../core/report/reportModel';
import type { ParsedRuleFile } from '../core/rules/parse';
import type { RuleFile, RuleFileLintResult } from '../core/rules/types';
import type { ColumnDigest } from '../core/schema/column-meta';
import type { SchemaSet } from '../core/schema/types';

/** Report rows are paged out of DuckDB, exactly as the browser export does. */
const CHUNK_ROWS = 10_000;
const STAGE_ORDER: readonly RunStage[] = ['prepare', 'corrections', 'schema', 'rules', 'annotate'];

export interface RunQuacOptions {
  /** Path to the dataset file (csv/tsv/json/xlsx/parquet). */
  dataset: string;
  /** Schema files and/or directories; a directory is walked like a folder drop. */
  schema?: readonly string[];
  /** Rules files. Argument order is load order is cross-file correction order. */
  rules?: readonly string[];
  /** §A.4 index id, when the set's root would otherwise be ambiguous. */
  index?: string;
  /** Worksheet name for xlsx datasets; defaults to the first sheet. */
  sheet?: string;
  /** Output .xlsx path, or a directory to write the default name into. */
  out?: string;
  /** Default true, mirroring the app's toggle. */
  applyCorrections?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
}

export interface RunQuacDatasetInfo {
  path: string;
  name: string;
  format: IngestFormat;
  /** The worksheet actually read (verified against the workbook), else null. */
  sheet: string | null;
  rows: number;
  columns: number;
  /** ingestion.md §5 — 'warn' means large-but-allowed. */
  sizeVerdict: 'ok' | 'warn';
}

export interface RunQuacResult {
  /** Absolute path of the written workbook. */
  outPath: string;
  artifacts: RunArtifacts;
  model: ReportModel;
  /**
   * The inputs as resolved. P21's §7 summary is assembled from this plus
   * `artifacts` — nothing is re-derived, and nothing here is computed for the
   * summary's sake alone.
   */
  inputs: {
    dataset: RunQuacDatasetInfo;
    schema: { set: SchemaSet; digest: ColumnDigest } | null;
    /** Lint results for EVERY rules file, in argument order (not filtered). */
    rules: RuleFileLintResult[];
    applyCorrections: boolean;
    /**
     * Do the inputs look like they describe the same data
     * (`json-schema-subsystem.md` §E.5)? Computed here because this is the only
     * place holding all three column lists at once. With a single check source
     * `edges` is short and `suspect` stays null — triangulation needs all three.
     */
    pertinence: CrossCheck;
  };
}

/**
 * Schema-set intake + root resolution (§4 step 2). Fatal load errors and an
 * unresolved root are refusals, not warnings: validating against a set we
 * could not assemble would report the wrong thing.
 */
async function resolveSchema(
  paths: readonly string[],
  index: string | undefined,
): Promise<{ set: SchemaSet; digest: ColumnDigest } | null> {
  if (paths.length === 0) return null;
  const { origin, entries } = await readSchemaEntries(paths);
  const set = await buildSchemaSet(entries, {
    origin,
    // The crawler needs the port to follow transitive `$ref`s off the network;
    // a local set has nothing to fetch and passes none (as the browser does).
    ...(origin === 'url' ? { fetchJson: nodeFetchJson } : {}),
    ...(index === undefined ? {} : { indexParam: index }),
  });

  const fatal = set.errors.filter((e) => e.severity === 'fatal');
  if (fatal.length > 0) {
    throw new QuacCliError('schema', 'The JSON Schema set could not be loaded.', {
      detail: fatal.map((e) => e.message),
    });
  }
  if (set.root.rootFileId === undefined) {
    // §A.4: the caller names the root by its shareable id. The candidate list
    // is what P21 prints so a second invocation can succeed.
    throw new QuacCliError(
      'schema',
      set.root.candidates.length > 1
        ? 'Several schema files could be the root — name one with --index.'
        : 'No root schema file could be identified in this set.',
      {
        detail: set.root.candidates.map((c) =>
          [c.fileId, c.declaredId, c.title].filter((v) => v !== undefined && v !== '').join(' · '),
        ),
      },
    );
  }
  const digest = columnDigest(set);
  if (digest === null) {
    throw new QuacCliError('schema', 'The JSON Schema set produced no column information.');
  }
  return { set, digest };
}

/**
 * §4 step 3 — the typed-sync mirror (`src/app/typedSync.ts` without signals).
 * Runs BEFORE the rules lint so its EXPLAIN dry-runs see the column types the
 * run will see.
 */
async function syncTypedTables(
  bridge: WorkerBridge,
  digest: ColumnDigest,
  datasetColumns: readonly string[],
): Promise<void> {
  const rawTypes = await describeColumns(bridge);
  const plan = buildCastPlan(digest.meta, datasetColumns, rawTypes);
  await applyCastPlan(bridge, plan);
  await swapWorkTable(bridge, `SELECT * FROM ${QUAC_TYPED}`);
  await refreshDataView(bridge);
}

/**
 * Distinct target columns of the rules that will actually run — the third
 * vertex of the §E.5 triangle. Target-less rules (dataset scope, external) are
 * skipped: they name nothing to compare the dataset against.
 */
function executableTargets(files: readonly RuleFile[]): string[] {
  const targets = new Set<string>();
  for (const file of files) {
    for (const rule of file.rules) {
      if (!rule.enabled || rule.ruleType === 'external') continue;
      for (const target of rule.targetVariables) targets.add(target);
    }
  }
  return [...targets];
}

/** QuickJS loads only when the run will actually execute a js correction. */
const needsJsSandbox = (files: readonly RuleFile[], applyCorrections: boolean): boolean =>
  applyCorrections &&
  files.some((f) =>
    f.rules.some((r) => r.enabled && r.ruleType === 'correct' && r.updateLanguage === 'js'),
  );

/** Page `data` by __row__, clearing the SELECT cache after every chunk. */
function pageRows(bridge: WorkerBridge, rowLimit: number): ReportRowSource {
  return async function* stream(signal?: AbortSignal) {
    for (let offset = 0; offset < rowLimit; offset += CHUNK_ROWS) {
      if (signal?.aborted === true) throw new Error('Report export cancelled');
      const limit = Math.min(CHUNK_ROWS, rowLimit - offset);
      const rows = await bridge.query(reportRowsSQL(offset, limit), signal);
      bridge.clearQueryCache();
      yield rows.map<ReportDataRow>((r) => ({ row: Number(r.__row__), values: r }));
    }
  };
}

/** `out` may name a file or an existing directory; absent means cwd. */
async function resolveOutPath(out: string | undefined, filename: string): Promise<string> {
  if (out === undefined) return resolve(process.cwd(), filename);
  const target = isAbsolute(out) ? out : resolve(process.cwd(), out);
  try {
    if ((await stat(target)).isDirectory()) return join(target, filename);
  } catch {
    // Not there yet — treat it as the file to create.
  }
  return target;
}

/**
 * Ingest → schema validation → rules + corrections → Excel report, on Node.
 * Resolves with the written path and everything a caller needs to report on
 * the run; rejects with `QuacCliError` for anything a user can fix.
 */
export async function runQuac(options: RunQuacOptions): Promise<RunQuacResult> {
  const applyCorrections = options.applyCorrections ?? true;
  const schemaPaths = options.schema ?? [];
  const rulePaths = options.rules ?? [];

  // Read every input before opening a database: a typo in a path should not
  // cost a DuckDB instance, and the refusals below are cheaper to reach.
  const dataset = await readDatasetInput(options.dataset, options.sheet);
  const ruleInputs = await readRuleFiles(rulePaths);
  if (schemaPaths.length === 0 && ruleInputs.length === 0) {
    throw new QuacCliError(
      'usage',
      'Provide a JSON Schema (--schema) or a QC rules file (--rules) — either is enough.',
    );
  }

  const { bridge, close } = await createNodeBridge();
  try {
    // ---- 1. Ingest ----
    const ingest = await ingestDataset(bridge, {
      name: dataset.name,
      bytes: dataset.bytes,
      format: dataset.format,
      // Already resolved and verified against the workbook by the intake.
      ...(dataset.sheet === null ? {} : { sheetName: dataset.sheet }),
    });

    // ---- 2. Schema ----
    const schema = await resolveSchema(schemaPaths, options.index);

    // ---- 3. Typed-sync mirror (before the lint — see the module doc) ----
    if (schema !== null) await syncTypedTables(bridge, schema.digest, ingest.columns);

    // ---- 4. Rules: lint, then split into what runs and what is merely reported ----
    const parsed: ParsedRuleFile[] = ruleInputs.map((f) => parseRuleFile(f.text, f.name));
    const lintResults = await lintRuleFilesWithDataset(
      parsed,
      { runner: createBridgeRunner(bridge), datasetColumns: ingest.columns },
      { loadSandbox: loadJSSandbox },
    );
    // Filtered → the pipeline; unfiltered → the report (reportExport parity:
    // a file whose rules were all lint-excluded still appears in Run Info).
    const ruleFiles: RuleFile[] = parsed.flatMap((p, i) => {
      const result = lintResults[i];
      if (result === undefined) return [];
      const file = executableRuleFile(p, result);
      return file === null ? [] : [file];
    });

    // ---- 5. Readiness parity with the app's run gate (runReadiness.ts) ----
    const executableRules = ruleFiles.reduce((n, f) => n + f.rules.length, 0);
    if (schema === null && executableRules === 0) {
      throw new QuacCliError(
        'usage',
        ruleInputs.length === 0
          ? 'Provide a JSON Schema (--schema) or a QC rules file (--rules) — either is enough.'
          : 'Every rule was excluded by lint errors, and no JSON Schema was provided — there is nothing to check.',
        { detail: lintResults.flatMap((r) => r.issues.map((i) => `${r.file}: ${i.message}`)) },
      );
    }

    // ---- 6. Sandbox (only when a js correction will actually run) ----
    const jsSandbox = needsJsSandbox(ruleFiles, applyCorrections) ? await loadJSSandbox() : null;

    // ---- 7. Pipeline ----
    const artifacts = await runPipeline({
      bridge,
      dataset: { name: dataset.name, columns: ingest.columns, rowCount: ingest.rowCount },
      schema,
      ruleFiles,
      applyCorrections,
      jsSandbox,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      // No grid, no display bytes: the annotate stage still builds its plans
      // (they are cheap and pure), and only `present` ever consumed them.
      present: async () => {
        /* headless */
      },
      executors: {
        harden: nodeHarden,
        exportDisplay: () => Promise.resolve(new Uint8Array(0)),
        runSchemaValidation: (deps) =>
          runSchemaValidation({ ...deps, createWorker: createInProcessValidationWorker }),
      },
    });

    // A cancelled run has no report to write (§6: exit 130 leaves no file).
    // The pipeline returns partial artifacts rather than throwing, so without
    // this the abort path would still emit a half-validated workbook.
    if (options.signal?.aborted === true || artifacts.cancelled) {
      throw new QuacCliError('run', 'The QC run was cancelled — no report was written.');
    }

    // ---- 8. Report (reportExport.ts parity, field for field) ----
    const root = schema?.set.files.find((f) => f.fileId === schema.set.root.rootFileId);
    const runInfo: RunInfoInput = {
      appVersion: APP_VERSION,
      runAt: new Date(),
      datasetName: dataset.name,
      datasetFormat: dataset.format,
      schemaFiles: schema?.set.schemas.map((f) => f.relativePath) ?? [],
      ...(root === undefined ? {} : { schemaRoot: root.relativePath }),
      ...(schema?.set.root.indexFileId === undefined
        ? {}
        : { schemaIndexId: schema.set.root.indexFileId }),
      ruleFileSummaries: parsed.map((p) => ({ name: p.file.name, ruleCount: p.file.rules.length })),
      durations: STAGE_ORDER.flatMap((stage) => {
        const ms = artifacts.durations[stage];
        return ms === undefined ? [] : [{ stage, ms }];
      }),
      correctionsApplied: artifacts.correctionsApplied,
      caps: [
        { label: 'Flags materialized', value: FLAG_CAP_DEFAULT.toLocaleString('en-US') },
        { label: 'Cell annotations painted', value: ANNOTATION_CAP.toLocaleString('en-US') },
      ],
      stageErrors: artifacts.stageErrors.map((e) => ({ stage: e.stage, message: e.message })),
    };

    const model = buildReportModel({
      flagStore: artifacts.flagStore,
      datasetColumns: ingest.columns,
      rowCount: ingest.rowCount,
      columnMeta: schema?.digest.meta ?? null,
      ruleFiles: parsed.map((p) => p.file),
      rules: artifacts.rules,
      schema: artifacts.schema,
      runInfo,
    });

    const outPath = await resolveOutPath(options.out, model.filename);
    try {
      const blob = await writeReportWorkbook(model, pageRows(bridge, model.data.rowLimit), {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(outPath, Buffer.from(await blob.arrayBuffer()));
    } catch (err) {
      throw new QuacCliError('report', `Could not write the QC report to '${outPath}'.`, {
        cause: err,
      });
    }

    return {
      outPath,
      artifacts,
      model,
      inputs: {
        dataset: {
          path: dataset.path,
          name: dataset.name,
          format: dataset.format,
          sheet: dataset.sheet,
          rows: ingest.rowCount,
          columns: ingest.columns.length,
          sizeVerdict: dataset.sizeVerdict,
        },
        schema,
        rules: lintResults,
        applyCorrections,
        pertinence: crossCheckInputs({
          datasetColumns: ingest.columns,
          ...(schema === null
            ? {}
            : {
                schemaColumns: schema.digest.meta.map((m) => ({
                  name: m.name,
                  required: m.required,
                })),
              }),
          ...(ruleFiles.length === 0 ? {} : { ruleTargets: executableTargets(ruleFiles) }),
        }),
      },
    };
  } finally {
    await close();
  }
}
