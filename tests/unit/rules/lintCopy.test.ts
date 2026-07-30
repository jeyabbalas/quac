/**
 * P22 task 1, unit leg — every `LintCode` has a designed message, and a new
 * code cannot ship without one.
 *
 * Two guarantees, and they need each other:
 *
 *  1. **Exhaustiveness, at compile time.** `LINT_POLICY` is declared
 *     `satisfies Record<LintCode, MessagePolicy>`, so adding a member to the
 *     union without coming here fails `npm run typecheck` — CI step 1, before
 *     a single test runs. Same idiom as `tests/unit/ui/copyDeck.test.ts`:
 *     the registry IS the test.
 *  2. **Not fiction.** A registry of codes proves nothing on its own, so this
 *     spec provokes all 21 codes for real — a corpus of deliberately broken
 *     `.quac.csv` files through `parseRuleFile` → `lintRuleFiles` →
 *     `lintRuleFilesWithDataset`, against a real in-memory DuckDB and the
 *     real QuickJS sandbox — and asserts every message it gets back is
 *     designed under that code's policy.
 *
 * The policy split is not stylistic. Four codes across the app quote the
 * engine BY DESIGN, two of them here: `sql-error` and `js-error` are the only
 * things that can say WHICH identifier DuckDB could not bind or WHERE QuickJS
 * gave up. They are `framed` — QuaC's sentence, a colon, then the engine tail
 * — and the predicate checks the engine markers in the prefix only. Every
 * other code is `pure`: no engine vocabulary at all.
 */
import { describe, expect, it } from 'vitest';
import { lintRuleFiles, lintRuleFilesWithDataset } from '../../../src/core/rules/lint';
import { parseRuleFile } from '../../../src/core/rules/parse';
import { createQuickJSSandbox } from '../../../src/core/rules/sandbox';
import type { LintCode, RuleLintIssue } from '../../../src/core/rules/types';
import { designProblems } from '../support/designedMessage';
import type { MessagePolicy } from '../support/designedMessage';
import { openDuckDb } from './support';

/**
 * Every lint code, and how its message is allowed to read.
 *
 * `satisfies` rather than `:` on purpose — the annotation would accept a
 * partial map under `noUncheckedIndexedAccess`; `satisfies` demands all of
 * them and still keeps the literal types.
 */
const LINT_POLICY = {
  'missing-header': 'pure',
  'empty-file': 'pure',
  'bad-enum': 'pure',
  'missing-field': 'pure',
  'duplicate-id': 'pure',
  'bad-id': 'pure',
  'update-on-validate': 'pure',
  'missing-update': 'pure',
  'bad-scope-combo': 'pure',
  'bad-assertion': 'pure',
  'select-in-row-scope': 'pure',
  semicolon: 'pure',
  'value-token-misuse': 'pure',
  // DuckDB's binder names the column or function it could not resolve; that
  // name is the whole diagnosis. QuaC's sentence still opens the message.
  'sql-error': 'framed',
  // Likewise QuickJS: `SyntaxError: unexpected token` with its position.
  'js-error': 'framed',
  'smart-quotes': 'pure',
  'unknown-target': 'pure',
  pertinence: 'pure',
  'pending-data': 'pure',
  'extra-columns': 'pure',
  'empty-comment': 'pure',
} satisfies Record<LintCode, MessagePolicy>;

const HEADER =
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled';

/** The dataset every dry-run lints against: five columns, all typed. */
const DATASET_COLUMNS = ['person_id', 'age', 'city', 'score', 'name'] as const;

const SETUP_SQL = [
  `CREATE TABLE t (__row__ BIGINT, person_id VARCHAR, age INTEGER, city VARCHAR, score DOUBLE, name VARCHAR)`,
  `INSERT INTO t VALUES (0, 'P001', 36, 'london', 88.0, 'Ada'), (1, 'P002', 41, 'Paris', 12.5, 'Grace')`,
  `CREATE VIEW data AS SELECT * FROM t`,
];

