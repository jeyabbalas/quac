/**
 * Fixture plumbing for the schema unit tests: recursive directory reads into
 * IntakeEntry[] with POSIX relative paths, plus a one-liner entry factory.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntakeEntry } from '../../../src/core/schema/types';

export const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures', import.meta.url));

/** Read a fixture directory (recursively) as upload-style intake entries. */
export function entriesFromDir(absDir: string, prefix = ''): IntakeEntry[] {
  const entries: IntakeEntry[] = [];
  for (const item of readdirSync(absDir, { withFileTypes: true })) {
    const relativePath = prefix === '' ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory()) {
      entries.push(...entriesFromDir(join(absDir, item.name), relativePath));
    } else {
      entries.push({ relativePath, raw: readFileSync(join(absDir, item.name), 'utf8') });
    }
  }
  return entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

export function entry(relativePath: string, jsonOrText: unknown): IntakeEntry {
  const raw = typeof jsonOrText === 'string' ? jsonOrText : JSON.stringify(jsonOrText);
  return { relativePath, raw };
}

export function fixtureDir(...segments: string[]): string {
  return join(FIXTURES_DIR, ...segments);
}
