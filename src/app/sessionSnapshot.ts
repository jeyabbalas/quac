/**
 * Session snapshot codecs (P19b): the record shapes persisted per SessionKey,
 * the corrupt-tolerant guards that admit them back, and the boot decision that
 * arbitrates between the URL fragment and a stored session. Pure and
 * node-testable — no IDB, no signals.
 *
 * Guard doctrine (ingestion.md §6): storage is untrusted input. Every record
 * is checked field-by-field; a failed guard discards THAT record only, except
 * `meta` — it carries the snapshot version and the synced config the decision
 * table needs, so a bad meta means the whole snapshot is absent (the caller
 * best-effort purges).
 */
import { isEmptyConfig, encodeConfig } from '../core/share/urlConfig';
import type { UrlConfig } from '../core/share/urlConfig';
import type { DatasetSession } from './store';
import type { SessionKey } from './sessionBackend';
import type { QCRule, RuleScope, RuleType, Severity } from '../core/rules/types';

export const SNAPSHOT_VERSION = 1;

/** The share-relevant projection of the session — `buildSyncedConfig`'s output
 *  minus passthrough, i.e. exactly what the address bar carries. Stored in
 *  `meta` by the same writer as the bar, so the two cannot disagree. */
export interface SyncedConfig {
  schema: string[];
  rules: string[];
  index?: string;
  data?: string;
}

export interface MetaRecord {
  v: typeof SNAPSHOT_VERSION;
  /** Epoch ms of the last flush — informational (nothing expires on it). */
  savedAt: number;
  syncedConfig: SyncedConfig;
}

/** The dataset's ORIGINAL bytes plus what `ingestFromRestore` needs to replay
 *  them: a restored dataset is a fresh ingest, not a resurrected snapshot. */
export interface DatasetRecord {
  blob: Blob;
  name: string;
  format: DatasetSession['format'];
  sheetName?: string;
  sourceUrl?: string;
}

export interface SchemaEntryRecord {
  relativePath: string;
  raw: string;
  retrievalUri?: string;
}

export interface SchemaRecord {
  entries: SchemaEntryRecord[];
  origin: 'upload' | 'url';
  sourceUrls: string[];
  /** `set.root.indexFileId` whenever a root was resolved — replayed as
   *  `buildSchemaSet`'s indexParam so restore never re-prompts. */
  chosenIndexFileId?: string;
}

export interface RulesFileRecord {
  name: string;
  text: string;
  /** Per-file provenance — null for uploads (mirrors `rulesState.sources`). */
  sourceUrl: string | null;
}

export interface RulesRecord {
  files: RulesFileRecord[];
  /** File names carrying saved Studio edits (`rulesState.dirtyFiles`). */
  dirty: string[];
}

export interface StudioDrawerRecord {
  kind: 'new' | 'edit';
  fileName: string;
  index?: number;
  draft?: QCRule;
  draftDirty: boolean;
}

export interface StudioRecord {
  selectedFile: string | null;
  drawer: StudioDrawerRecord | null;
}

export interface PrefsRecord {
  applyCorrections: boolean;
}

/** A guarded snapshot: meta always present (or the whole thing is null),
 *  every other record individually optional. */
export interface StoredSession {
  meta: MetaRecord;
  dataset: DatasetRecord | null;
  schema: SchemaRecord | null;
  rules: RulesRecord | null;
  studio: StudioRecord | null;
  prefs: PrefsRecord | null;
}

// ---- guards -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function guardSyncedConfig(value: unknown): SyncedConfig | null {
  if (!isRecord(value)) return null;
  if (!isStringArray(value.schema) || !isStringArray(value.rules)) return null;
  if (value.index !== undefined && typeof value.index !== 'string') return null;
  if (value.data !== undefined && typeof value.data !== 'string') return null;
  const config: SyncedConfig = { schema: [...value.schema], rules: [...value.rules] };
  if (typeof value.index === 'string') config.index = value.index;
  if (typeof value.data === 'string') config.data = value.data;
  return config;
}

export function guardMetaRecord(value: unknown): MetaRecord | null {
  if (!isRecord(value)) return null;
  if (value.v !== SNAPSHOT_VERSION) return null;
  if (typeof value.savedAt !== 'number') return null;
  const syncedConfig = guardSyncedConfig(value.syncedConfig);
  if (syncedConfig === null) return null;
  return { v: SNAPSHOT_VERSION, savedAt: value.savedAt, syncedConfig };
}

const DATASET_FORMATS: readonly DatasetSession['format'][] = [
  'csv',
  'tsv',
  'json',
  'xlsx',
  'parquet',
];

