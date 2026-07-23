/**
 * Dataset ingest orchestration for the Load view — the lazy boundary between
 * the UI and the engine (bridge / data-table / papaparse / sheetjs never
 * enter the entry chunk; this module is import()ed on first user action).
 */
import { reportError } from '../../../app/errors';
import { showToast } from '../../../app/toast';
import { getBridge } from '../../../core/bridge/bridge';
import { assessFileSize, needsExcelTruncationNotice } from '../../../core/ingest/guardrails';
import { openWorkbook } from '../../../core/ingest/excel';
import { ingestDataset } from '../../../core/ingest/ingest';
import { sniffFormat } from '../../../core/ingest/sniff';
import { fetchArtifact } from '../../../core/share/fetchArtifact';
import { pickSheet } from '../../components/sheetPickerModal';
import type { ShellContext } from '../../../app/shell';
import type { IngestResult, IngestStage } from '../../../core/ingest/ingest';

export interface IngestUi {
  setProgress: (label: string, pct: number | null) => void;
  detailHost: HTMLElement;
}

const STAGE_LABELS: Record<IngestStage, string> = {
  reading: 'Reading file',
  parsing: 'Parsing',
  loading: 'Loading into DuckDB',
  preparing: 'Preparing tables',
};

export async function ingestFromFile(ctx: ShellContext, file: File, ui: IngestUi): Promise<void> {
  await runIngest(ctx, ui, file, file.name);
}

export async function ingestFromUrl(ctx: ShellContext, url: string, ui: IngestUi): Promise<void> {
  const slot = ctx.store.slots.data;
  const previous = slot.get();
  slot.set({ status: 'loading', detail: `Fetching ${url}` });
  ui.setProgress('Fetching', null);
  try {
    const { bytes, filename } = await fetchArtifact(url);
    await runIngest(ctx, ui, new Blob([bytes]), filename, previous);
  } catch (err) {
    reportError(err, { fallbackCode: 'FETCH_HTTP', slot });
  }
}

async function runIngest(
  ctx: ShellContext,
  ui: IngestUi,
  source: Blob,
  name: string,
  restoreState = ctx.store.slots.data.get(),
): Promise<void> {
  const slot = ctx.store.slots.data;
  try {
    const sizeVerdict = assessFileSize(source.size); // throws INGEST_TOO_LARGE
    if (sizeVerdict === 'warn') {
      showToast('This is a large file — loading may be slow.', {
        kind: 'info',
        hint: 'Parquet loads much faster than delimited text.',
      });
    }

    slot.set({ status: 'loading', detail: name });
    ui.setProgress(STAGE_LABELS.reading, null);
    const bytes = await source.arrayBuffer();
    const format = sniffFormat(name, new Uint8Array(bytes));

    let sheetName: string | undefined;
    if (format === 'xlsx') {
      const workbook = await openWorkbook(bytes);
      if (workbook.sheetNames.length > 1) {
        const chosen = await pickSheet(workbook.sheetNames);
        if (chosen === null) {
          slot.set(restoreState); // user cancelled — nothing changed
          return;
        }
        sheetName = chosen;
      }
    }

    const bridge = await getBridge();
    const input = sheetName === undefined ? { name, bytes, format } : { name, bytes, format, sheetName };
    const result = await ingestDataset(bridge, input, (stage, pct) => {
      ui.setProgress(STAGE_LABELS[stage], pct);
    });

    const previous = ctx.store.dataset.get();
    ctx.store.dataset.set({
      name,
      format,
      byteSize: source.size,
      rowCount: result.rowCount,
      columnCount: result.columnCount,
      columns: result.columns,
      renames: result.renames,
      parseWarnings: result.parseWarnings,
      source,
      ...(sheetName === undefined ? {} : { sheetName }),
      generation: (previous?.generation ?? 0) + 1,
    });

    renderDetails(ui.detailHost, result);
    const issueCount = result.renames.length + result.parseWarnings.length;
    const dims = `${String(result.rowCount)} rows × ${String(result.columnCount)} cols`;
    slot.set({
      status: issueCount > 0 ? 'warning' : 'valid',
      detail:
        issueCount > 0
          ? `${name} · ${dims} · ${String(issueCount)} warning${issueCount === 1 ? '' : 's'}`
          : `${name} · ${dims}`,
    });

    if (needsExcelTruncationNotice(result.rowCount)) {
      showToast('This dataset exceeds Excel’s row limit.', {
        kind: 'info',
        hint: 'The QC report’s data sheet will be truncated; findings still cover every row.',
      });
    }
  } catch (err) {
    reportError(err, { fallbackCode: 'INGEST_UNSUPPORTED', slot });
  }
}

function renderDetails(host: HTMLElement, result: IngestResult): void {
  host.replaceChildren();
  if (result.renames.length === 0 && result.parseWarnings.length === 0) return;
  const list = document.createElement('ul');
  list.className = 'q-slotcard-issues';
  for (const rename of result.renames) {
    const item = document.createElement('li');
    item.textContent = `column "${rename.from}" renamed to "${rename.to}" (${rename.reason})`;
    list.append(item);
  }
  for (const warning of result.parseWarnings) {
    const item = document.createElement('li');
    item.textContent = warning;
    list.append(item);
  }
  host.append(list);
}
