/**
 * Ajv construction, registration, and compiling at a pointer
 * (json-schema-subsystem.md §B.1–§B.3), plus the load-time checks that need
 * an engine (`loadTimeChecks`).
 *
 * Imported by the validation worker, by `meta-validate.ts` through a dynamic
 * import, and by node tests — never statically from entry-reachable code
 * (Ajv would otherwise land in the entry chunk; the worker chunk, a lazy
 * chunk and node are the sanctioned homes, §B.1 CSP note).
 *
 * What QuaC changes from Ajv's defaults, and why:
 * - `ownProperties: true` — a column named `constructor` or `toString` is
 *   checked as the data's own property, not Object.prototype's function.
 * - `multipleOf` with decimal semantics, and patterns compiled in either
 *   ECMA-262 dialect (`keywords.ts`).
 * - The formats JSON Schema names checked to their standards (`formats.ts`),
 *   ajv-formats' remaining ones kept.
 * - `logger: false` — an unknown format is reported once at load
 *   (`W_UNCHECKED_FORMAT`), not as a console warning per schema compile.
 *
 * Import style: named classes with explicit .js extensions, matching
 * scripts/record-ajv-errors.mjs — ajv ships CJS without an `exports` map, and
 * the §B.1 default-import spelling is the one avoidable interop risk through
 * the Vite worker bundle (cosmetic deviation from §B.1).
 */
import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import draft6MetaSchema from 'ajv/dist/refs/json-schema-draft-06.json';
import addFormats from 'ajv-formats';
import type AjvCore from 'ajv/dist/core';
import type { AnySchema, ValidateFunction } from 'ajv';
import { canonicalMetaSchemaUri, effectiveDraft, readDraft } from './drafts';
import {
  isDate,
  isDateTime,
  isEmail,
  isHostname,
  isIdnEmail,
  isIdnHostname,
  isIri,
  isIriReference,
  isRegex,
  isTime,
  isUri,
  isUriReference,
  isUriTemplate,
  DURATION,
  UUID,
  uncheckedFormats,
} from './formats';
import { tolerantRegExp, useExactMultipleOf } from './keywords';
import {
  compileMessage,
  emptyEnumMessage,
  invalidPatternMessage,
  loadError,
  refSiblingsMessage,
  uncheckedFormatMessage,
} from './messages';
import { DRAFT7_VALIDATION_KEYWORDS, refSiblings, staticSchemaProblems } from './schema-walk';
import type { SchemaDraft, SchemaFile, SchemaLoadError, SchemaSet } from './types';

/** A schema document ready for Ajv registration (worker init payload shape). */
export interface RegisterableFile {
  /** Registration key: the file's retrievalUri (§B.2 — `quac-set:/…` or URL). */
  uri: string;
  json: unknown;
}

