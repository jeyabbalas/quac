# Spec: `@jeyabbalas/data-table` v0.5.1 — API Cheat Sheet & Integration Rules

> Audience: any phase that touches the data grid, the shared DuckDB bridge, annotations, tooltips, or filters.
> Source: library README/docs/types on GitHub `main` + npm registry (researched 2026-07-23), plus facts confirmed
> by the library author against the **v0.5.1 tag** (marked ✅ AUTHOR-CONFIRMED). Treat this file as authoritative;
> if the library's behavior contradicts it, follow the protocol in `00-master-plan.md` (verify ≤30 min, record in
> `architecture.md → Verified facts`).

## 1. Identity & distribution

| Field | Value |
|---|---|
| Package | `@jeyabbalas/data-table` **0.5.1** (published 2026-05-18), MIT |
| Format | **ESM only** (`type: module`); entry `./dist/data-table.js`; extra exports `/advanced` (NOT semver-stable — pin if used) and `/styles` (CSS, required) |
| Model | Vanilla TS **factory function** mounting into a host `HTMLElement`. No framework required |
| Peer deps | `@duckdb/duckdb-wasm ^1.33.1-dev45.0` (required); 6× CodeMirror packages + `@lezer/highlight` (optional — only for its built-in SQL editor; QuaC installs CodeMirror anyway) |
| DuckDB loading | Worker via `new Worker(new URL(...), {type:'module'})`; WASM bundles from **jsDelivr by default**; QuaC **self-hosts** instead (see §8) |
| COOP/COEP | **Not required.** Falls back to `mvp`/`eh` single-threaded bundles automatically → works on GitHub Pages |
| Browser floor | Worker, WebAssembly, IndexedDB (unless `persistence:false`), ResizeObserver, BigInt, structuredClone (~Chrome/Edge 98+, FF 94+, Safari 15.4+). `checkBrowserSupport()` available |

```ts
import { createDataTable, WorkerBridge, quoteIdentifier, formatSQLValue } from '@jeyabbalas/data-table';
import '@jeyabbalas/data-table/styles';   // REQUIRED — else `warning` event code 'STYLESHEET_MISSING'
```

Vite: `optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] }`.

## 2. Initialization & data loading

```ts
function createDataTable(options: CreateDataTableOptions): Promise<DataTable>;
```

Key `CreateDataTableOptions` (all feature flags default `true`):

```
container: HTMLElement                 // required
source?: File | string | ArrayBuffer | Blob
sourceFormat?: 'csv' | 'json' | 'parquet'   // else auto-detect
tableName?: string                     // auto-generated if omitted; only used when source present
bridge?: WorkerBridge                  // ← share ONE DuckDB across instances + host
bridgeOptions?: { workerUrl?, workerFactory?, duckdbBundles?, initializeTimeoutMs? (30s) }
persistence?, presets?, undoRedo?, expressionFilter?, derivedColumns?,
visualizations?, exportDialog?: boolean | {...}
editorFactory?, messages?, portalTarget?, rowHeight? (32), headerHeight? (120),
colorScheme? ('auto'), classPrefix? ('dt'), instanceId?, strictBrowserCheck? (false)
```

`DataTable` instance surface:

```
state: TableState            // reactive signals (schema, totalRows, filters, filteredRows, selectedRows,
                             //   columnHeaderTooltips, ...) — .get() / .subscribe(fn)
actions: StateActions        // sort/filter/tooltip commands (see §5, §6)
annotations: AnnotationStore // see §4
bridge: WorkerBridge
loadData(source, opts?): Promise<void>   // refresh path — reuses worker, clears invalidated caches
on/off(event, handler)       // → unsubscribe fn
openExportDialog(): void
clearSession(): Promise<void>
destroy(): Promise<void>; isDestroyed(): boolean
setColorScheme(s); getColorScheme()
```

**Ingest formats: CSV, JSON, Parquet ONLY.** No Excel/TSV/Arrow (QuaC converts upstream — see `ingestion.md`).
Sources: `File` (extension detection), absolute `https://` URL (its own fetch: no cookies/custom headers; non-2xx → `LoadError`), `ArrayBuffer` (assumed Parquet unless `sourceFormat` set), `Blob`, raw CSV/JSON string. Do **not** rely on relative/`data:`/`file:` URLs (README overstates; `loading-data.md` is correct). For anything needing auth or CORS control, fetch yourself and pass bytes.

Events: `ready`, `loadStart`, `loadProgress` (`{stage:'reading'|'parsing'|'indexing'|'analyzing', percent}`), `loadComplete` (`{tableName, rowCount}`), `loadError`, `error`, `filterChanged`, `sortChanged`, `selectionChanged`, `columnChange`, `derivedChange`, `undoChange`, `destroy`, `warning`.

