/**
 * Deterministic synthetic datasets for the P22 performance gate.
 *
 * Plain ESM, like `cors-server.mjs`, and deliberately BOTH importable and
 * runnable as a script:
 *
 *   import { writePerfParquet } from './support/perfDataset.mjs'   // the spec
 *   node tests/e2e/support/perfDataset.mjs /tmp/perf              // the CLI leg
 *
 * so the browser gate and the headless wall-clock measure the same bytes
 * rather than two datasets that merely sound alike.
 *
 * **No PRNG anywhere.** Every value is a closed-form function of the row
 * index, which is what lets the spec assert exact counts instead of ranges —
 * and, in particular, lets it assert the annotation-cap banner's exact text.
 *
 * The arithmetic has to clear three caps at once, and the middle one is the
 * one that shapes it:
 *
 *   `ROW_CAP_PER_RULE_DEFAULT` 10,000 — a SINGLE rule can never contribute
 *      more than 10,000 flags; past that the engine emits one truncation flag
 *      instead (engine §5). So the violations are spread across THREE rules of
 *      8,000 rather than concentrated in one of 25,000, which keeps every
 *      count on screen exact — and exercises three rules over 100k rows
 *      instead of one.
 *   `ANNOTATION_CAP` 20,000 — 24,000 error cells + 9,000 correction cells is
 *      33,000 candidates, so the paint cap engages and the banner appears.
 *   `FLAG_CAP_DEFAULT` 200,000 — 33,000 is far under it, so nothing anywhere
 *      is truncated.
 *
 * Disjoint windows modulo 100 give the three rules 8,000 rows each:
 *
 *   `i % 100 <  8`            → `age > 120`
 *   `10 <= i % 100 < 18`      → `weight_kg > 400`
 *   `20 <= i % 100 < 28`      → `height_cm > 300`
 *   `i % 100 <  9`            → lowercase `city` (the corrections)
 *
 * Parquet, not CSV, and that is a finding rather than a convenience: V20's
 * delimited-text ceiling is `rows × cols × rowJsonBytes ≈ 10⁹`, and 100k × 20
 * is roughly 380× past it. The PapaParse → wrapped-JSON → `json_extract_string`
 * route cannot reach this gate at all — see the follow-up filed with the phase.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);

export const PERF_ROWS = 100_000;
export const PERF_COLS = 20;
/** Violating rows per validate rule — under the 10,000 per-rule flag cap. */
export const PERF_VIOLATIONS_PER_RULE = 8_000;
/** Three such rules, so: the run's error count. */
export const PERF_ERRORS = PERF_VIOLATIONS_PER_RULE * 3;
/** Rows where `city` is lowercase and the correction rewrites it. */
export const PERF_CITY_CORRECTIONS = 9_000;
/** Cell-scope flags the run produces: the errors plus the corrections. */
export const PERF_CELL_FLAGS = PERF_ERRORS + PERF_CITY_CORRECTIONS;

/** The HESP-width spot-check: as wide as the real schema, a tenth as tall. */
export const WIDE_ROWS = 10_000;
export const WIDE_COLS = 265;

/**
 * Five rules, all executable against the typed parquet columns, with counts
 * that are exact by construction:
 *   PERF001–003  8,000 error cell flags each, on three different columns
 *   PERF004      9,000 info cell flags on `city`, each carrying a correction
 *   PERF005      zero flags — present so `Rules skipped` reading 0 means
 *                something (five ran, none was quietly lint-excluded)
 */
export const PERF_RULES_CSV = [
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled',
  'PERF001,validate,row,age,age > 120,,,error,Age is above the plausible maximum of 120.,true',
  'PERF002,validate,row,weight_kg,weight_kg > 400,,,error,Weight is above the plausible maximum of 400 kg.,true',
  'PERF003,validate,row,height_cm,height_cm > 300,,,error,Height is above the plausible maximum of 300 cm.,true',
  'PERF004,correct,row,city,city <> upper(city),sql,upper(city),info,City normalized to uppercase.,true',
  'PERF005,validate,column,record_id,unique,,,error,Record identifiers must be unique.,true',
].join('\n');

/**
 * The 20 columns, as SQL expressions over the row index `i`.
 * @returns {string}
 */
