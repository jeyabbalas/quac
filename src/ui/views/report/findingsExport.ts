/**
 * Findings export (qc-report-spec.md §7) — LAZY, like reportExport.ts: the
 * Summary panel's findings buttons import it on first click, so neither the
 * builder nor exceljs enters the entry chunk.
 *
 * Builds the findings without data from the same inputs the QC report export
 * reads — the run's artifacts and the module stores, which a run invalidation
 * keeps in step with them — renders the chosen format and downloads it. No
 * data crosses: `buildFindings` admits definitions and counts only.
 */
import { triggerDownload } from '../../components/download';
import { buildFindings, findingsFilename } from '../../../core/report/findings';
import { renderFindingsMarkdown } from '../../../core/report/findingsMarkdown';
import { writeFindingsWorkbook } from '../../../core/report/findingsWorkbook';
import { columnDigest } from '../../../core/schema/column-meta';
import { schemaState } from '../../../core/schema/schema-store';
import { rulesState } from '../../../core/rules/rules-store';
import { APP_VERSION } from '../../../app/version';
import type { ShellContext } from '../../../app/shell';
import type { RunDefinitions } from '../../../core/pipeline';
import type { FindingsFormat, QcFindings } from '../../../core/report/findings';

function liveDefinitions(): RunDefinitions {
  const schema = schemaState.get();
  const set = schema.phase === 'ready' ? schema.set : null;
  const digest = set === null ? null : columnDigest(set);
  const rules = rulesState.get();
  return {
    schema: set === null || digest === null ? null : { set, digest },
    ruleFiles: rules.files.map((parsed, i) => ({
      file: parsed.file,
      lint: rules.results.find((r) => r.file === parsed.file.name) ?? null,
      source: rules.sources[i] ?? null,
    })),
  };
}

/** The findings of the run on screen. */
export function collectFindings(ctx: ShellContext, at: Date = new Date()): QcFindings {
  const dataset = ctx.store.dataset.get();
  const artifacts = ctx.store.runArtifacts.get();
  if (dataset === null || artifacts === null) {
    throw new Error('Run QC before exporting the findings.');
  }
  // The definitions the run checked against (runController snapshots them);
  // the live stores only for artifacts that carry none.
  const definitions = artifacts.definitions ?? liveDefinitions();
  return buildFindings({
    generatedAt: at,
    quacVersion: APP_VERSION,
    dataset: {
      name: dataset.name,
      format: dataset.format,
      sheet: dataset.sheetName ?? null,
      columns: dataset.columns,
      records: dataset.rowCount,
    },
    schema: definitions.schema,
    ruleFiles: definitions.ruleFiles,
    correctionsApplied: artifacts.correctionsApplied,
    run: {
      cancelled: artifacts.cancelled,
      rules: artifacts.rules,
      schema: artifacts.schema,
      stageErrors: artifacts.stageErrors,
      rows: artifacts.flagStore,
    },
  });
}

const MIME: Record<Exclude<FindingsFormat, 'xlsx'>, string> = {
  markdown: 'text/markdown;charset=utf-8',
  json: 'application/json',
};

/** Build the findings in one format and download them. Rejects on failure. */
export async function runFindingsExport(ctx: ShellContext, format: FindingsFormat): Promise<void> {
  const at = new Date();
  const findings = collectFindings(ctx, at);
  const blob =
    format === 'xlsx'
      ? await writeFindingsWorkbook(findings)
      : new Blob(
          [
            format === 'json'
              ? `${JSON.stringify(findings, null, 2)}\n`
              : renderFindingsMarkdown(findings),
          ],
          { type: MIME[format] },
        );
  triggerDownload(blob, findingsFilename(findings.dataset.name, at, format));
}
