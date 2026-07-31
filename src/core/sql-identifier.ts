/**
 * SQL identifier quoting — QuaC's own copy of what used to be
 * `@jeyabbalas/data-table`'s `quoteIdentifier` export.
 *
 * **Why it is here rather than imported.** This one nine-line function was the
 * single reason the headless CLI's dependency graph reached the data-table
 * package at all: seven `src/core/**` modules imported it, so installing the CLI
 * pulled in a browser grid — CodeMirror, its worker, its stylesheet, all of
 * duckdb-wasm behind it — to build a `"quoted"` string in a program that never
 * renders a table. Lifting it lets `dependencies` shrink to the eight packages
 * the built binary actually imports (packaging.md; `tests/cli/dependencies.test.ts`
 * is the check that keeps it that way).
 *
 * **It is a copy, not a reimplementation, and that is deliberate.** The
 * browser app still runs data-table's grids over the same DuckDB tables these
 * names address, so the two quoting rules have to agree character for
 * character or a column that the grid can address becomes one QuaC cannot.
 * `tests/unit/core/sql-identifier.test.ts` asserts that agreement against the
 * package's own export over the real HESP column vocabulary — the package
 * stays a devDependency, so the test keeps running, in the fast unit tier.
 *
 * The contract, unchanged from upstream: wrap in double quotes, escape
 * embedded double quotes by doubling them (`a"b` → `"a""b"`). Non-ASCII and
 * surrogate pairs pass through — DuckDB stores identifiers as UTF-8. Other
 * ASCII control characters are NOT stripped: DuckDB rejects them at parse time
 * if it dislikes them, and stripping silently would mask whichever upstream
 * layer produced them.
 */

/**
 * Thrown for the two names that can never be quoted into valid SQL. Carries
 * the same `code` upstream's `SQLValidationError` did; nothing in QuaC catches
 * either class, so the change of constructor is unobservable outside this file.
 */
export class SqlIdentifierError extends Error {
  readonly code = 'INVALID_IDENTIFIER';

  constructor(message: string) {
    super(message);
    this.name = 'SqlIdentifierError';
  }
}

/** Quote a table or column name for safe splicing into DuckDB SQL. */
export function quoteIdentifier(name: string): string {
  if (name.length === 0) {
    throw new SqlIdentifierError('SQL identifier must not be empty');
  }
  // NUL truncates identifiers in some downstream tooling and has no legitimate
  // use in a column or table name.
  if (name.includes('\0')) {
    throw new SqlIdentifierError('SQL identifier must not contain NUL bytes');
  }
  return `"${name.replaceAll('"', '""')}"`;
}
