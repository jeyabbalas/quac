/**
 * FlagStore — canonical QCFlag accumulator (qc-report-spec.md §1). Stores
 * flags verbatim with dedupe counting, severity-tiered materialization under
 * a global cap (errors first — an incoming higher-severity flag evicts the
 * newest lowest-severity one), lazily rebuilt indexes, and aggregates that
 * stay EXACT past the cap so Sheet 4 and the Summary panel never lie.
 * Framework-free: exposes a plain subscribe callback; P14 bridges to signals.
 */
import type { QCFlag } from './flag';

/** One deduped flag: the canonical QCFlag + how many times it was reported. */
export interface FlagEntry {
  flag: QCFlag;
  /** Occurrences of the identical flag (dedupe key hits), ≥ 1. */
  count: number;
}

export interface RuleAggregate {
  ruleId: string;
  source: QCFlag['source'];
  severity: QCFlag['severity'];
  /** Exact occurrence count — never truncated by the cap. */
  count: number;
  /** Distinct flagged rows (cell/row-scope flags only). */
  rowsAffected: number;
  /** rowsAffected / rowsTotal, present when summary() received rowsTotal. */
  pctOfRows?: number;
}

export interface FlagStoreSummary {
  /** Every flag ever added (incl. dedupe repeats and counted-only past-cap flags). */
  totalCount: number;
  /** Deduped entries currently materialized (≤ cap). */
  materializedCount: number;
  truncated: boolean;
  severityTotals: Record<QCFlag['severity'], number>;
  correctionsCount: number;
  countsByRuleId: ReadonlyMap<string, number>;
  countsByColumn: ReadonlyMap<string, number>;
  /** Sheet-4 ordering: count desc, then ruleId asc. */
  perRule: RuleAggregate[];
}