Error classes (all extend `DataTableError` with `.code`): `LoadError`, `QueryError`, `SQLValidationError`, `DerivedColumnError`, `AnnotationError`, `WorkerInitError`, `WorkerTerminatedError`, `PersistenceError`, `ExportError`, `ConfigurationError`, `DestroyedError`.

## 3. The shared WorkerBridge (QuaC's single most important lever)

```ts
const bridge = new WorkerBridge(bridgeOptions?);
await bridge.initialize();
const rows = await bridge.query<T>(sql);   // → Promise<T[]> plain JS row objects
// also: bridge.load(), bridge.export(), bridge.dropTable(name), bridge.clearQueryCache(), bridge.cancel(), bridge.terminate()
```

- Pass the same `bridge` to every `createDataTable({bridge, ...})` and use it for all engine SQL. **Never instantiate a second duckdb-wasm** (~35 MB WASM once).
- When the host owns the bridge, `table.destroy()` does NOT terminate it — the host calls `bridge.terminate()` on teardown.
- Use distinct `tableName`s per table instance (see naming registry in `architecture.md`).
- Helpers: `quoteIdentifier(name)`, `formatSQLValue(value, type?)`.

✅ AUTHOR-CONFIRMED facts (v0.5.1 source):

1. **`bridge.query()` forwards arbitrary SQL** to the worker's `conn.query(sql)` with no SELECT-only restriction: `CREATE TABLE/VIEW`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `COPY` all execute. Statements without result rows generally resolve to `[]`.
2. **Query-cache caveat:** SELECT results are cached and **mutations do NOT invalidate the cache**. After ANY DDL/DML through the bridge, call `bridge.clearQueryCache()` — otherwise an identical SELECT string can return pre-mutation results. QuaC rule: every engine helper that mutates state clears the cache before returning.
3. **`createDataTable({bridge, tableName})` with no `source` does NOT attach** to an existing DuckDB table (an omitted source just means "call `loadData()` later"; `tableName` only enters the loading path when `source` exists). There is no zero-copy "display this relation" API → corrected data is displayed via the byte round-trip (§7).
4. **`__rowid__` is stable within one load**: materialized once into the physical table as `row_number() OVER () - 1` at load time; filter/sort SELECT the stored column and use it as the deterministic sort tie-breaker. It is **reassigned on every `loadData()`**, and the guarantee assumes the host never tampers with the display table via DML.

`bridge.export()` exists but its signature/semantics are undocumented — Phase P03 verifies the corrected-bytes retrieval path (see §7) and records the verdict.

## 4. Annotations (`table.annotations`, an `AnnotationStore`)

```
add(a: NewAnnotation): Annotation           addMany(a[]): Annotation[]
update(id, patch): Annotation               remove(id) / removeMany(ids) / clear(scope?) / count()
get(id) / getAll() / getByRow(rowId) / getByColumn(column) / getByCell(rowId, column)
setSeverityFilter({error?,warning?,info?})  getSeverityFilter()
toJSON(): AnnotationFile                    loadJSON(file, mode?: 'replace'|'merge')   // version 1
on('change', ({kind, ids}) => void)         // kind: added|updated|removed|cleared|filterChanged
```

Data model — three scopes × three severities:

```ts
scope: 'row' | 'column' | 'cell';  severity: 'error' | 'warning' | 'info';
// CellAnnotation: { scope:'cell', rowId, column, severity, message, code?, source?, metadata?, id? }
// RowAnnotation:  { scope:'row',  rowId, ... }   ColumnAnnotation: { scope:'column', column, ... }
```

- `rowId` = the display table's **`__rowid__`** (BIGINT — convert with `Number()`). Because QuaC exports display bytes ordered by its own `__row__` key with `__row__` excluded, **`__rowid__ === __row__`** after load, so `QCFlag.row` maps directly (see `architecture.md §row identity`).
- `code`/`source`/`metadata` carry QuaC provenance: `code = ruleId`, `source = flag.source`, `metadata = {scope, correction?}`.
- Live: `add`/`update` after render repaint immediately; `setSeverityFilter` hides tiers without deleting.
- Rendering: tinted backgrounds via CSS classes (`dt-cell--annotated dt-cell--annotation-error` etc.; highest severity wins per element) + hover/focus popover (ARIA `role="tooltip"`) listing all annotations grouped by scope. Color tokens: `--dt-annotation-{error|warning|info}-{fg|bg|bdr}`.
- **Annotations do NOT survive `loadData()`** — re-apply from the FlagStore after every refresh (cheap: flags are the source of truth; `toJSON()/loadJSON()` exists but re-derivation is simpler and always correct).

## 5. Column-header tooltips

