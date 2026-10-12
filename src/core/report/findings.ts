/**
 * QC findings without data (qc-report-spec.md §7) — the account of a run a
 * user can hand to someone who must not see the data: every check the dataset
 * failed, where the JSON Schema or the QC rules define it, and how many
 * records failed it.
 *
 * The guarantee is structural, not a filter. A QCFlag's message and value
 * carry the data — "'twelve hundred' is not a valid integer", a correction's
 * before and after, a dataset rule's result rows — so this module never sees a
 * flag. It is built from the definitions (the schema set and its digest, the
 * rule files and their lint), the dataset's shape (column names, a record
 * count) and counts: the validation run's per-check tallies, the rules
 * engine's per-rule stats, and the FlagStore's row sets, which it only ever
 * counts. `FindingsInput` admits nothing else, and every sentence below is
 * worded here from those parts (schema/requirement.ts for the schema's).
 *
 * The output IS the shareable JSON document (`QcFindings`,
 * `findingsSchemaVersion`); the Markdown and Excel renderers draw on it and
 * on nothing else, so the three formats cannot disagree.
 */
import { computePertinence } from '../pertinence';
import { conditionalOneLiner } from '../schema/conditionals';
import { datasetShape } from '../schema/dataset-shape';
import { getAtPointer } from '../schema/deref';
import { checkSubject, conditionsAt, keywordRequirement } from '../schema/requirement';
import { SCHEMA_DATASET_RULE_IDS } from '../schema/rule-ids';
import { typeList } from '../schema/translator';
import type { FlagStore } from '../flags/flagStore';
import type { RuleFile, RuleFileLintResult, RuleRunStat } from '../rules/types';
import type { ColumnDigest, ColumnMeta } from '../schema/column-meta';
import type { SchemaFile, SchemaSet } from '../schema/types';
import type { SchemaCheckTally, ValidationSummary } from '../schema/worker-protocol';

/** Bumped only when a field is removed or renamed; additions keep it. */
export const FINDINGS_SCHEMA_VERSION = 1;

export const QUAC_HOMEPAGE = 'https://jeyabbalas.github.io/quac/';

export type FindingSeverity = 'error' | 'warning' | 'info';

// ---- the document -----------------------------------------------------------

export interface QcFindings {
  findingsSchemaVersion: number;
  /** Always false: nothing in this document was read from the dataset's values. */
  containsData: false;
  generator: { name: 'QuaC'; version: string; homepage: string };
  /** ISO 8601. */
  generatedAt: string;
  dataset: {
    name: string;
    format: string;
    /** The worksheet read, for an Excel dataset. */
    sheet: string | null;
    records: number;
    variables: number;
  };
  inputs: {
    schema: FindingsSchemaInput | null;
    rules: FindingsRulesInput[];
    correctionsApplied: boolean;
  };
  overview: FindingsOverview;
  /** Every schema check that failed, most severe and most frequent first. */
  schemaChecks: SchemaCheckFinding[];
  /** Every rule in every rules file, failed or not, in file order. */
  rules: RuleFinding[];
  notes: FindingsNote[];
}

export interface FindingsSchemaInput {
  /** The root (index) file: a path relative to `baseUrl` for a URL-loaded set, else as uploaded. */
  root: string;
  files: string[];
  /** Where a URL-loaded set's files sit (every `files` entry and `location.file` is below it); null for uploads. */
  baseUrl: string | null;
  /** QuaC's fingerprint of the exact files — equal ids, identical schemas. */
  setId: string;
  title: string | null;
  /** The root's `$id`. */
  id: string | null;
}

export interface FindingsRulesInput {
  file: string;
  rules: number;
  /** The URL it was loaded from; null for a local file. */
  source: string | null;
}

export interface FindingsOverview {
  records: number;
  /** Records failing at least one error-level check, schema or rule. */
  recordsWithErrors: number;
  /** Records failing at least one warning-level check. */
  recordsWithWarnings: number;
  /** False when a cap left flagged records uncounted: the two figures above are then lower bounds. */
  recordsExact: boolean;
  /** Schema checks failed at error or warning level. */
  schemaChecksFailed: number;
  rules: {
    total: number;
    /** Validate rules that found problems. */
    failed: number;
    passed: number;
    /** Correction rules that changed values. */
    corrected: number;
    /** Rules that failed to execute. */
    errored: number;
    /** Disabled, skipped, not evaluated, excluded, not applied or not reached. */
    notRun: number;
  };
  valuesCorrected: number;
  missingVariables: { required: number; optional: number };
  /** Dataset columns the schema does not describe — allowed or not. */
  columnsNotInSchema: number;
}

export type SchemaCheckLevel = 'dataset' | 'variable' | 'value';

export interface SchemaLocation {
  /** The schema file: relative to `inputs.schema.baseUrl` when that is set, else as uploaded. */
  file: string;
  /** JSON Pointer to the keyword (or the variable's declaration) in that file. */
  pointer: string;
}

