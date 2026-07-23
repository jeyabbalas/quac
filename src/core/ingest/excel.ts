/**
 * Excel intake via SheetJS CE (lazy chunk — the CDN-tarball `xlsx` dep never
 * enters the entry bundle). Sheet choice happens in the UI (SheetPickerModal,
 * Sheet 1 preselected); conversion is sheet_to_csv into the CSV route.
 *
 * Serial-date caveat (ingestion.md §2): with {cellDates:true} SheetJS maps
 * date cells to JS Dates and sheet_to_csv renders them as locale-independent
 * strings, but cells stored as raw serials or preformatted text pass through
 * as-is. QuaC does not normalize here — schema casting (P09) and rules handle
 * whatever the workbook actually contained.
 */
import { IngestError } from './errors';

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
    sheetToCsv: (name) => XLSX.utils.sheet_to_csv(sheet(name)),
    rowCount: (name) => {
      const ref = sheet(name)['!ref'];
      if (!ref) return 0;
      const range = XLSX.utils.decode_range(ref);
      return range.e.r; // rows minus the header row
    },
  };
}
