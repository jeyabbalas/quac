# Nested stress fixtures (vendored)

Two upstream test fixtures, copied byte for byte, so QuaC's tests run against
exactly what the packages it depends on test themselves against:

| File | Source | Upstream commit | SHA-256 |
| --- | --- | --- | --- |
| `nested-stress-tests.json` | [data-table `tests/fixtures/datasets/json/nested-stress-tests.json`](https://github.com/jeyabbalas/data-table/blob/main/tests/fixtures/datasets/json/nested-stress-tests.json) | `2bca6ba4` (2026-10-05) | `cee2e069e011ee35350d9d2c7174164111037c6c11e2acf7b6853bf6ca7a520a` |
| `nested-stress-tests.schema.json` | [json-schema-to-data-dictionary `tests/fixtures/single_schema/nested-stress-tests-dataset.json`](https://github.com/jeyabbalas/json-schema-to-data-dictionary/blob/main/tests/fixtures/single_schema/nested-stress-tests-dataset.json) | `ceb49800` (2026-10-11) | `1aa7d548d1b2104cf89ffa4eefb3761d05278b11756dc6785512c5ba7e0f986b` |

The dataset is 1,000 records × 21 columns covering every nested shape DuckDB
reads from JSON — lists of scalars, structs, lists of structs, maps, JSON
columns, five levels of structs, keys that need quoting — with NULL at every
level and numeric edges past 2^53. The schema describes it exactly: the data
is valid against it. Rows 0–11 are showcase rows (see the schema's
`x-showcase-rows`).

`stress_expected_flags.json` is what QuaC must report for the pair: no error,
one precision warning per column that holds an integer past ±(2^53 − 1) (with
the integer's exact digits), and the schema's root `$comment` as an advisory.
Both runtimes assert it — `tests/unit/headless/nestedParity.test.ts` on
native DuckDB, `tests/browser/nested.browser.test.ts` on duckdb-wasm — so the
two cannot drift apart. Before nested support, QuaC reported 15,308 errors for
this valid file: every list, struct and map cell, cast to text and then
rejected as text.

To refresh the copies, copy the two files again from the upstream `main`
branches, update the table above, and re-run the parity tests.
