/**
 * Excel intake via SheetJS CE (lazy chunk — the CDN-tarball `xlsx` dep never
 * enters the entry bundle). Sheet choice happens in the UI (SheetPickerModal,
 * Sheet 1 preselected); conversion is sheet_to_csv into the CSV route.
 *
 * A cell becomes the text of the value it HOLDS, not of how the sheet
 * displays it (ingestion.md §2): a number as its digits (`1234.5`, not
 * `1,234.50`; `0.125`, not `12.5%`), a date as ISO 8601 (`2024-01-15`, a
 * date-and-time `2024-01-15T08:30:00`, a time of day `08:30:00` — not the
 * locale's `1/15/24`), a boolean as `TRUE`/`FALSE`. Schema checks then read
 * the value; display formats are the sheet's business. Cells stored as text
 * stay the text they are.
 */
import { IngestError } from './errors';

/**
 * The ISO 8601 number format for a date cell: a date, a date and time, or a
 * time of day — by what its own format shows, and with the time whenever the
 * value has one (a sheet can show `1/15/24` for 08:30 that day). Quoted text
 * and `[…]` sections (`[$-409]`, `[h]`) say nothing about which.
 */
function isoFormat(displayFormat: string | undefined, hasTimeOfDay: boolean): string {
  const format = (displayFormat ?? '').toLowerCase().replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  const hasTime = hasTimeOfDay || /h|s|am\/pm|a\/p/.test(format);
  const hasDate = /y|d/.test(format) || !/h|s|am\/pm|a\/p/.test(format);
  if (hasTime && !hasDate) return 'hh:mm:ss';
  return hasTime ? 'yyyy-mm-dd"T"hh:mm:ss' : 'yyyy-mm-dd';
}

export interface Workbook {
  sheetNames: string[];
  sheetToCsv: (name: string) => string;
  rowCount: (name: string) => number;
}

export async function openWorkbook(bytes: ArrayBuffer): Promise<Workbook> {
  const XLSX = await import('xlsx');
  let wb: import('xlsx').WorkBook;
  try {
    wb = XLSX.read(bytes, { cellDates: true });
  } catch (cause) {
    throw new IngestError('INGEST_UNSUPPORTED', 'This file could not be read as an Excel workbook.', {
      cause,
    });
  }
  if (wb.SheetNames.length === 0) {
    throw new IngestError('INGEST_UNSUPPORTED', 'This workbook contains no sheets.');
  }
  const sheet = (name: string): import('xlsx').WorkSheet => {
    const ws = wb.Sheets[name];
    if (!ws) throw new IngestError('INGEST_UNSUPPORTED', `Sheet "${name}" not found in the workbook.`);
    return ws;
  };
  return {
    sheetNames: [...wb.SheetNames],
    sheetToCsv: (name) => {
      const ws = sheet(name);
      for (const address of Object.keys(ws)) {
        if (address.startsWith('!')) continue;
        const cell = ws[address] as import('xlsx').CellObject;
        if (cell.t === 'd') {
          const time = XLSX.utils.format_cell({ t: 'd', v: cell.v, z: 'hh:mm:ss' } as import('xlsx').CellObject);
          cell.z = isoFormat(typeof cell.z === 'string' ? cell.z : undefined, time !== '00:00:00');
          delete cell.w;
        }
      }
      return XLSX.utils.sheet_to_csv(ws, { rawNumbers: true });
    },
    rowCount: (name) => {
      const ref = sheet(name)['!ref'];
      if (!ref) return 0;
      const range = XLSX.utils.decode_range(ref);
      return range.e.r; // rows minus the header row
    },
  };
}
