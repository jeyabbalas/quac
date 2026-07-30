# QuaC

**Under construction.** QuaC is a fully client-side, in-browser data quality control tool for
tabular data — your data never leaves the browser.

## Headless / CLI

The same pipeline runs under plain Node, for data pipelines that want the QC report without a
browser: ingest → schema validation → QC rules and corrections → the styled five-sheet `.xlsx`.

```sh
quac data.csv \
  --schema schemas/ \
  --rules corrections.quac.csv --rules consistency.quac.csv \
  --out reports/ --summary - --fail-on error
```

`--rules` is repeatable and **argument order is correction order** — rules files are applied in
the order you name them, so a correction in the second file sees the first file's output.
`--schema` is repeatable too and takes files, directories or URLs (all one kind, not a mix).
`--summary -` writes the machine-readable run summary to stdout, which then carries nothing else;
progress and warnings always go to stderr.

| Exit | Meaning |
|---|---|
| 0 | Report written (findings do not affect the exit code unless `--fail-on`) |
| 1 | Usage error — bad flags, no dataset, no check source |
| 2 | Input error — unreadable, unsupported or oversize dataset; a multi-sheet workbook with no `--sheet`; a failed URL fetch |
| 3 | Schema-set error — fatal load errors, or a root left ambiguous without a matching `--index` |
| 4 | Run failure |
| 5 | Report or summary could not be written |
| 6 | `--fail-on` threshold met — the report and summary were still written first |
| 130 | Interrupted |

Node ≥ 24 is the declared floor (≥ 20 runs in practice). `quac --help` documents every flag; the
full contract is in [docs/plan/specs/headless.md](docs/plan/specs/headless.md).

Privacy is the same promise as the browser app, kept the same way: an ordinary local process that
reads the files you name and writes the report next to your data. The only network requests it can
make are for `--schema` and `--rules` URLs you pass it. There is no telemetry and no server side.

- Requirements: [docs/BRIEF.md](docs/BRIEF.md)
- Implementation plan: [docs/plan/00-master-plan.md](docs/plan/00-master-plan.md)
- Deployed shell: https://jeyabbalas.github.io/quac/

Full README arrives in P22.