/**
 * The injection corpus. Each entry is one deliberately broken file; between
 * them they reach all 21 codes. Kept as literal CSV text rather than fixture
 * files so `tests/fixtures/` and its byte gate stay untouched, and so the
 * defect and the code it provokes sit on the same screen.
 */
const CORPUS: readonly { name: string; csv: string }[] = [
  // missing-header (comment absent) — and, with no data rows under it, empty-file.
  {
    name: 'headerless.quac.csv',
    csv: 'rule_id,rule_type,rule_scope,target_variables,condition\n',
  },
  // bad-enum ×5, one per enumerated column.
  {
    name: 'enums.quac.csv',
    csv: [
      HEADER,
      'E001,validat,row,age,age > 0,,,error,Bad rule_type.,true',
      'E002,validate,rowish,age,age > 0,,,error,Bad rule_scope.,true',
      'E003,correct,row,age,TRUE,lua,42,error,Bad update_language.,true',
      'E004,validate,row,age,age > 0,,,loud,Bad severity.,true',
      'E005,validate,row,age,age > 0,,,error,Bad enabled.,perhaps',
    ].join('\n'),
  },
  // missing-field ×3, bad-id, duplicate-id, empty-comment.
  {
    name: 'fields.quac.csv',
    csv: [
      HEADER,
      ',validate,row,age,age > 0,,,error,Blank rule_id.,true',
      '9bad!,validate,row,age,age > 0,,,error,Malformed rule_id.,true',
      'F003,validate,row,age,,,,error,Blank condition.,true',
      'F004,validate,row,,age > 0,,,error,Blank targets on a row rule.,true',
      'F005,validate,row,age,age > 0,,,error,,true',
      'F005,validate,row,age,age < 200,,,error,Duplicate of F005.,true',
    ].join('\n'),
  },
  // update-on-validate, missing-update, bad-scope-combo ×2, value-token-misuse ×2.
  {
    name: 'shapes.quac.csv',
    csv: [
      HEADER,
      'S001,validate,row,age,age > 0,sql,age + 1,error,Validate must not update.,true',
      'S002,correct,row,age,TRUE,sql,,error,Correct needs an update.,true',
      'S003,correct,column,age,unique,sql,age,error,Correct cannot be column-scope.,true',
      'S004,correct,dataset,age,SELECT 1,sql,age,error,Correct cannot be dataset-scope.,true',
      'S005,validate,row,age,__value__ > 0,,,error,Value token outside a correction.,true',
      'S006,correct,row,age|score,TRUE,sql,0,info,Same expression for two targets.,true',
    ].join('\n'),
  },
  // bad-assertion, select-in-row-scope, semicolon ×2, smart-quotes.
  {
    name: 'grammar.quac.csv',
    csv: [
      HEADER,
      'G001,validate,column,age,not_an_assertion(3),,,error,Unknown assertion name.,true',
      'G002,validate,row,age,SELECT 1,,,error,A SELECT in row scope.,true',
      'G003,validate,row,age,age > 0; age < 200,,,error,Two statements in one cell.,true',
      'G004,validate,dataset,age,SELECT 1;;,,,error,Two trailing semicolons.,true',
      'G005,validate,row,city,city = ‘london’,,,error,Smart quotes from a word processor.,true',
    ].join('\n'),
  },
  // extra-columns.
  {
    name: 'extras.quac.csv',
    csv: [
      `${HEADER},owner`,
      'X001,validate,row,age,age > 0,,,error,An unknown column rides along.,true,dept-b',
    ].join('\n'),
  },
  // unknown-target + pertinence (this file's targets are almost all absent).
  {
    name: 'strangers.quac.csv',
    csv: [
      HEADER,
      'U001,validate,row,alpha,alpha > 0,,,error,Target not in the dataset.,true',
      'U002,validate,row,beta,beta > 0,,,error,Another absent target.,true',
      'U003,validate,row,gamma,gamma > 0,,,error,A third absent target.,true',
      'U004,validate,row,age,age > 0,,,error,The only real target.,true',
    ].join('\n'),
  },
  // sql-error: a function DuckDB has never heard of, on a column that exists
  // (so the rule survives stage 6 and actually reaches the dry-run).
  {
    name: 'engine.quac.csv',
    csv: [
      HEADER,
      'Q001,validate,row,age,no_such_function(age) > 0,,,error,DuckDB cannot bind this.,true',
    ].join('\n'),
  },
  // js-error: an arrow function that does not close.
  {
    name: 'js.quac.csv',
    csv: [
      HEADER,
      'J001,correct,row,city,TRUE,js,"(row) => { return row.city.toUpperCase(",info,Unbalanced parentheses.,true',
    ].join('\n'),
  },
];