export interface MetaError {
  uri: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Ajv's compare for a format, so ajv-formats' `formatMinimum` family keeps working on ours. */
const compareOf = (name: string): ((a: string, b: string) => number | undefined) | undefined => {
  const def = addFormats.get(name as Parameters<typeof addFormats.get>[0]) as unknown;
  return isRecord(def) && typeof def.compare === 'function'
    ? (def.compare as (a: string, b: string) => number | undefined)
    : undefined;
};

/** ajv-formats' full set, then QuaC's standard-conformant checks over the top. */
function registerFormats(ajv: AjvCore): void {
  addFormats(ajv);
  const withCompare = (name: string, validate: (s: string) => boolean): void => {
    const compare = compareOf(name);
    ajv.addFormat(name, compare === undefined ? validate : { validate, compare });
  };
  withCompare('date', isDate);
  withCompare('time', isTime);
  withCompare('date-time', isDateTime);
  ajv.addFormat('duration', DURATION);
  ajv.addFormat('uuid', UUID);
  ajv.addFormat('email', isEmail);
  ajv.addFormat('idn-email', isIdnEmail);
  ajv.addFormat('hostname', isHostname);
  ajv.addFormat('idn-hostname', isIdnHostname);
  ajv.addFormat('uri', isUri);
  ajv.addFormat('uri-reference', isUriReference);
  ajv.addFormat('iri', isIri);
  ajv.addFormat('iri-reference', isIriReference);
  ajv.addFormat('uri-template', isUriTemplate);
  ajv.addFormat('regex', isRegex);
}

/**
 * §B.1 construction: one instance per set, class chosen by the ROOT file's
 * draft ('unknown' ⇒ 2020-12; draft-06 rides the draft-07 class with its own
 * meta-schema added). QC needs every failure (allErrors) with the failing
 * data/schema attached (verbose — the translator reads titles); user schemas
 * carry x-* annotation keywords (strict off); casting is DuckDB's job (§C —
 * coercion would mask cast findings).
 */
export function buildAjv(draft: SchemaDraft): AjvCore {
  const effective = effectiveDraft(draft);
  if (effective === 'draft-04') {
    throw new Error('JSON Schema draft-04 is not supported — QuaC validates draft-06 and later.');
  }
  const Ctor =
    effective === 'draft-07' || effective === 'draft-06'
      ? Ajv
      : effective === '2019-09'
        ? Ajv2019
        : Ajv2020;
  const ajv = new Ctor({
    allErrors: true,
    verbose: true,
    strict: false,
    validateSchema: true,
    coerceTypes: false,
    $data: false,
    ownProperties: true,
    logger: false,
    code: { optimize: 1, regExp: tolerantRegExp },
  });
  if (effective === 'draft-06') ajv.addMetaSchema(draft6MetaSchema);
  registerFormats(ajv);
  useExactMultipleOf(ajv);
  return ajv;
}

/** Draft of a schema document from its `$schema` (absent ⇒ 'unknown' ⇒ root draft). */
export function schemaDraftOf(json: unknown): SchemaDraft {
  return readDraft(json).draft;
}

// ---------------------------------------------------------------------------
// The copy Ajv gets
// ---------------------------------------------------------------------------

/** Assign without `__proto__` turning into a prototype change. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

const SUBSCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];
const SUBSCHEMA_SINGLES = [
  'additionalProperties',
  'unevaluatedProperties',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
  'not',
  'contentSchema',
  'items',
];
const SUBSCHEMA_ARRAYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];

/** `^__proto__$` — where a property literally named `__proto__` moves (Ajv drops it from `properties`). */
const PROTO_PATTERN = '^__proto__$';

/**
 * One schema node as Ajv should see it — a new object when anything below
 * changed, the same object otherwise, never the input mutated:
 *
 * - **draft-06/07 `$ref` siblings.** Those drafts ignore every keyword next to
 *   `$ref` (draft-07 Core §8.3), a sibling `$id` included; Ajv applies them.
 *   Dropped here, and the loader names the checks dropped (`W_REF_SIBLINGS`).
 * - **`properties.__proto__`.** Ajv skips a property of that name, then calls
 *   it additional. Moved to `patternProperties["^__proto__$"]`, which checks
 *   the same key with the same subschema, and counts as evaluated the same.
 * - **An empty `enum`.** Valid JSON Schema that no value satisfies (§6.1.2);
 *   Ajv refuses to compile it. Read as a `false` subschema beside the node's
 *   other keywords — exactly what it means — and the loader says so
 *   (`W_EMPTY_ENUM`).
 */
function prepareNode(node: unknown, ignoreRefSiblings: boolean, depth: number): unknown {
  if (!isRecord(node) || depth > 256) return node;
  // Edits land on a shallow copy, returned only when something changed.
  const out: Record<string, unknown> = { ...node };
  let changed = false;

  for (const key of SUBSCHEMA_MAPS) {
    const map = node[key];
    if (!isRecord(map)) continue;
    const nextMap: Record<string, unknown> = { ...map };
    let mapChanged = false;
    for (const [name, sub] of Object.entries(map)) {
      const next = prepareNode(sub, ignoreRefSiblings, depth + 1);
      if (next !== sub) {
        put(nextMap, name, next);
        mapChanged = true;
      }
    }
    if (mapChanged) {
      put(out, key, nextMap);
      changed = true;
    }
  }
  for (const key of SUBSCHEMA_SINGLES) {
    const sub = node[key];
    if (!isRecord(sub)) continue;
    const next = prepareNode(sub, ignoreRefSiblings, depth + 1);
    if (next !== sub) {
      put(out, key, next);
      changed = true;
    }
  }
  for (const key of SUBSCHEMA_ARRAYS) {
    const list: unknown = node[key];
    if (!Array.isArray(list)) continue;
    const items = list as unknown[];
    const next = items.map((sub) => prepareNode(sub, ignoreRefSiblings, depth + 1));
    if (next.some((sub, i) => sub !== items[i])) {
      put(out, key, next);
      changed = true;
    }
  }

  // Not at a document's root: the index file's root is never validated
  // against at all (the record schema is compiled at `#/items`, which must
  // stay reachable), and `refSiblings` reports no root either. A sibling
  // `$id` goes too: it would move the base the `$ref` resolves against, and
  // those drafts ignore it like every other sibling.
  if (ignoreRefSiblings && depth > 0 && typeof node.$ref === 'string') {
    for (const key of Object.keys(node)) {
      if (key === '$id' || DRAFT7_VALIDATION_KEYWORDS.has(key)) {
        Reflect.deleteProperty(out, key);
        changed = true;
      }
    }
  }

  const properties = out.properties;
  if (isRecord(properties) && Object.hasOwn(properties, '__proto__')) {
    const moved = properties.__proto__;
    const rest: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(properties)) if (name !== '__proto__') put(rest, name, sub);
    put(out, 'properties', rest);
    const patterns: Record<string, unknown> = isRecord(out.patternProperties) ? { ...out.patternProperties } : {};
    const existing = patterns[PROTO_PATTERN];
    put(patterns, PROTO_PATTERN, existing === undefined ? moved : { allOf: [existing, moved] });
    put(out, 'patternProperties', patterns);
    changed = true;
  }

