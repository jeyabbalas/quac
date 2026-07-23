/** TSV = the CSV route with a tab delimiter and no text rewriting (ingestion.md §2). */
import { parseDelimited } from './csv';
import type { ParsedDelimited } from './csv';

export async function parseTsv(text: string): Promise<ParsedDelimited> {
  return parseDelimited(text, '\t');
}
