# Nested-data example

Forty study participants in one JSON file, where most variables hold more than
one value — an address, the people in a household, every clinic visit, lab
results by test name. It shows how to check nested data with QuaC: a JSON
Schema that describes the inside of each value, and QC rules written with
DuckDB's list, struct and JSON functions.

| File | What it is |
| --- | --- |
| [`participants.json`](participants.json) | The dataset: 40 records, ~25 with a planted problem |
| [`participants.schema.json`](participants.schema.json) | Its JSON Schema (draft 2020-12, one file) |
| [`participants.quac.csv`](participants.quac.csv) | Ten QC rules: seven checks and three corrections |

**Try it.** In the app, press **Load nested example** on the Load view (it
shows until you load something), then **Run QC**. On the command line:

```sh
quac examples/nested/participants.json \
  --schema examples/nested/participants.schema.json \
  --rules examples/nested/participants.quac.csv
```

The dataset is regenerated, byte for byte, by
`node scripts/generate-nested-example.mjs`, which also lists every planted
problem.

---

## How the data looks to QuaC

QuaC loads a JSON or Parquet dataset into DuckDB, which keeps nested values
nested. Open the **Preview → Dataset** tab and the second header row shows the
type DuckDB chose for each column:

| Column | In the file | DuckDB type |
| --- | --- | --- |
| `address` | one object | `STRUCT(street VARCHAR, city VARCHAR, postcode VARCHAR, country VARCHAR, unit VARCHAR)` |
| `household`, `visits` | a list of objects | `STRUCT(…)[]` — a LIST of structs |
| `phones`, `diagnoses` | a list of strings | `VARCHAR[]` |
| `labs` | an object whose keys vary (test name → result) | `STRUCT(…)` here; a `MAP` when the keys vary a lot |
| `notes` | text in some records, an object in others | `JSON` — DuckDB keeps a field whose type changes as JSON |

Three things DuckDB does to the table — which matter when you write **rules**
(SQL runs on that table):

- **A struct has every key any record has.** One record's address has a `unit`,
  so every address gets a `unit` field — NULL where the record had none.
- **A struct cannot tell a missing field from a null one.** `{}` and
  `{"unit": null}` read the same.
- **ISO dates become `DATE`** when every value is a real date, and stay text
  when one is not (`visits` keeps its dates as text: one record has
  `2024-02-30`).

None of it reaches the **schema checks**: QuaC validates each record exactly as
`participants.json` wrote it. A field a record left out is missing, a field set
to `null` is null, a date is the string the file holds — so an optional field
left out passes, a required one is reported missing, a key only one record has
is reported once, in that record, and an explicit `null` where the schema does
not allow one is reported too.

## Describing nested values in the schema

The schema describes the inside of each value with ordinary JSON Schema:

- **A record** — `type: "object"` with `properties`, `required` and
  `additionalProperties: false` (`address`, `consent`).
- **A list of records** — `type: "array"` with `items` holding the record's
  schema; `minItems` / `maxItems` bound it (`household`, `visits`).
- **A list of values** — `items` with a `pattern`, an `enum` or a `$ref`;
  `uniqueItems: true` forbids repeats (`phones`, `diagnoses`).
- **An open object** — `additionalProperties` gives every value's schema and
  `propertyNames` the keys' pattern (`labs`: any lowercase test name → a
  non-negative number).
- **A value of several shapes** — `anyOf` (`notes`: text, an object, or
  null).

**Preview → JSON Schema** shows it as a data dictionary: each nested variable
keeps its row and is followed by its fields, indented — `address.city`,
`visits[].date`, `household[].relation`.

## Reading the findings

A finding about a value inside a nested column names where it is:

```
130 exceeds the maximum 120 (at household[2].age).
required field 'name' is missing (at household[2]).
field 'pulse' is not allowed here (at visits[1]).
phones[2] repeats phones[1] — items must be unique.
-1.2 is below the minimum 0 (at labs.ldl).
'klingon' is not an allowed value — expected one of 'es', 'fr', 'zh', 'vi', 'ar' (at notes.interpreter).
```

Positions in a list count from 1, as DuckDB SQL counts them and as the QC
report's value inspector (select the cell, press **F2**) numbers them —
`household[2]` is the second person. Inside a `JSON` value an array counts
from 0, as JSONPath does, matching the inspector there too. A field whose name
is not a plain word is quoted: `labs["LDL-C"]`.

## QC rules for nested data

Rules are DuckDB SQL over the `data` view, and DuckDB's nested functions all
work. The ten rules in [`participants.quac.csv`](participants.quac.csv):