export function guardDatasetRecord(value: unknown): DatasetRecord | null {
  if (!isRecord(value)) return null;
  if (!(value.blob instanceof Blob)) return null;
  if (typeof value.name !== 'string' || value.name === '') return null;
  if (!DATASET_FORMATS.includes(value.format as DatasetSession['format'])) return null;
  if (value.sheetName !== undefined && typeof value.sheetName !== 'string') return null;
  if (value.sourceUrl !== undefined && typeof value.sourceUrl !== 'string') return null;
  const record: DatasetRecord = {
    blob: value.blob,
    name: value.name,
    format: value.format as DatasetSession['format'],
  };
  if (typeof value.sheetName === 'string') record.sheetName = value.sheetName;
  if (typeof value.sourceUrl === 'string') record.sourceUrl = value.sourceUrl;
  return record;
}

function guardSchemaEntry(value: unknown): SchemaEntryRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.relativePath !== 'string' || typeof value.raw !== 'string') return null;
  if (value.retrievalUri !== undefined && typeof value.retrievalUri !== 'string') return null;
  const entry: SchemaEntryRecord = { relativePath: value.relativePath, raw: value.raw };
  if (typeof value.retrievalUri === 'string') entry.retrievalUri = value.retrievalUri;
  return entry;
}

export function guardSchemaRecord(value: unknown): SchemaRecord | null {
  if (!isRecord(value)) return null;
  if (value.origin !== 'upload' && value.origin !== 'url') return null;
  if (!Array.isArray(value.entries) || value.entries.length === 0) return null;
  const entries: SchemaEntryRecord[] = [];
  for (const raw of value.entries) {
    const entry = guardSchemaEntry(raw);
    if (entry === null) return null; // a torn entry poisons the whole set
    entries.push(entry);
  }
  if (!isStringArray(value.sourceUrls)) return null;
  if (value.chosenIndexFileId !== undefined && typeof value.chosenIndexFileId !== 'string') {
    return null;
  }
  const record: SchemaRecord = { entries, origin: value.origin, sourceUrls: [...value.sourceUrls] };
  if (typeof value.chosenIndexFileId === 'string') record.chosenIndexFileId = value.chosenIndexFileId;
  return record;
}

export function guardRulesRecord(value: unknown): RulesRecord | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.files) || value.files.length === 0) return null;
  const files: RulesFileRecord[] = [];
  for (const raw of value.files) {
    if (!isRecord(raw)) return null;
    if (typeof raw.name !== 'string' || raw.name === '') return null;
    if (typeof raw.text !== 'string') return null;
    if (raw.sourceUrl !== null && typeof raw.sourceUrl !== 'string') return null;
    files.push({ name: raw.name, text: raw.text, sourceUrl: raw.sourceUrl });
  }
  if (!isStringArray(value.dirty)) return null;
  return { files, dirty: [...value.dirty] };
}

const RULE_TYPES: readonly RuleType[] = ['validate', 'correct', 'external'];
const RULE_SCOPES: readonly RuleScope[] = ['row', 'column', 'dataset', 'longitudinal'];
const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info'];

/** Structural QCRule check — strict enough that `form.load` and the store's
 *  serialize→parse round-trip cannot choke on a restored draft. */
function guardRule(value: unknown): QCRule | null {
  if (!isRecord(value)) return null;
  if (typeof value.ruleId !== 'string') return null;
  if (!RULE_TYPES.includes(value.ruleType as RuleType)) return null;
  if (!RULE_SCOPES.includes(value.ruleScope as RuleScope)) return null;
  if (!isStringArray(value.targetVariables)) return null;
  if (typeof value.condition !== 'string') return null;
  if (value.updateLanguage !== 'sql' && value.updateLanguage !== 'js') return null;
  if (typeof value.updateExpression !== 'string') return null;
  if (!SEVERITIES.includes(value.severity as Severity)) return null;
  if (typeof value.comment !== 'string') return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (typeof value.sourceFile !== 'string') return null;
  if (typeof value.rowNumber !== 'number') return null;
  if (!isRecord(value.extras)) return null;
  for (const extra of Object.values(value.extras)) {
    if (typeof extra !== 'string') return null;
  }
  return {
    ruleId: value.ruleId,
    ruleType: value.ruleType as RuleType,
    ruleScope: value.ruleScope as RuleScope,
    targetVariables: [...value.targetVariables],
    condition: value.condition,
    updateLanguage: value.updateLanguage,
    updateExpression: value.updateExpression,
    severity: value.severity as Severity,
    comment: value.comment,
    enabled: value.enabled,
    sourceFile: value.sourceFile,
    rowNumber: value.rowNumber,
    extras: { ...(value.extras as Record<string, string>) },
  };
}