  if (Array.isArray(out.enum) && out.enum.length === 0) {
    Reflect.deleteProperty(out, 'enum');
    const allOf: unknown[] = Array.isArray(out.allOf) ? (out.allOf as unknown[]) : [];
    put(out, 'allOf', [...allOf, false]);
    changed = true;
  }

  return changed ? out : node;
}

/**
 * A schema document as Ajv registers it: the `$schema` spelling Ajv knows
 * (a custom or variant one reads as the set's draft), and the rewrites of
 * `prepareNode`. `setDraft` is the draft the set validates with.
 */
export function prepareSchemaForAjv(json: unknown, setDraft: SchemaDraft): unknown {
  const effective = effectiveDraft(setDraft);
  const prepared = prepareNode(json, effective === 'draft-07' || effective === 'draft-06', 0);
  if (!isRecord(prepared) || typeof prepared.$schema !== 'string') return prepared;
  const declared = readDraft(prepared);
  const canonical = canonicalMetaSchemaUri(
    declared.recognized && declared.draft !== 'unknown' ? declared.draft : effective,
  );
  if (canonical === undefined || canonical === prepared.$schema) return prepared;
  const copy = prepared === json ? { ...prepared } : prepared;
  put(copy, '$schema', canonical);
  return copy;
}

/** A file meta-validated against its own draft: the `$schema` normalised, nothing else changed. */
export function metaSchemaInput(json: unknown, setDraft: SchemaDraft): unknown {
  if (!isRecord(json) || typeof json.$schema !== 'string') return json;
  const declared = readDraft(json);
  const canonical = canonicalMetaSchemaUri(
    declared.recognized && declared.draft !== 'unknown' ? declared.draft : effectiveDraft(setDraft),
  );
  if (canonical === undefined || canonical === json.$schema) return json;
  const copy = { ...json };
  put(copy, '$schema', canonical);
  return copy;
}

/** A file that declares a KNOWN draft other than the set's — registered, never meta-validated here. */
function isOtherDraft(json: unknown, setDraft: SchemaDraft): boolean {
  const declared = readDraft(json);
  return (
    declared.recognized &&
    declared.draft !== 'unknown' &&
    declared.draft !== effectiveDraft(setDraft)
  );
}

/**
 * §B.2 pre-registration guard: `validateSchema` EVERY file and collect all
 * failures before any `addSchema` (which throws on the first). Files
 * declaring a different KNOWN draft are skipped — their meta-schema is absent
 * on this instance and `E_MIXED_DRAFT` already covers the situation
 * (mirrors meta-validate.ts; validating them here would turn a sanctioned
 * warning into a runtime fatal).
 */