export interface SchemaCheckFinding {
  /** dataset: the records as a whole; variable: a column as a whole; value: records' values. */
  level: SchemaCheckLevel;
  /** The dataset column the check is about; null for dataset- and record-level checks. */
  variable: string | null;
  variableTitle: string | null;
  /** Where inside the variable's value — `household[].age`; null at the value itself. */
  path: string | null;
  /** What the schema requires, in words, from the schema alone. */
  requirement: string;
  /** The JSON Schema keyword; null for a check QuaC makes beyond one keyword. */
  keyword: string | null;
  /** The keyword's value, when it is a plain value or a list of them. */
  schemaValue?: unknown;
  location: SchemaLocation | null;
  severity: FindingSeverity;
  /** Records that failed it; null when the check is on the dataset or a column as a whole. */
  records: number | null;
  /** Times it failed — more than `records` when a record holds the value more than once. */
  failures: number;
  /** records / dataset records × 100, to two decimals. */
  percentOfRecords: number | null;
  /** The id the full QC report files the finding under. */
  ruleId: string;
}

export type RuleOutcome =
  | 'failed'
  | 'passed'
  | 'corrected'
  | 'unchanged'
  | 'error'
  | 'not-evaluated'
  | 'disabled'
  | 'skipped'
  | 'excluded'
  | 'not-applied'
  | 'not-run';

export interface RuleFinding {
  ruleId: string;
  file: string;
  /** The rule's row in its file, counting data rows from 1 (the header is not one). */
  row: number;
  type: 'validate' | 'correct' | 'external';
  scope: 'row' | 'column' | 'dataset' | 'longitudinal';
  severity: FindingSeverity;
  variables: string[];
  /** The rule's comment. */
  description: string;
  condition: string;
  outcome: RuleOutcome;
  /** Why it did not run, or did not finish — never an engine message (those can quote data). */
  reason: string | null;
  /** Distinct records it flagged (validate) or changed (correct); null where it names no records. */
  records: number | null;
  percentOfRecords: number | null;
  /** False when the rule's flags were capped: `records` is then a lower bound. */
  recordsExact: boolean;
  /** Dataset-scope rules: the rows the rule's query returned. */
  resultRows: number | null;
  /** Correction rules: values changed. */
  valuesChanged: number | null;
  /** Column-scope rules: the result for each variable. */
  byVariable: RuleVariableResult[] | null;
}

export interface RuleVariableResult {
  variable: string;
  /** Records failing there (a per-record assertion); null for a distinct-count assertion. */
  records: number | null;
  /** `count_distinct_in_range`: the distinct values the column holds. */
  distinctValues?: number;
  failed: boolean;
}

export type FindingsNoteKind =
  | 'cancelled'
  | 'stage-error'
  | 'assess-only'
  | 'no-schema'
  | 'no-rules'
  | 'records-lower-bound'
  | 'schema-load'
  | 'not-checked'
  | 'json-source'
  | 'precision'
  | 'rules-file'
  | 'schema-comment';

export interface FindingsNote {
  kind: FindingsNoteKind;
  text: string;
}

// ---- the input --------------------------------------------------------------

export interface FindingsRuleFile {
  file: RuleFile;
  /** Its lint result; null when it was never linted (it then ran whole). */
  lint: RuleFileLintResult | null;
  /** The URL it was loaded from; null for a local file. */
  source: string | null;
}

/** All the builder may ask of a FlagStore: rows by identity, and aggregates. */
export type FindingsRowSource = Pick<FlagStore, 'rowsOf' | 'summary'>;

export interface FindingsInput {
  generatedAt: Date;
  quacVersion: string;
  dataset: {
    name: string;
    format: string;
    sheet: string | null;
    /** Column names in file order. */
    columns: readonly string[];
    records: number;
  };
  schema: { set: SchemaSet; digest: ColumnDigest } | null;
  /** Every rules file loaded — lint-excluded rules included — in load order. */
  ruleFiles: readonly FindingsRuleFile[];
  correctionsApplied: boolean;
  run: {
    cancelled: boolean;
    rules: { perRule: readonly RuleRunStat[]; correctedCells: number; aborted: boolean } | null;
    schema: ValidationSummary | null;
    stageErrors: readonly { stage: string; message: string }[];
    rows: FindingsRowSource;
  };
}

// ---- small helpers ----------------------------------------------------------

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };
const LEVEL_RANK: Record<SchemaCheckLevel, number> = { dataset: 0, variable: 1, value: 2 };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isPlain = (v: unknown): boolean =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  (Array.isArray(v) &&
    v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)));

const num = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, noun: string): string => `${num(n)} ${noun}${n === 1 ? '' : 's'}`;
const quote = (name: string): string => `'${name}'`;

function percentOf(part: number | null, whole: number): number | null {
  if (part === null || whole <= 0) return null;
  return Math.round((part / whole) * 10_000) / 100;
}

const unescapeSegment = (segment: string): string =>
  segment.replaceAll('~1', '/').replaceAll('~0', '~');

/**
 * A URL as the findings may print it: no credentials, no query string, no
 * fragment. A schema or rules file loaded from a signed URL (an S3 or Azure
 * link) carries its access token in the query, and these findings exist to be
 * handed to someone else. Anything that is not an http(s) URL — a relative
 * path, a file name — passes through.
 */
export function shareableUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.replace(/[?#].*$/s, '');
  }
}

