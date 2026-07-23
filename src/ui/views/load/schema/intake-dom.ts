/**
 * DOM-tier intake: FileList / DataTransfer → IntakeEntry[]. Folder drops walk
 * the FileSystem entries API (readEntries batches ≤100 per call); synthetic
 * DataTransfers (tests) fall back to `dt.files`. Common-root stripping happens
 * in the loader, not here.
 */
import type { IntakeEntry } from '../../../../core/schema/types';

export async function entriesFromFileList(
  files: FileList | readonly File[],
): Promise<IntakeEntry[]> {
  return Promise.all(
    [...files].map(async (file) => ({
      relativePath: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
      raw: await file.text(),
    })),
  );
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: IntakeEntry[],
): Promise<void> {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    out.push({ relativePath: path, raw: await file.text() });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, path, out);
    }
  }
}

export async function entriesFromDataTransfer(dt: DataTransfer): Promise<IntakeEntry[]> {
  const fsEntries: FileSystemEntry[] = [];
  for (const item of [...dt.items]) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry !== null) fsEntries.push(entry);
  }
  if (fsEntries.length === 0) return entriesFromFileList(dt.files);
  const out: IntakeEntry[] = [];
  for (const entry of fsEntries) await walkEntry(entry, '', out);
  return out;
}