export function collectMetaErrors(
  ajv: AjvCore,
  files: readonly RegisterableFile[],
  draft: SchemaDraft,
): MetaError[] {
  const errors: MetaError[] = [];
  for (const file of files) {
    if (isOtherDraft(file.json, draft)) continue;
    let valid: boolean | Promise<unknown>;
    try {
      valid = ajv.validateSchema(metaSchemaInput(file.json, draft) as AnySchema);
    } catch (err) {
      errors.push({ uri: file.uri, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (valid === false) {
      const first = ajv.errors?.[0];
      const where = first?.instancePath ? ` at ${first.instancePath}` : '';
      errors.push({
        uri: file.uri,
        message: `${first?.message ?? 'does not match the meta-schema'}${where}`,
      });
    }
  }
  return errors;
}

/**
 * §B.2 registration under the retrievalUri key (Ajv also indexes the
 * schema's own `$id` — both resolve). A file declaring a different known
 * draft is still registered — so a `$ref` into it resolves — but without
 * schema validation: its meta-schema is not on this instance, and
 * `E_MIXED_DRAFT` already says QuaC reads it with the set's draft.
 */
export function registerSchemaFiles(
  ajv: AjvCore,
  files: readonly RegisterableFile[],
  draft: SchemaDraft,
): void {
  for (const file of files) {
    const prepared = prepareSchemaForAjv(file.json, draft) as AnySchema;
    if (isOtherDraft(file.json, draft)) ajv.addSchema(prepared, file.uri, undefined, false);
    else ajv.addSchema(prepared, file.uri);
  }
}

/** `#` + a JSON Pointer, each segment URI-encoded as Ajv decodes it (`$defs` → `%24defs`). */
function fragmentOf(pointer: string): string {
  if (pointer === '') return '';
  return `#${pointer
    .split('/')
    .map((segment, i) => (i === 0 ? segment : encodeURIComponent(segment)))
    .join('/')}`;
}

/**
 * Compile the subschema at `pointer` (a JSON Pointer, `''` for the document
 * itself) of the registered document `uri`, in place — the base URI stays
 * the document's, so relative refs resolve exactly as in whole-document
 * validation. Throws on a compile failure, or when nothing is there.
 */
export function compileAt(ajv: AjvCore, uri: string, pointer: string): ValidateFunction {
  const ref = `${uri}${fragmentOf(pointer)}`;
  const validate = ajv.getSchema(ref);
  if (validate === undefined) {
    throw new Error(`schema engine: '${ref}' failed to compile`);
  }
  return validate;
}

/**
 * §B.3 row validator: compile the root's `items` subschema in place —
 * `unevaluatedProperties` sees all cousin applicators (they live inside the
 * same `items` object).
 */
export function compileRowValidator(ajv: AjvCore, rootBase: string): ValidateFunction {
  return compileAt(ajv, rootBase, '/items');
}

// ---------------------------------------------------------------------------
// Load time
// ---------------------------------------------------------------------------

/** What a compile failure says, in the user's terms. */
function compileReason(err: unknown): string {
  if (isRecord(err) && typeof err.missingRef === 'string') {
    return `the reference \`${err.missingRef}\` cannot be resolved`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

/**
 * The checks that need the engine, run once while the schema set loads so a
 * schema that cannot validate says so then — not as a stage error halfway
 * through a run:
 *
 * - `E_COMPILE` (fatal): a `pattern` or `patternProperties` name that is no
 *   regular expression in either ECMA-262 dialect, named by file and
 *   pointer; then whatever else Ajv cannot compile in the record schema.
 * - `W_EMPTY_ENUM`, `W_REF_SIBLINGS`, `W_UNCHECKED_FORMAT` (warnings).
 *
 * The compile runs only when nothing fatal has been found already (those
 * findings block validation anyway, and an unresolved ref would only fail
 * again here). It compiles the root's `items` — the record schema — or the
 * root document when there is no `items` object.
 */
export function loadTimeChecks(set: SchemaSet): SchemaLoadError[] {
  const errors: SchemaLoadError[] = [];
  const rootFile = set.files.find((f) => f.fileId === set.root.rootFileId);
  const draft = rootFile?.draft ?? 'unknown';
  const effective = effectiveDraft(draft);

  for (const file of set.schemas) {
    if (file.classification === 'invalid-json') continue;
    for (const problem of staticSchemaProblems(file.json)) {
      if (problem.kind === 'empty-enum') {
        errors.push(
          loadError('W_EMPTY_ENUM', emptyEnumMessage(file.relativePath, problem.pointer), {
            fileId: file.fileId,
            meta: { pointer: problem.pointer },
          }),
        );
      } else {
        errors.push(
          loadError(
            'E_COMPILE',
            invalidPatternMessage(file.relativePath, problem.pointer, problem.kind, problem.pattern, problem.reason),
            { fileId: file.fileId, meta: { pointer: problem.pointer } },
          ),
        );
      }
    }
    if (effective === 'draft-07' || effective === 'draft-06') {
      for (const site of refSiblings(file.json)) {
        errors.push(
          loadError('W_REF_SIBLINGS', refSiblingsMessage(file.relativePath, site.pointer, site.keywords), {
            fileId: file.fileId,
            meta: { pointer: site.pointer, keywords: site.keywords },
          }),
        );
      }
    }
  }

  const unchecked = uncheckedFormats(set);
  if (unchecked.length > 0) {
    errors.push(loadError('W_UNCHECKED_FORMAT', uncheckedFormatMessage(unchecked), { meta: { formats: unchecked } }));
  }

  const blocked = [...set.errors, ...errors].some((e) => e.severity === 'fatal');
  if (!blocked && rootFile !== undefined && effective !== 'draft-04') {
    try {
      const ajv = buildAjv(draft);
      registerSchemaFiles(
        ajv,
        set.schemas.map((f: SchemaFile) => ({ uri: f.retrievalUri, json: f.json })),
        draft,
      );
      const json = rootFile.json;
      const pointer = isRecord(json) && (isRecord(json.items) || typeof json.items === 'boolean') ? '/items' : '';
      compileAt(ajv, rootFile.declaredId ?? rootFile.retrievalUri, pointer);
    } catch (err) {
      errors.push(
        loadError('E_COMPILE', compileMessage(rootFile.relativePath, compileReason(err)), {
          fileId: rootFile.fileId,
        }),
      );
    }
  }
  return errors;
}