```ts
table.actions.setColumnHeaderTooltip(columnName: string,
  content: string | ColumnHeaderTooltipContent | null): void;   // null removes
table.actions.getColumnHeaderTooltip(columnName): ColumnHeaderTooltipContent | null;

interface ColumnHeaderTooltipContent {
  title?: string;
  description?: string;
  items?: { label: string; value: string | string[] }[];   // string[] renders as chips
}
```

Not schema-aware: QuaC builds content per column from schema digests + rules targeting the column (`json-schema-subsystem.md §E.2`, `qc-report-spec.md §tooltips`). Set after the instance is `ready`; there is no `tooltips` option on `createDataTable`. XSS-safe (text only).

## 6. Sorting, filters, derived columns, visualizations

- Sort: `actions.setSort(SortColumn[])`, `toggleSort(col)`, `addToSort(col)`, `clearSort()`.
- Filters (7 types: `range|point|set|notset|null|pattern|raw-sql`): `addFilter`, `removeFilter(column, type?)`, `clearFilters()`, `loadFilterPreset(...)`.
- **Raw SQL filters (Studio live preview!):**
  ```
  addRawSQLFilter(sql, label?): string     updateRawSQLFilter(id, sql, label?)
  removeRawSQLFilter(id)                   getRawSQLFilters()
  validateSQLFilter(sql, signal?): Promise<{valid; matchCount?; error?}>
  getFiltersSQL(): string                  // combined WHERE
  ```
  ⚠️ `RawSQLFilter.sql` is spliced into the WHERE clause unescaped — always `validateSQLFilter` first for user-authored SQL. Window functions are NOT legal in a WHERE clause — the Studio uses its own wrapped `bridge.query` preview for window-bearing conditions (`qc-rules-engine.md`).
- Derived columns: `addDerivedColumn({kind:'expression'|'vector', ...})`, `validateExpression` (SQL-backed VIEW).
- Built-in per-column histograms/value counts/date histograms with brush crossfilter; stats panels via `/advanced`.
- Virtual scrolling (renders ~visible rows + buffer); no pagination. Scale target ~1M rows; keep host queries aggregate/limited — `bridge.query()` materializes JS rows.

## 7. Refresh pattern for corrected data (QuaC's canonical loop)

```
engine mutates quac_work via bridge.query(...DDL/DML...)   → bridge.clearQueryCache()
COPY (SELECT * EXCLUDE (__row__) FROM data ORDER BY __row__) TO 'corrected.parquet' (FORMAT PARQUET)
retrieve bytes (P03-verified path: bridge.export(...) or fallback)   → table.loadData(bytes)
on loadComplete: re-apply annotations from FlagStore (rowId = flag.row), re-set tooltips
```

Fallback (only if P03 finds no byte-retrieval path): chunked `SELECT` via `bridge.query` → serialize to JSON text → `loadData(jsonString)`, capped at 250k rows with a UI notice. Recorded in `architecture.md → Verified facts` either way.

## 8. Self-hosting DuckDB WASM (decided for v1)

Copy bundles from `node_modules/@duckdb/duckdb-wasm/dist/` into the site at build (`scripts/copy-duckdb-assets.mjs` → `dist/duckdb/`), then:

```ts
new WorkerBridge({
  bridgeOptions: {
    workerUrl: `${import.meta.env.BASE_URL}duckdb/<worker>.js`,
    duckdbBundles: {
      mvp: { mainModule: `${BASE}duckdb/duckdb-mvp.wasm`, mainWorker: `${BASE}duckdb/duckdb-browser-mvp.worker.js` },
      eh:  { mainModule: `${BASE}duckdb/duckdb-eh.wasm`,  mainWorker: `${BASE}duckdb/duckdb-browser-eh.worker.js` },
    },
  },
});
```

Priority: `workerFactory > workerUrl > default`. ⚠️ Under the `/quac/` Pages subpath, absolute `/duckdb/...` paths 404 — ALWAYS build URLs from `import.meta.env.BASE_URL`. Exact dist filenames verified in P03 against the installed duckdb-wasm version.

## 9. Theming & misc

- 74 `--dt-*` CSS custom properties; `colorScheme: 'light'|'dark'|'auto'`; `classPrefix` (default `dt`). QuaC maps its severity tokens onto `--dt-annotation-*` (see `ui-design.md`).
- Export dialog (CSV/JSON/Parquet) is a lazy ~71–77 kB chunk; QuaC keeps it enabled on the report grid (harmless, useful).
- Bundle: library JS ~8 kB brotli + styles ~17 kB; the weight is DuckDB WASM itself.
- Stale bits in upstream docs: exported `VERSION` constant says 0.1.0 (trust package.json); `docs/performance.md` lists CJS sizes but the package is ESM-only since 0.4.0.
