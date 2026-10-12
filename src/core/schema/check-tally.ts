/**
 * Exact per-check tallies of schema findings (worker-protocol.ts
 * `SchemaCheckTally`). Both halves of a validation run feed one: the worker
 * its per-record flags, before the flag cap decides which of them are posted;
 * validation-run.ts the column- and dataset-level flags it raises itself.
 *
 * A check is a ruleId, keyword and schemaPath — one keyword at one place in
 * the schema. Only identifying fields are read, never a message or a value:
 * the tallies are what the findings report shares in place of the data.
 */
import type { QCFlag } from '../flags/flag';
import type { SchemaCheckTally } from './worker-protocol';

export interface CheckTallies {
  /** Count one flag. Records are counted once per check, so feed rows in order. */
  add: (flag: QCFlag) => void;
  /** The checks so far, in the order each first failed. */
  list: () => SchemaCheckTally[];
}

export function createCheckTallies(): CheckTallies {
  const tallies = new Map<string, SchemaCheckTally>();
  /** Last record counted per check: rows arrive in order, so a repeat is the same record. */
  const lastRow = new Map<string, number>();
  return {
    add(flag) {
      const keyword = flag.meta?.keyword;
      const schemaPath = flag.meta?.schemaPath;
      const key = `${flag.ruleId}\u0000${keyword ?? ''}\u0000${schemaPath ?? ''}`;
      let tally = tallies.get(key);
      if (tally === undefined) {
        const location = flag.meta?.location;
        const conditionalIndex = flag.meta?.conditionalIndex;
        tally = {
          ruleId: flag.ruleId,
          scope: flag.scope,
          ...(flag.column === undefined ? {} : { column: flag.column }),
          severity: flag.severity,
          ...(keyword === undefined ? {} : { keyword }),
          ...(schemaPath === undefined ? {} : { schemaPath }),
          ...(location === undefined ? {} : { location }),
          ...(conditionalIndex === undefined ? {} : { conditionalIndex }),
          count: 0,
          records: 0,
        };
        tallies.set(key, tally);
      }
      tally.count += 1;
      if (flag.row !== undefined && lastRow.get(key) !== flag.row) {
        tally.records += 1;
        lastRow.set(key, flag.row);
      }
    },
    list: () => [...tallies.values()].map((t) => ({ ...t })),
  };
}