function perfSelectList() {
  const columns = [
    `'R' || lpad(CAST(i AS VARCHAR), 6, '0') AS record_id`,
    // Three disjoint windows of 8 in every 100 rows — 8,000 violations each.
    `CAST(CASE WHEN i % 100 < 8 THEN 130 + (i % 10) ELSE 20 + (i % 90) END AS INTEGER) AS age`,
    `CAST(CASE WHEN i % 100 >= 10 AND i % 100 < 18 THEN 450 + (i % 10) ELSE 50 + (i % 90) END AS INTEGER) AS weight_kg`,
    `CAST(CASE WHEN i % 100 >= 20 AND i % 100 < 28 THEN 320 + (i % 10) ELSE 140 + (i % 60) END AS INTEGER) AS height_cm`,
    // 9 rows in every 100 need the uppercase correction — exactly 9,000.
    `CASE WHEN i % 100 < 9 THEN 'london' ELSE 'PARIS' END AS city`,
    `CAST((i % 1000) / 10.0 AS DOUBLE) AS score`,
  ];
  // Filler to 20 columns, cycling through three storage types so the parquet
  // is not trivially compressible and the cast plan has real work to do.
  for (let n = 0; columns.length < PERF_COLS; n += 1) {
    const c = String(n).padStart(2, '0');
    if (n % 3 === 0) columns.push(`CAST((i * ${String(n + 7)}) % 100000 AS BIGINT) AS metric_${c}`);
    else if (n % 3 === 1)
      columns.push(`CAST((i % ${String(n + 13)}) / 7.0 AS DOUBLE) AS ratio_${c}`);
    else columns.push(`'v' || CAST(i % ${String(n + 11)} AS VARCHAR) AS label_${c}`);
  }
  return columns.join(',\n    ');
}

/**
 * @param {number} cols
 * @returns {string}
 */
function wideSelectList(cols) {
  const columns = [`'R' || lpad(CAST(i AS VARCHAR), 6, '0') AS record_id`];
  for (let n = 1; n < cols; n += 1) {
    const c = String(n).padStart(3, '0');
    columns.push(
      n % 2 === 0
        ? `CAST((i * ${String(n + 3)}) % 9973 AS BIGINT) AS var_${c}`
        : `'v' || CAST(i % ${String(n + 5)} AS VARCHAR) AS var_${c}`,
    );
  }
  return columns.join(',\n    ');
}

/**
 * @param {string} outPath
 * @param {string} selectList
 * @param {number} rows
 * @returns {Promise<string>}
 */
async function copyToParquet(outPath, selectList, rows) {
  const duckdb = /** @type {typeof import('@duckdb/node-api')} */ (nodeRequire('@duckdb/node-api'));
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    await mkdir(dirname(outPath), { recursive: true });
    await conn.run(
      `COPY (
  SELECT
    ${selectList}
  FROM range(0, ${String(rows)}) t(i)
) TO '${outPath.replaceAll("'", "''")}' (FORMAT PARQUET)`,
    );
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  return outPath;
}

/**
 * 100,000 × 20 → `<dir>/perf_100k_20.parquet`.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function writePerfParquet(dir) {
  return copyToParquet(join(dir, 'perf_100k_20.parquet'), perfSelectList(), PERF_ROWS);
}

/**
 * 10,000 × 265 → `<dir>/perf_wide_10k_265.parquet`.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function writeWideParquet(dir) {
  return copyToParquet(
    join(dir, 'perf_wide_10k_265.parquet'),
    wideSelectList(WIDE_COLS),
    WIDE_ROWS,
  );
}

/**
 * The five rules, written beside the data so the CLI leg can `--rules` it.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function writePerfRules(dir) {
  const path = join(dir, 'perf_rules.quac.csv');
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${PERF_RULES_CSV}\n`, 'utf8');
  return path;
}

// Script mode: `node tests/e2e/support/perfDataset.mjs <dir> [--wide]`.
const invokedAs = process.argv[1] ?? '';
if (invokedAs !== '' && import.meta.url.endsWith(invokedAs.split(/[/\\]/).pop() ?? '\u0000')) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('usage: node tests/e2e/support/perfDataset.mjs <dir> [--wide]');
    process.exit(1);
  }
  const wide = process.argv.includes('--wide');
  const data = wide ? await writeWideParquet(dir) : await writePerfParquet(dir);
  const rules = await writePerfRules(dir);
  console.log(data);
  console.log(rules);
}