function guardDrawer(value: unknown): StudioDrawerRecord | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'new' && value.kind !== 'edit') return null;
  if (typeof value.fileName !== 'string' || value.fileName === '') return null;
  if (value.index !== undefined && typeof value.index !== 'number') return null;
  if (value.kind === 'edit' && typeof value.index !== 'number') return null;
  if (typeof value.draftDirty !== 'boolean') return null;
  const drawer: StudioDrawerRecord = {
    kind: value.kind,
    fileName: value.fileName,
    draftDirty: value.draftDirty,
  };
  if (typeof value.index === 'number') drawer.index = value.index;
  if (value.draft !== undefined) {
    const draft = guardRule(value.draft);
    if (draft === null) return null;
    drawer.draft = draft;
  }
  return drawer;
}

export function guardStudioRecord(value: unknown): StudioRecord | null {
  if (!isRecord(value)) return null;
  if (value.selectedFile !== null && typeof value.selectedFile !== 'string') return null;
  let drawer: StudioDrawerRecord | null = null;
  if (value.drawer !== null && value.drawer !== undefined) {
    drawer = guardDrawer(value.drawer);
    if (drawer === null) return null;
  }
  return { selectedFile: value.selectedFile, drawer };
}

export function guardPrefsRecord(value: unknown): PrefsRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.applyCorrections !== 'boolean') return null;
  return { applyCorrections: value.applyCorrections };
}

/**
 * Admit a raw `readAll` result. `null` when meta is absent/foreign-versioned
 * (the caller purges); otherwise each slot record independently guarded — a
 * corrupt dataset record must not take the rules down with it.
 */
export function readStoredSession(
  records: Partial<Record<SessionKey, unknown>>,
): StoredSession | null {
  const meta = guardMetaRecord(records.meta);
  if (meta === null) return null;
  return {
    meta,
    dataset: guardDatasetRecord(records.dataset),
    schema: guardSchemaRecord(records.schema),
    rules: guardRulesRecord(records.rules),
    studio: guardStudioRecord(records.studio),
    prefs: guardPrefsRecord(records.prefs),
  };
}

// ---- boot decision ----------------------------------------------------------

/** The share-relevant subset both `UrlConfig` and `SyncedConfig` satisfy. */
export interface CanonicalizableConfig {
  schema: readonly string[];
  rules: readonly string[];
  index?: string;
  data?: string;
}

/**
 * Canonical identity of a config's LOADABLE content: `schema[]`/`rules[]`
 * order-sensitive (order is semantic), plus `index`/`data` — passthrough and
 * `config=` excluded (compare only after manifest expansion). Serialized via
 * `encodeConfig`, the same codec the bar round-trips through.
 */
export function canonicalConfigKey(config: CanonicalizableConfig): string {
  const canonical: UrlConfig = {
    schema: [...config.schema],
    rules: [...config.rules],
    passthrough: [],
  };
  if (config.index !== undefined) canonical.index = config.index;
  if (config.data !== undefined) canonical.data = config.data;
  return encodeConfig(canonical);
}

/** `UrlConfig` → the stored projection (what `meta.syncedConfig` holds). */
export function toSyncedConfig(config: UrlConfig): SyncedConfig {
  const synced: SyncedConfig = { schema: [...config.schema], rules: [...config.rules] };
  if (config.index !== undefined) synced.index = config.index;
  if (config.data !== undefined) synced.data = config.data;
  return synced;
}

export type BootDecision = 'ignore-stored' | 'restore-stored' | 'refresh-with-upload-restore';

/** Row 3's equality, minus the `index=` pin: the refetch leg passes the
 *  CURRENT link's `index=` to the schema loader regardless, so a divergent or
 *  stale pin changes nothing about what loads — demoting the refresh to
 *  ignore-stored over it would only drop the uploads. */
function slotKey(config: CanonicalizableConfig): string {
  const stripped: CanonicalizableConfig = { schema: config.schema, rules: config.rules };
  if (config.data !== undefined) stripped.data = config.data;
  return canonicalConfigKey(stripped);
}

/**
 * The boot decision table (url-params.md §1). Order matters: an uploads-only
 * session has an EMPTY synced config, so the current-fragment-empty row must
 * be checked before the equality row, or restore would masquerade as refresh.
 *
 * | # | condition                                   | decision                    |
 * |---|---------------------------------------------|-----------------------------|
 * | 1 | no stored session / stored empty of slots   | ignore-stored               |
 * | 2 | current fragment empty                      | restore-stored              |
 * | 3 | canonical slot keys equal (post-expansion)  | refresh-with-upload-restore |
 * | 4 | differs (someone else's link)               | ignore-stored               |
 */
export function decideBoot(current: UrlConfig, stored: StoredSession | null): BootDecision {
  if (
    stored === null ||
    (stored.dataset === null && stored.schema === null && stored.rules === null)
  ) {
    return 'ignore-stored'; // empty ≡ absent
  }
  if (isEmptyConfig(current)) return 'restore-stored';
  if (slotKey(current) === slotKey(stored.meta.syncedConfig)) {
    return 'refresh-with-upload-restore';
  }
  return 'ignore-stored';
}