export interface FlagStore {
  readonly cap: number;
  add(batch: readonly QCFlag[]): void;
  byCell(row: number, column: string): readonly FlagEntry[];
  byColumn(column: string): readonly FlagEntry[];
  byRule(ruleId: string): readonly FlagEntry[];
  datasetScope(): readonly FlagEntry[];
  /** Every materialized entry in deterministic order (annotations, export). */
  all(): readonly FlagEntry[];
  /** Exact flags-ever-added count (== summary().totalCount, without the build). */
  totalCount(): number;
  summary(rowsTotal?: number): FlagStoreSummary;
  /** Called once per mutating add()/clear(); returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
  clear(): void;
}

/** Global materialization cap default (qc-rules-engine.md §5). */
export const FLAG_CAP_DEFAULT = 200_000;

/** FNV-1a 32-bit over the message — the dedupe key's `hash(message)` segment. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Dedupe key per qc-report-spec §1: source|ruleId|scope|row|column|hash(message). */
function dedupeKey(f: QCFlag): string {
  const row = f.row === undefined ? '' : String(f.row);
  const column = f.column ?? '';
  return `${f.source}|${f.ruleId}|${f.scope}|${row}|${column}|${fnv1a(f.message)}`;
}

const SEVERITY_RANK: Record<QCFlag['severity'], number> = { error: 0, warning: 1, info: 2 };

/** In-cell ordering = pipeline order (corrections → schema → rules), then ruleId. */
function pipelineCategory(f: QCFlag): number {
  if (f.correction !== undefined) return 0;
  return f.source === 'schema' ? 1 : 2;
}

interface StoredEntry extends FlagEntry {
  /** Insertion sequence — the deterministic last-resort tie-breaker. */
  seq: number;
}

function compareEntries(a: StoredEntry, b: StoredEntry): number {
  const rowA = a.flag.row ?? -1;
  const rowB = b.flag.row ?? -1;
  if (rowA !== rowB) return rowA - rowB;
  const catA = pipelineCategory(a.flag);
  const catB = pipelineCategory(b.flag);
  if (catA !== catB) return catA - catB;
  if (a.flag.ruleId !== b.flag.ruleId) return a.flag.ruleId < b.flag.ruleId ? -1 : 1;
  return a.seq - b.seq;
}

export function createFlagStore(opts: { cap?: number } = {}): FlagStore {
  const cap = opts.cap ?? FLAG_CAP_DEFAULT;

  // Materialized state.
  const entries = new Map<string, StoredEntry>();
  /** Admission order per severity tier; only the newest of a tier is evicted. */
  const stacks: Record<QCFlag['severity'], string[]> = { error: [], warning: [], info: [] };
  let seqCounter = 0;

  // Exact aggregates (never affected by the cap).
  let totalCount = 0;
  let countedOnly = 0;
  let correctionsCount = 0;
  const severityTotals: Record<QCFlag['severity'], number> = { error: 0, warning: 0, info: 0 };
  const countsByRuleId = new Map<string, number>();
  const countsByColumn = new Map<string, number>();
  const ruleInfo = new Map<string, { source: QCFlag['source']; severity: QCFlag['severity'] }>();
  const rowsByRule = new Map<string, Set<number>>();

  // Lazily rebuilt indexes.
  let indexesDirty = true;
  const cellIndex = new Map<string, StoredEntry[]>();
  const columnIndex = new Map<string, StoredEntry[]>();
  const ruleIndex = new Map<string, StoredEntry[]>();
  let datasetEntries: StoredEntry[] = [];
  let allEntries: StoredEntry[] = [];

  const listeners = new Set<() => void>();

  function recordAggregates(f: QCFlag): void {
    totalCount += 1;
    severityTotals[f.severity] += 1;
    if (f.correction !== undefined) correctionsCount += 1;
    countsByRuleId.set(f.ruleId, (countsByRuleId.get(f.ruleId) ?? 0) + 1);
    if (f.column !== undefined) {
      countsByColumn.set(f.column, (countsByColumn.get(f.column) ?? 0) + 1);
    }
    if (!ruleInfo.has(f.ruleId)) ruleInfo.set(f.ruleId, { source: f.source, severity: f.severity });
    if (f.row !== undefined) {
      let rows = rowsByRule.get(f.ruleId);
      if (rows === undefined) {
        rows = new Set();
        rowsByRule.set(f.ruleId, rows);
      }
      rows.add(f.row);
    }
  }

  /** Evict the newest entry of the lowest tier strictly below `severity`. */
  function evictBelow(severity: QCFlag['severity']): boolean {
    for (let rank = 2; rank > SEVERITY_RANK[severity]; rank--) {
      const tier = rank === 2 ? 'info' : 'warning';
      const key = stacks[tier].pop();
      if (key !== undefined) {
        entries.delete(key);
        countedOnly += 1;
        return true;
      }
    }
    return false;
  }

  function materialize(key: string, f: QCFlag): void {
    if (entries.size >= cap && !evictBelow(f.severity)) {
      countedOnly += 1;
      return;
    }
    entries.set(key, { flag: f, count: 1, seq: seqCounter++ });
    stacks[f.severity].push(key);
  }

  function rebuildIndexes(): void {
    cellIndex.clear();
    columnIndex.clear();
    ruleIndex.clear();
    datasetEntries = [];
    allEntries = [...entries.values()].sort(compareEntries);
    for (const entry of allEntries) {
      const f = entry.flag;
      const push = (map: Map<string, StoredEntry[]>, key: string): void => {
        const list = map.get(key);
        if (list === undefined) map.set(key, [entry]);
        else list.push(entry);
      };
      if (f.scope === 'cell' && f.row !== undefined && f.column !== undefined) {
        push(cellIndex, `${String(f.row)}|${f.column}`);
      }
      if (f.column !== undefined) push(columnIndex, f.column);
      push(ruleIndex, f.ruleId);
      if (f.scope === 'dataset') datasetEntries.push(entry);
    }
    indexesDirty = false;
  }

  function ensureIndexes(): void {
    if (indexesDirty) rebuildIndexes();
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    cap,

    add(batch: readonly QCFlag[]): void {
      if (batch.length === 0) return;
      for (const f of batch) {
        recordAggregates(f);
        const key = dedupeKey(f);
        const existing = entries.get(key);
        if (existing !== undefined) {
          existing.count += 1;
          continue;
        }
        materialize(key, f);
      }
      indexesDirty = true;
      notify();
    },

    byCell(row: number, column: string): readonly FlagEntry[] {
      ensureIndexes();
      return cellIndex.get(`${String(row)}|${column}`) ?? [];
    },

    byColumn(column: string): readonly FlagEntry[] {
      ensureIndexes();
      return columnIndex.get(column) ?? [];
    },

    byRule(ruleId: string): readonly FlagEntry[] {
      ensureIndexes();
      return ruleIndex.get(ruleId) ?? [];
    },

    datasetScope(): readonly FlagEntry[] {
      ensureIndexes();
      return datasetEntries;
    },

    all(): readonly FlagEntry[] {
      ensureIndexes();
      return allEntries;
    },

    totalCount: (): number => totalCount,

    summary(rowsTotal?: number): FlagStoreSummary {
      const perRule: RuleAggregate[] = [...countsByRuleId.entries()]
        .map(([ruleId, count]) => {
          const info = ruleInfo.get(ruleId) ?? { source: 'schema' as const, severity: 'error' as const };
          const rowsAffected = rowsByRule.get(ruleId)?.size ?? 0;
          return {
            ruleId,
            source: info.source,
            severity: info.severity,
            count,
            rowsAffected,
            ...(rowsTotal !== undefined && rowsTotal > 0 ? { pctOfRows: rowsAffected / rowsTotal } : {}),
          };
        })
        .sort((a, b) => (a.count !== b.count ? b.count - a.count : a.ruleId < b.ruleId ? -1 : 1));
      return {
        totalCount,
        materializedCount: entries.size,
        truncated: countedOnly > 0,
        severityTotals: { ...severityTotals },
        correctionsCount,
        countsByRuleId: new Map(countsByRuleId),
        countsByColumn: new Map(countsByColumn),
        perRule,
      };
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    clear(): void {
      entries.clear();
      stacks.error = [];
      stacks.warning = [];
      stacks.info = [];
      seqCounter = 0;
      totalCount = 0;
      countedOnly = 0;
      correctionsCount = 0;
      severityTotals.error = 0;
      severityTotals.warning = 0;
      severityTotals.info = 0;
      countsByRuleId.clear();
      countsByColumn.clear();
      ruleInfo.clear();
      rowsByRule.clear();
      indexesDirty = true;
      notify();
    },
  };
}