const parsed = (): ReturnType<typeof parseRuleFile>[] =>
  CORPUS.map((f) => parseRuleFile(f.csv, f.name));

/** Every issue the corpus produces under the given lint pass. */
async function collectIssues(): Promise<RuleLintIssue[]> {
  const db = await openDuckDb(SETUP_SQL);
  const sandbox = createQuickJSSandbox();
  try {
    const withData = await lintRuleFilesWithDataset(
      parsed(),
      { runner: db.runner, datasetColumns: [...DATASET_COLUMNS] },
      { loadSandbox: () => Promise.resolve(sandbox) },
    );
    // The no-dataset, no-sandbox pass is the ONLY producer of `pending-data`,
    // and it is the state every session opens in — a rules file loaded before
    // the dataset. Both passes belong to the surface.
    const withoutData = await lintRuleFilesWithDataset(parsed(), null);
    return [...withData, ...withoutData, ...lintRuleFiles(parsed())].flatMap((r) => r.issues);
  } finally {
    db.close();
  }
}

let issues: RuleLintIssue[] = [];

describe('lint copy — every LintCode is a designed message', () => {
  it('the corpus provokes every code in the registry', async () => {
    issues = await collectIssues();
    const seen = new Set(issues.map((i) => i.code));
    const missing = Object.keys(LINT_POLICY).filter((code) => !seen.has(code as LintCode));
    expect(missing, 'codes the injection corpus never reached').toEqual([]);
  }, 60_000);

  it('every message produced satisfies its code’s policy', () => {
    expect(issues.length, 'run the corpus test first').toBeGreaterThan(0);
    const failures: string[] = [];
    for (const issue of issues) {
      const policy = LINT_POLICY[issue.code];
      for (const problem of designProblems(issue.message, policy)) {
        failures.push(`[${issue.code} · ${policy}] ${problem}`);
      }
    }
    expect([...new Set(failures)]).toEqual([]);
  });

  it('the two framed codes really do carry the engine’s words — on the far side of the colon', () => {
    const framed = issues.filter((i) => i.code === 'sql-error' || i.code === 'js-error');
    expect(framed.length).toBeGreaterThan(0);
    for (const issue of framed) {
      const cut = issue.message.indexOf(': ');
      expect(cut, `${issue.code} must be "QuaC sentence: engine tail"`).toBeGreaterThan(0);
      // The raw text is preserved for the Studio's detail line, and it is
      // never what opens the message.
      expect(issue.detail, `${issue.code} keeps the raw text on detail`).toBeTruthy();
      expect(issue.message.slice(0, cut)).not.toContain(issue.detail ?? '');
    }
  });

  it('no message leaks an internal table name', () => {
    // `quac_work`, `quac_raw`, `data` — the dry-run SQL is built around them,
    // and a naive `err.message` passthrough puts them on screen.
    for (const issue of issues) {
      expect(issue.message, `${issue.code} names an internal table`).not.toMatch(
        /\bquac_(?:raw|typed|work|display|ingest_tmp)\b/,
      );
    }
  });
});
