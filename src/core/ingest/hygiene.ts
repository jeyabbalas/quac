/**
 * Column-name hygiene at quac_raw creation (ingestion.md §2, architecture.md
 * §3): `__`-prefixed names are reserved (__row__, __value__, __rowid__,
 * <col>__review), duplicates break SQL and NDJSON keys, empty names break
 * both. Renames are surfaced to the user as slot warnings.
 */

export interface Rename {
  from: string;
  to: string;
  reason: 'reserved' | 'duplicate' | 'empty';
}

export interface SanitizedColumns {
  /** Unique, non-reserved, non-empty names in original order. */
  names: string[];
  renames: Rename[];
}

export function sanitizeColumnNames(names: readonly string[]): SanitizedColumns {
  const result: string[] = [];
  const renames: Rename[] = [];
  const taken = new Set<string>(); // lowercase — SQL identifiers are case-insensitive

  names.forEach((original, index) => {
    let name = original.trim();
    let reason: Rename['reason'] | null = null;

    if (name === '') {
      name = `column_${String(index + 1)}`;
      reason = 'empty';
    } else if (name.startsWith('__')) {
      name = name.replace(/^_+/, '');
      if (name === '') name = `column_${String(index + 1)}`;
      reason = 'reserved';
    }

    if (taken.has(name.toLowerCase())) {
      const base = name;
      let n = 2;
      while (taken.has(`${base}_${String(n)}`.toLowerCase())) n += 1;
      name = `${base}_${String(n)}`;
      reason ??= 'duplicate';
    }

    taken.add(name.toLowerCase());
    result.push(name);
    if (name !== original) renames.push({ from: original, to: name, reason: reason ?? 'duplicate' });
  });

  return { names: result, renames };
}