/** Every http(s) URL inside a sentence, made shareable. */
function shareableText(text: string): string {
  return text.replace(/https?:\/\/[^\s`'"<>()]+/gi, (url) => shareableUrl(url));
}

const baseCache = new WeakMap<SchemaSet, string | null>();

/**
 * Where a URL-loaded set's files sit — `https://host/schemas/` — or null for
 * uploaded files, and for a set spread over several hosts. Loading already
 * names each URL file by its path below this base (schema-set.ts), as an
 * uploaded folder's files are named; the findings print those paths, and the
 * base once (`inputs.schema.baseUrl`), so a table of pointers is not a column
 * of repeated host names.
 */
export function schemaBaseUrl(set: SchemaSet): string | null {
  if (baseCache.has(set)) return baseCache.get(set) ?? null;
  let base: string | null = null;
  if (set.origin === 'url' && set.files.length > 0) {
    try {
      const urls = set.files.map((f) => new URL(f.fileId));
      const origin = urls[0]?.origin;
      // A file named by its full URL was not relativized: no shared base.
      const relative = set.files.every((f) => f.relativePath !== f.fileId);
      if (origin !== undefined && relative && urls.every((u) => u.origin === origin)) {
        const dirs = urls.map((u) =>
          u.pathname
            .slice(0, u.pathname.lastIndexOf('/') + 1)
            .split('/')
            .filter(Boolean),
        );
        const first = dirs[0] ?? [];
        const common: string[] = [];
        for (const [i, segment] of first.entries()) {
          if (dirs.every((d) => d[i] === segment)) common.push(segment);
          else break;
        }
        base = `${origin}${common.length > 0 ? `/${common.join('/')}/` : '/'}`;
      }
    } catch {
      base = null;
    }
  }
  baseCache.set(set, base);
  return base;
}

/** A schema file's name as the findings print it: its path in the set, never a query string. */
const fileName = (file: SchemaFile): string => shareableUrl(file.relativePath);

/** `uri#/a/b/keyword` → the file, the keyword's pointer, its parent's pointer and the keyword. */
function splitLocation(
  location: string,
): { uri: string; pointer: string; parentPointer: string; keyword: string } | null {
  const hash = location.indexOf('#');
  if (hash === -1) return null;
  const pointer = location.slice(hash + 1);
  const slash = pointer.lastIndexOf('/');
  if (slash === -1) return null;
  return {
    uri: location.slice(0, hash),
    pointer,
    parentPointer: pointer.slice(0, slash),
    keyword: unescapeSegment(pointer.slice(slash + 1)),
  };
}

/**
 * The words a broken rule may carry. An engine's message can quote the data —
 * DuckDB's `Could not convert string 'Ada' to INT32` — so only its class is
 * kept ("Conversion Error"), and QuaC's own fixed sentences, which quote none.
 */
export function brokenRuleReason(message: string | undefined): string {
  const generic = 'failed to execute — the full QC report has the engine’s message';
  if (message === undefined) return generic;
  if (message === 'JS corrections require the QuickJS sandbox; rule not executed') {
    return 'failed to execute — JavaScript corrections need the QuickJS sandbox, which was not available';
  }
  const budget = /^JS correction exceeded the (\d+) ms per-rule sandbox budget$/.exec(message);
  if (budget !== null) {
    return `failed to execute — the JavaScript correction ran past its ${num(Number(budget[1]))} ms budget`;
  }
  const rate = /^JS correction failed on (\d+) of (\d+) rows \(over the 1% limit\)/.exec(message);
  if (rate !== null) {
    return `failed to execute — the JavaScript correction threw on ${num(Number(rate[1]))} of ${num(Number(rate[2]))} rows, over the 1% limit`;
  }
  const kind = /^([A-Z][A-Za-z-]*(?: [A-Za-z-]+){0,3} Error):/.exec(message)?.[1];
  if (kind !== undefined)
    return `failed to execute — DuckDB reported a ${kind}; the full QC report has its message`;
  return generic;
}

// ---- inputs -----------------------------------------------------------------

function schemaInput(schema: FindingsInput['schema']): FindingsSchemaInput | null {
  if (schema === null) return null;
  const { set } = schema;
  const root = set.files.find((f) => f.fileId === set.root.rootFileId);
  const rootJson = root?.json;
  const title = isRecord(rootJson) && typeof rootJson.title === 'string' ? rootJson.title : null;
  return {
    root: root === undefined ? '' : fileName(root),
    files: set.schemas.map(fileName),
    baseUrl: schemaBaseUrl(set),
    setId: set.setId,
    title,
    id: root?.declaredId === undefined ? null : shareableUrl(root.declaredId),
  };
}

// ---- schema checks ----------------------------------------------------------

interface SchemaContext {
  set: SchemaSet;
  digest: ColumnDigest;
  metaByName: ReadonlyMap<string, ColumnMeta>;
  /** Schema order of variables, then the dataset's own order for the rest. */
  order: (variable: string | null) => number;
  datasetColumns: readonly string[];
  records: number;
  fileByUri: (uri: string) => SchemaFile | undefined;
  fileById: (fileId: string) => SchemaFile | undefined;
}

function locationOf(ctx: SchemaContext, uri: string, pointer: string): SchemaLocation | null {
  const file = ctx.fileByUri(uri);
  return file === undefined ? null : { file: fileName(file), pointer };
}

/** Where a variable is declared — the place a whole-variable finding points to. */
function declarationOf(ctx: SchemaContext, variable: string): SchemaLocation | null {
  const meta = ctx.metaByName.get(variable);
  if (meta === undefined) return null;
  const file = ctx.fileById(meta.source.fileId);
  return file === undefined ? null : { file: fileName(file), pointer: meta.source.pointer };
}

/** The keyword's own value, for plain values only (a subschema says nothing in a table cell). */
function schemaValueAt(ctx: SchemaContext, uri: string, pointer: string): unknown {
  const file = ctx.fileByUri(uri);
  if (file === undefined) return undefined;
  const found = getAtPointer(file.json, pointer);
  return found.found && isPlain(found.value) ? found.value : undefined;
}

/** A finding with its fields in the document's order, whatever order they were gathered in. */
function ordered(f: SchemaCheckFinding): SchemaCheckFinding {
  return {
    level: f.level,
    variable: f.variable,
    variableTitle: f.variableTitle,
    path: f.path,
    requirement: f.requirement,
    keyword: f.keyword,
    ...(f.schemaValue === undefined ? {} : { schemaValue: f.schemaValue }),
    location: f.location,
    severity: f.severity,
    records: f.records,
    failures: f.failures,
    percentOfRecords: f.percentOfRecords,
    ruleId: f.ruleId,
  };
}

/** "must be written as an integer" — a text cell that spells no value of the variable's type. */
function castRequirement(meta: ColumnMeta | undefined): string {
  const types = [...(meta?.jsonTypes ?? [])].filter((t) => t !== 'null');
  if (types.length === 0) return 'must be written as a value the schema allows';
  const structural = types.every((t) => t === 'array' || t === 'object');
  return `must be written as ${typeList(types)}${structural ? ', in JSON' : ''}`;
}

const undescribedNote =
  'is not described in the schema; the schema allows it, so its values were not checked';

/** A keyword check on records' values (or a whole record): its place, words and subject. */
function keywordFinding(ctx: SchemaContext, tally: SchemaCheckTally): SchemaCheckFinding {
  const variable = tally.column ?? null;
  const meta = variable === null ? undefined : ctx.metaByName.get(variable);
  const at = tally.location === undefined ? null : splitLocation(tally.location);
  const file = at === null ? undefined : ctx.fileByUri(at.uri);
  const parentNode =
    file === undefined || at === null ? undefined : getAtPointer(file.json, at.parentPointer);
  const parent = parentNode?.found === true && isRecord(parentNode.value) ? parentNode.value : null;
  const keyword = tally.keyword ?? at?.keyword ?? null;
  const subject = variable === null ? null : checkSubject(tally.schemaPath, variable);
  const atValue = subject?.atValue ?? false;
  const conditions = file === undefined || at === null ? null : conditionsAt(file.json, at.pointer);

  let requirement: string | null = null;
  const conditional = tally.ruleId.startsWith('schema:cond:') ? tally.conditionalIndex : undefined;
  const rule =
    conditional === undefined
      ? undefined
      : ctx.digest.conditionals.find((r) => r.index === conditional);
  if (rule !== undefined && variable !== null) {
    // The root's skip patterns: the digest has already worded them, labels and all.
    const negated = at?.pointer.includes('/else/') === true;
    const kinds =
      keyword === 'required'
        ? ['required']
        : keyword === 'const'
          ? ['const']
          : keyword === 'not'
            ? ['not-const', 'not-enum']
            : [];
    const target = rule.targets.find(
      (t) => t.column === variable && (t.clause === 'else') === negated && kinds.includes(t.kind),
    );
    if (target !== undefined) requirement = conditionalOneLiner(rule, target);
  }
  if (requirement === null) {
    let base: string | null;
    if (tally.ruleId.endsWith(':required') && keyword === 'required') {
      base = 'must not be missing';
    } else if (keyword === 'dependentRequired' || keyword === 'dependencies') {
      base = 'must not be missing';
    } else {
      base =
        keyword === null
          ? null
          : keywordRequirement({
              keyword,
              parent,
              ...(meta === undefined ? {} : { spec: meta.valueSpec }),
              atValue,
            });
    }
    base ??=
      keyword === null ? 'must satisfy the schema' : `must satisfy its \`${keyword}\` keyword`;
    if (variable === null) base = `each record ${base}`;
    if (
      (keyword === 'dependentRequired' || keyword === 'dependencies') &&
      isRecord(parent?.[keyword])
    ) {
      const triggers = Object.entries(parent[keyword])
        .filter(
          ([, needs]) => Array.isArray(needs) && variable !== null && needs.includes(variable),
        )
        .map(([trigger]) => `${quote(trigger)} is present`);
      if (triggers.length > 0) base += ` when ${triggers.join(' or ')}`;
    }
    const unconditionalRequired =
      conditions === null && tally.ruleId.endsWith(':required') && keyword === 'required';
    requirement = unconditionalRequired
      ? 'must not be missing — the schema requires it in every record'
      : conditions === null
        ? base
        : `${conditions}, ${base}`;
  }

  const records = tally.scope === 'cell' || tally.scope === 'row' ? tally.records : null;
  // A `required` list is the whole object's; the requirement already names the field.
  const schemaValue =
    at === null || keyword === null || keyword === 'required'
      ? undefined
      : schemaValueAt(ctx, at.uri, at.pointer);
  return {
    level:
      tally.scope === 'cell' || tally.scope === 'row'
        ? 'value'
        : tally.scope === 'column'
          ? 'variable'
          : 'dataset',
    variable,
    variableTitle: meta?.title ?? null,
    path: subject !== null && subject.path !== '' ? subject.path : null,
    requirement,
    keyword,
    ...(schemaValue === undefined ? {} : { schemaValue }),
    location: at === null ? null : locationOf(ctx, at.uri, at.pointer),
    severity: tally.severity,
    records,
    failures: tally.count,
    percentOfRecords: percentOf(records, ctx.records),
    ruleId: tally.ruleId,
  };
}

/** One tally → a finding, a note, or nothing (a note's kind of finding). */
function schemaTallyFinding(
  ctx: SchemaContext,
  tally: SchemaCheckTally,
  notes: FindingsNote[],
): SchemaCheckFinding | null {
  const variable = tally.column ?? null;
  const meta = variable === null ? undefined : ctx.metaByName.get(variable);
  const base = {
    variable,
    variableTitle: meta?.title ?? null,
    path: null,
    severity: tally.severity,
    ruleId: tally.ruleId,
  };
  const shape = datasetShape(ctx.set);
  const rootFile = ctx.fileById(ctx.set.root.rootFileId ?? '');
  const rootLocation = (keyword: string): SchemaLocation | null =>
    rootFile !== undefined && isRecord(rootFile.json) && Object.hasOwn(rootFile.json, keyword)
      ? { file: fileName(rootFile), pointer: `/${keyword}` }
      : null;
  const datasetFinding = (
    requirement: string,
    keyword: string | null,
    records: number | null = null,
  ): SchemaCheckFinding => ({
    ...base,
    level: 'dataset',
    variable: null,
    variableTitle: null,
    requirement,
    keyword,
    location: keyword === null ? null : rootLocation(keyword),
    records,
    failures: tally.count,
    percentOfRecords: percentOf(records, ctx.records),
  });

  switch (tally.ruleId) {
    case SCHEMA_DATASET_RULE_IDS.duplicateRecords:
      // One flag per record that repeats an earlier one.
      return datasetFinding(
        'every record must be unique — no two records identical',
        'uniqueItems',
        tally.count,
      );
    case SCHEMA_DATASET_RULE_IDS.minItems:
      return datasetFinding(
        `the dataset must have at least ${plural(shape?.minItems ?? 0, 'record')}`,
        'minItems',
      );
    case SCHEMA_DATASET_RULE_IDS.maxItems:
      return datasetFinding(
        `the dataset must have at most ${plural(shape?.maxItems ?? 0, 'record')}`,
        'maxItems',
      );
    case SCHEMA_DATASET_RULE_IDS.items:
      return datasetFinding(
        `the dataset must have at most ${plural(shape?.prefix.length ?? 0, 'record')}`,
        rootLocation('prefixItems') === null ? 'items' : 'prefixItems',
      );
    case SCHEMA_DATASET_RULE_IDS.contains: {
      const c = shape?.contains;
      const wanted =
        c === undefined
          ? 'the required number of records'
          : c.max === undefined
            ? `at least ${plural(c.min, 'record')}`
            : c.min === c.max
              ? `exactly ${plural(c.min, 'record')}`
              : `${num(c.min)}–${plural(c.max, 'record')}`;
      return datasetFinding(`${wanted} must match the schema’s \`contains\` subschema`, 'contains');
    }
    case SCHEMA_DATASET_RULE_IDS.empty:
      return datasetFinding('the dataset must hold records — it has none', null);
    case SCHEMA_DATASET_RULE_IDS.noOverlap:
      return datasetFinding(
        `the dataset must share variables with the schema — none of the schema’s ${plural(ctx.digest.meta.length, 'variable')} is among its ${plural(ctx.datasetColumns.length, 'column')}`,
        null,
      );
    case SCHEMA_DATASET_RULE_IDS.unchecked:
      for (const warning of shape?.warnings ?? [])
        notes.push({ kind: 'not-checked', text: warning });
      return null;
    case SCHEMA_DATASET_RULE_IDS.source:
      notes.push({
        kind: 'json-source',
        text:
          'QuaC could not read the JSON dataset’s records as written, so it validated DuckDB’s reading of ' +
          'them: dates, times and UUIDs in DuckDB’s text, and an explicit null read as a missing value.',
      });
      return null;
    case SCHEMA_DATASET_RULE_IDS.pertinence:
      notes.push({
        kind: 'not-checked',
        text: 'The schema defines no per-column properties, so whether it describes this dataset could not be assessed.',
      });
      return null;
    default:
      break;
  }

  if (tally.ruleId.startsWith('schema:advisory:')) {
    const fileId = tally.ruleId.slice('schema:advisory:'.length);
    const file = ctx.fileById(fileId);
    const comment = isRecord(file?.json) ? file.json.$comment : undefined;
    if (file !== undefined && typeof comment === 'string') {
      notes.push({ kind: 'schema-comment', text: `${fileName(file)}: ${comment}` });
    }
    return null;
  }

  if (variable !== null && tally.ruleId === `schema:prop:${variable}:precision`) {
    notes.push({
      kind: 'precision',
      text:
        `${variable} holds integers beyond ±(2^53−1), the range a JSON number holds exactly; ` +
        'the schema checks read them at the nearest representable number.',
    });
    return null;
  }

  if (variable !== null && tally.scope === 'column') {
    const kind = tally.ruleId.slice(`schema:column:${variable}:`.length);
    const variableFinding = (
      requirement: string,
      keyword: string | null,
      location: SchemaLocation | null,
    ): SchemaCheckFinding => ({
      ...base,
      level: 'variable',
      requirement,
      keyword,
      location,
      records: null,
      failures: tally.count,
      percentOfRecords: null,
    });
    switch (kind) {
      case 'missing':
        return tally.severity === 'error'
          ? variableFinding(
              'must be in the dataset — the schema requires it, and the dataset has no such column',
              'required',
              declarationOf(ctx, variable),
            )
          : variableFinding(
              'is declared in the schema, and the dataset has no such column (the schema does not require it)',
              'properties',
              declarationOf(ctx, variable),
            );
      case 'case-mismatch': {
        const pertinence = computePertinence({
          schemaColumns: ctx.digest.meta.map((m) => ({ name: m.name, required: m.required })),
          datasetColumns: ctx.datasetColumns,
        });
        const found = pertinence?.caseMismatches.find((c) => c.schema === variable)?.dataset;
        return variableFinding(
          found === undefined
            ? 'must be named exactly as the schema names it'
            : `must be named exactly as the schema names it — the dataset’s column is ${quote(found)}, so its values were not checked`,
          'properties',
          declarationOf(ctx, variable),
        );
      }
      case 'undescribed':
        return variableFinding(undescribedNote, null, null);
      case 'unexpected': {
        const finding = keywordFinding(ctx, tally);
        const keyword = finding.keyword;
        const parentOf = tally.location === undefined ? null : splitLocation(tally.location);
        const file = parentOf === null ? undefined : ctx.fileByUri(parentOf.uri);
        const names =
          file === undefined || parentOf === null
            ? undefined
            : getAtPointer(file.json, parentOf.pointer);
        const pattern =
          keyword === 'propertyNames' &&
          names?.found === true &&
          isRecord(names.value) &&
          typeof names.value.pattern === 'string'
            ? names.value.pattern
            : null;
        return {
          ...finding,
          level: 'variable',
          path: null,
          requirement:
            pattern !== null
              ? `must not be in the dataset — the schema allows only variables whose names match \`${pattern}\``
              : 'must not be in the dataset — the schema allows no variables besides the ones it describes',
          records: null,
          percentOfRecords: null,
        };
      }
      default:
        break;
    }
  }

  if (variable !== null && tally.ruleId === `schema:prop:${variable}:cast`) {
    return {
      ...base,
      level: 'value',
      requirement: castRequirement(meta),
      keyword: 'type',
      location: declarationOf(ctx, variable),
      records: tally.records,
      failures: tally.count,
      percentOfRecords: percentOf(tally.records, ctx.records),
    };
  }

  return keywordFinding(ctx, tally);
}

function buildSchemaChecks(input: FindingsInput, notes: FindingsNote[]): SchemaCheckFinding[] {
  const schema = input.schema;
  const summary = input.run.schema;
  if (schema === null || summary === null) return [];
  const { set, digest } = schema;
  const metaByName = new Map(digest.meta.map((m) => [m.name, m]));
  const schemaOrder = new Map(digest.meta.map((m, i) => [m.name, i]));
  const datasetOrder = new Map(input.dataset.columns.map((c, i) => [c, i]));
  const filesByUri = new Map(set.files.map((f) => [f.retrievalUri, f]));
  const filesById = new Map(set.files.map((f) => [f.fileId, f]));
  const ctx: SchemaContext = {
    set,
    digest,
    metaByName,
    order: (variable) =>
      variable === null
        ? -1
        : (schemaOrder.get(variable) ??
          digest.meta.length + (datasetOrder.get(variable) ?? input.dataset.columns.length)),
    datasetColumns: input.dataset.columns,
    records: input.dataset.records,
    fileByUri: (uri) => filesByUri.get(uri),
    fileById: (fileId) => filesById.get(fileId),
  };

  const findings: SchemaCheckFinding[] = [];
  for (const tally of summary.checks) {
    const finding = schemaTallyFinding(ctx, tally, notes);
    if (finding !== null) findings.push(ordered(finding));
  }
  return findings.sort(
    (a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.records ?? 0) - (a.records ?? 0) ||
      b.failures - a.failures ||
      ctx.order(a.variable) - ctx.order(b.variable) ||
      (a.path ?? '').localeCompare(b.path ?? '') ||
      (a.keyword ?? '').localeCompare(b.keyword ?? '') ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

// ---- rules ------------------------------------------------------------------

/** The rules lint kept out of the run, by row — mirroring `executableRuleFile`. */
function lintExclusions(lint: RuleFileLintResult | null): {
  wholeFile: string | null;
  byRow: Map<number, string>;
} {
  const byRow = new Map<number, string>();
  if (lint === null) return { wholeFile: null, byRow };
  let wholeFile: string | null = null;
  for (const issue of lint.issues) {
    if (issue.severity !== 'error') continue;
    if (issue.rowNumber === undefined) wholeFile ??= issue.message;
    else if (!byRow.has(issue.rowNumber)) byRow.set(issue.rowNumber, issue.message);
  }
  return { wholeFile, byRow };
}

function buildRules(input: FindingsInput, notes: FindingsNote[]): RuleFinding[] {
  const total = input.dataset.records;
  const columns = new Set(input.dataset.columns);
  const runRules = input.run.rules;
  // Stats by id, consumed in file order: two files may reuse an id.
  const stats = new Map<string, RuleRunStat[]>();
  for (const stat of runRules?.perRule ?? []) {
    const list = stats.get(stat.ruleId);
    if (list === undefined) stats.set(stat.ruleId, [stat]);
    else list.push(stat);
  }
  const rulesStageFailed = input.run.stageErrors.some(
    (e) => e.stage === 'rules' || e.stage === 'corrections',
  );
  const cut = input.run.cancelled || runRules?.aborted === true;

  const findings: RuleFinding[] = [];
  for (const { file, lint } of input.ruleFiles) {
    const exclusions = lintExclusions(lint);
    if (exclusions.wholeFile !== null) {
      notes.push({
        kind: 'rules-file',
        text: `${file.name} did not run: ${shareableText(exclusions.wholeFile).replace(/\.$/, '')}.`,
      });
    }
    for (const rule of file.rules) {
      const lintReason = exclusions.wholeFile ?? exclusions.byRow.get(rule.rowNumber) ?? null;
      const stat = lintReason === null ? stats.get(rule.ruleId)?.shift() : undefined;
      const finding: RuleFinding = {
        ruleId: rule.ruleId,
        file: file.name,
        row: rule.rowNumber,
        type: rule.ruleType,
        scope: rule.ruleScope,
        severity: rule.severity,
        variables: [...rule.targetVariables],
        description: rule.comment,
        condition: rule.condition,
        outcome: 'not-run',
        reason: null,
        records: null,
        percentOfRecords: null,
        recordsExact: true,
        resultRows: null,
        valuesChanged: null,
        byVariable: null,
      };

      if (lintReason !== null) {
        finding.outcome = 'excluded';
        finding.reason = `excluded before the run: ${shareableText(lintReason).replace(/\.$/, '')}`;
      } else if (stat === undefined) {
        if (!rule.enabled) {
          // An assess-only run never reaches a correction to skip it.
          finding.outcome = 'disabled';
          finding.reason = 'disabled in its rules file';
        } else if (rule.ruleType === 'correct' && !input.correctionsApplied) {
          finding.outcome = 'not-applied';
          finding.reason = 'corrections were not applied in this run';
        } else if (cut) {
          finding.reason = 'the run was cancelled before this rule';
        } else if (rulesStageFailed || runRules === null) {
          finding.reason = 'the rules stage did not finish';
        } else {
          finding.reason = 'not run';
        }
      } else {
        switch (stat.status) {
          case 'broken':
            finding.outcome = 'error';
            finding.reason = brokenRuleReason(stat.error);
            break;
          case 'skipped-disabled':
            finding.outcome = 'disabled';
            finding.reason = 'disabled in its rules file';
            break;
          case 'skipped-external':
            finding.outcome = 'not-evaluated';
            finding.reason = 'needs external reference data';
            break;
          case 'skipped-inapplicable': {
            const missing = rule.targetVariables.filter((t) => !columns.has(t));
            finding.outcome = 'skipped';
            finding.reason =
              missing.length === 0
                ? 'its variables are not in the dataset'
                : `not in the dataset: ${missing.join(', ')}`;
            break;
          }
          case 'ok':
            fillRuleCounts(finding, stat, input.run.rows, total);
            break;
        }
      }
      findings.push(finding);
    }
  }
  return findings;
}

/** A rule that ran: what it found, in the units its scope counts. */
function fillRuleCounts(
  finding: RuleFinding,
  stat: RuleRunStat,
  rows: FindingsRowSource,
  total: number,
): void {
  const flaggedRows = (): number => rows.rowsOf(stat.ruleId).length;
  if (finding.type === 'correct') {
    const changed = stat.changedCells ?? stat.violationCount;
    finding.outcome = changed > 0 ? 'corrected' : 'unchanged';
    finding.valuesChanged = changed;
    finding.records = changed > 0 ? flaggedRows() : 0;
    finding.recordsExact = !stat.truncated;
    finding.percentOfRecords = percentOf(finding.records, total);
    return;
  }
  finding.outcome = stat.violationCount > 0 ? 'failed' : 'passed';
  switch (finding.scope) {
    case 'row':
    case 'longitudinal':
      // The condition is evaluated once per record: its COUNT(*) is records.
      finding.records = stat.violationCount;
      break;
    case 'column': {
      const aggregate = stat.byTarget?.some((t) => t.distinct !== undefined) === true;
      finding.byVariable =
        stat.byTarget?.map((t) => ({
          variable: t.column,
          records: t.distinct === undefined ? t.violations : null,
          ...(t.distinct === undefined ? {} : { distinctValues: t.distinct }),
          failed: t.violations > 0,
        })) ?? null;
      if (!aggregate) {
        // One record can fail on several variables: count it once.
        finding.records = stat.violationCount > 0 ? flaggedRows() : 0;
        finding.recordsExact = !stat.truncated;
      }
      break;
    }
    case 'dataset':
      finding.resultRows = stat.violationCount;
      break;
  }
  finding.percentOfRecords = percentOf(finding.records, total);
}

// ---- overview ---------------------------------------------------------------

function recordsAt(rows: FindingsRowSource, severities: readonly FindingSeverity[]): number {
  const union = new Set<number>();
  for (const aggregate of rows.summary().perRule) {
    if (!severities.includes(aggregate.severity) || aggregate.rowsAffected === 0) continue;
    for (const row of rows.rowsOf(aggregate.ruleId)) union.add(row);
  }
  return union.size;
}

function buildOverview(
  input: FindingsInput,
  schemaChecks: readonly SchemaCheckFinding[],
  rules: readonly RuleFinding[],
): FindingsOverview {
  const rows = input.run.rows;
  const capped =
    input.run.schema?.flagsTruncated === true ||
    (input.run.rules?.perRule ?? []).some((s) => s.truncated);
  const missing = schemaChecks.filter(
    (c) => c.level === 'variable' && c.ruleId.endsWith(':missing'),
  );
  const count = (outcomes: readonly RuleOutcome[]): number =>
    rules.filter((r) => outcomes.includes(r.outcome)).length;
  return {
    records: input.dataset.records,
    recordsWithErrors: recordsAt(rows, ['error']),
    recordsWithWarnings: recordsAt(rows, ['warning']),
    recordsExact: !capped,
    schemaChecksFailed: schemaChecks.filter((c) => c.severity !== 'info').length,
    rules: {
      total: rules.length,
      failed: count(['failed']),
      passed: count(['passed', 'unchanged']),
      corrected: count(['corrected']),
      errored: count(['error']),
      notRun: count(['not-evaluated', 'disabled', 'skipped', 'excluded', 'not-applied', 'not-run']),
    },
    valuesCorrected: input.run.rules?.correctedCells ?? 0,
    missingVariables: {
      required: missing.filter((c) => c.severity === 'error').length,
      optional: missing.filter((c) => c.severity !== 'error').length,
    },
    columnsNotInSchema: schemaChecks.filter(
      (c) =>
        c.level === 'variable' &&
        (c.ruleId.endsWith(':unexpected') || c.ruleId.endsWith(':undescribed')),
    ).length,
  };
}

// ---- notes ------------------------------------------------------------------

/** The run-level notes: what this run did not do, and why its numbers may be partial. */
function runNotes(input: FindingsInput): FindingsNote[] {
  const notes: FindingsNote[] = [];
  if (
    input.run.cancelled ||
    input.run.rules?.aborted === true ||
    input.run.schema?.aborted === true
  ) {
    notes.push({
      kind: 'cancelled',
      text: 'The run was cancelled before it finished: the counts cover the work it completed.',
    });
  }
  for (const error of input.run.stageErrors) {
    notes.push({
      kind: 'stage-error',
      text: `The ${error.stage} stage did not finish, so its checks are missing here; the full QC report has the error.`,
    });
  }
  if (input.schema === null) {
    notes.push({
      kind: 'no-schema',
      text: 'No JSON Schema was loaded for this run: schema validation was skipped.',
    });
  }
  if (input.ruleFiles.length === 0) {
    notes.push({
      kind: 'no-rules',
      text: 'No QC rules were loaded for this run: the rules stage was skipped.',
    });
  }
  if (
    !input.correctionsApplied &&
    input.ruleFiles.some((f) => f.file.rules.some((r) => r.ruleType === 'correct'))
  ) {
    notes.push({
      kind: 'assess-only',
      text: 'Corrections were not applied (assess-only run): every check read the data as loaded.',
    });
  }
  const capped =
    input.run.schema?.flagsTruncated === true ||
    (input.run.rules?.perRule ?? []).some((s) => s.truncated);
  if (capped) {
    notes.push({
      kind: 'records-lower-bound',
      text:
        'Some checks failed more often than QuaC keeps an itemized record of, so the totals of records with ' +
        'errors or warnings — and the record counts the notes mark — are lower bounds. Every other count is exact.',
    });
  }
  for (const error of input.schema?.set.errors ?? []) {
    if (error.severity === 'warning')
      notes.push({ kind: 'schema-load', text: shareableText(error.message) });
  }
  return notes;
}

const NOTE_ORDER: readonly FindingsNoteKind[] = [
  'cancelled',
  'stage-error',
  'no-schema',
  'no-rules',
  'assess-only',
  'records-lower-bound',
  'rules-file',
  'schema-load',
  'not-checked',
  'json-source',
  'precision',
  'schema-comment',
];

// ---- entry point ------------------------------------------------------------

export function buildFindings(input: FindingsInput): QcFindings {
  const notes = runNotes(input);
  const schemaChecks = buildSchemaChecks(input, notes);
  const rules = buildRules(input, notes);
  notes.sort((a, b) => NOTE_ORDER.indexOf(a.kind) - NOTE_ORDER.indexOf(b.kind));
  return {
    findingsSchemaVersion: FINDINGS_SCHEMA_VERSION,
    containsData: false,
    generator: { name: 'QuaC', version: input.quacVersion, homepage: QUAC_HOMEPAGE },
    generatedAt: input.generatedAt.toISOString(),
    dataset: {
      name: input.dataset.name,
      format: input.dataset.format,
      sheet: input.dataset.sheet,
      records: input.dataset.records,
      variables: input.dataset.columns.length,
    },
    inputs: {
      schema: schemaInput(input.schema),
      rules: input.ruleFiles.map((f) => ({
        file: f.file.name,
        rules: f.file.rules.length,
        source: f.source === null ? null : shareableUrl(f.source),
      })),
      correctionsApplied: input.correctionsApplied,
    },
    overview: buildOverview(input, schemaChecks, rules),
    schemaChecks,
    rules,
    notes,
  };
}

// ---- filename ---------------------------------------------------------------

export type FindingsFormat = 'markdown' | 'json' | 'xlsx';

export const FINDINGS_EXTENSIONS: Readonly<Record<FindingsFormat, string>> = {
  markdown: 'md',
  json: 'json',
  xlsx: 'xlsx',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `quac-findings_<dataset-stem>_<YYYYMMDD-HHmm>.<ext>` (local time) — the QC report's pattern. */
export function findingsFilename(datasetName: string, at: Date, format: FindingsFormat): string {
  const stem = datasetName.replace(/\.[^./\\]+$/, '').replace(/[^\w.-]+/g, '_') || 'dataset';
  const stamp =
    `${String(at.getFullYear())}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
    `-${pad2(at.getHours())}${pad2(at.getMinutes())}`;
  return `quac-findings_${stem}_${stamp}.${FINDINGS_EXTENSIONS[format]}`;
}
