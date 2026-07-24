/**
 * Shared browser-download trigger (P18): one anchor-click implementation for
 * every Blob the app hands the user (report workbook, config manifest, rules
 * CSV). Extracted verbatim from reportExport/shareModal's identical private
 * copies — behavior unchanged.
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the download has had time to start.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