| Rule | Checks | The SQL that does it |
| --- | --- | --- |
| R01 | IDs are unique | `unique` (a column assertion) |
| R02 | the household lists the participant | `NOT list_contains(list_transform(household, m -> m.relation), 'self')` |
| R03 | no visit before enrollment | `len(list_filter(visits, v -> TRY_CAST(v.date AS DATE) < TRY_CAST(enrolled_on AS DATE))) > 0` |
| R04 | blood pressure readings over 180 | `list_max(list_transform(visits, v -> v.systolic_bp)) > 180` |
| R05 | diabetes-range HbA1c with no diagnosis | `labs['hba1c'] >= 6.5 AND NOT list_contains(diagnoses, 'E11.9')` |
| R06 | *corrects* diagnosis codes' case (SQL) | `list_transform(__value__, d -> upper(trim(d)))` |
| R07 | *corrects* phone numbers (JavaScript) | `(value) => value.map((p) => p.replace(/[^0-9+]/g, ''))` |
| R08 | *corrects* the country code inside the address | `struct_update(address, country := upper(address.country))` |
| R09 | weight changes of more than 15 kg (a dataset rule) | `SELECT participant_id, list_max(…) - list_min(…) AS weight_change_kg FROM data WHERE …` |
| R10 | a notes object without an interpreter language | `json_type(notes) = 'OBJECT' AND json_extract_string(notes, '$.interpreter') IS NULL` |

Recipes that carry over to your own data:

- **Look inside a list:** `list_filter(xs, x -> …)`, `list_transform(xs, x -> …)`,
  `list_contains(xs, v)`, `len(xs)`, `list_max` / `list_min` / `list_sum`;
  `xs[1]` is the first item.
- **Read a struct field:** `address.city`, or `labs['hba1c']` — the bracket
  form works on a `MAP` too, so it survives DuckDB choosing either.
- **Change one field of a struct:** `struct_update(s, field := value)`.
- **Read JSON:** `json_type(j)`, `json_extract_string(j, '$.key')`. Prefer the
  functions to the `->` / `->>` operators, or wrap those in parentheses: they
  bind more loosely than `AND` and `IS NULL`.
- **Correct a nested value in JavaScript:** the function receives it as the
  JSON it holds — a list as an array, a struct as an object, a date as
  `"2024-05-29"` — and returns the new one.
- **A column assertion compares a whole value:** `in_range(0, 5)` on a list is
  an error (`Cannot compare values of type BIGINT[] …`); write a row rule with a
  list function instead.

Corrections run before the schema is checked, so a value a rule fixes is
validated fixed: R06, R07 and R08 each repair a value the schema would
otherwise reject.

## What a run finds

With the rules applied: **25 errors, 5 warnings, 5 info** across 31 of the 40
rows.

| Row | Participant | Finding |
| --- | --- | --- |
| 2 | P0003 | `address`: required field 'city' is missing |
| 3 | P0004 | R08 corrects `address.country` 'us' → 'US' |
| 4 | P0005 | `household[2].age` 130 exceeds the maximum 120 |
| 5 | P0006 | `household[2].relation` 'cousin' is not allowed |
| 6 | P0007 | R02: nobody in the household is 'self' |
| 7 | P0008 | `phones[2]` repeats `phones[1]` |
| 8 | P0009 | R07 strips '+1 555-010-2030' to '+15550102030' |
| 9 | P0010 | `phones[1]` '5550102' does not match the pattern |
| 10 | P0011 | `visits` has 0 items; at least 1 required |
| 11 | P0012 | `visits[1].date` '2024-02-30' is not a valid date |
| 12 | P0013 | `visits[1].weight_kg` 412 exceeds the maximum 250 |
| 13 | P0014 | `visits[1]` has a field 'pulse' the schema does not allow |
| 14 | P0015 | R03: a visit is dated before enrollment |
| 15 | P0016 | R04: systolic pressure 196 (warning) |
| 16 | P0017 | `visits[1].systolic_bp` 260 exceeds the maximum 250; R04 warns too |
| 17 | P0018 | `labs.ldl` -1.2 is below the minimum 0 |
| 18 | P0019 | `labs.glucose` is text ('high'), not a number |
| 19 | P0020 | `labs` field name 'LDL-C' breaks the lab-name pattern |
| 20 | P0021 | R06 upper-cases 'e11.9' |
| 21 | P0022 | `diagnoses[2]` repeats `diagnoses[1]` |
| 22 | P0023 | `consent`: required field 'signed_on' is missing |
| 23 | P0024 | `notes` 42 is not text or an object |
| 24 | P0025 | `notes.interpreter` 'klingon' is not allowed |
| 25 | P0026 | `age` 17 is below the minimum 18 |
| 26 | P27 | `participant_id` 'P27' does not match `^P[0-9]{4}$` |
| 27 | P0028 | R05: HbA1c 7.9 with no E11.9 diagnosis (warning) |
| 28 | P0029 | R10: notes object without an interpreter (info) |
| 29, 30 | P0030 ×2 | R01: the ID appears twice |
| 32 | P0033 | `address` has a field 'unit' the schema does not allow |
| 33 | P0034 | `household[2]`: required field 'name' is missing |
| — | P0035 | R09: weight changed by 18 kg across visits (dataset finding) |

Rows are numbered from 0, as in the report. In the Excel report a nested
cell holds its value's JSON text (`[{"date":"2024-05-29",…}]`); a value over
Excel's 32,767-character limit is cut, and says so.

## Limits

- **CSV, TSV and Excel files cannot hold nested types.** A cell can hold JSON
  text, though: under an array or object schema QuaC parses it
  (`["a", "b"]`), and reports text that does not parse as a cast finding.
- **Integers past ±(2^53 − 1)** are checked as the nearest number JavaScript
  has; the first one in a column gets a warning with its exact digits.
- **NaN and ±Infinity** inside a value (a Parquet list can hold them) are
  findings of their own: JSON has no word for them.
