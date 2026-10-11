# JSON Schema conformance fixtures

Small JSON datasets, each with the JSON Schema it is checked against, built to
break naive validation: ISO date-times with and without offsets (and the
malformed ones RFC 3339 rejects), `null` beside a missing key — at the top
level and inside objects — strings that look like numbers and numbers in
string columns, integers past 2^53 and 2^64, decimals under `multipleOf`,
UUIDs in both cases and with a `urn:uuid:` prefix, records equal as JSON but
written differently, conditions on missing properties, and the root keywords
that judge the dataset as a whole (`prefixItems`, `contains`, `maxItems`,
`uniqueItems`, a `$ref` root).

`tests/unit/headless/jsonConformance.test.ts` validates each file twice — with
QuaC's pipeline (`runQuac`), and with QuaC's validator run directly on the
parsed document, as any JSON Schema validator would — and requires the two to
agree, record by record and key by key. QuaC's conventions are folded in where
they are one finding for many: a required variable absent from every record is
one column flag, a column the schema rejects is one column flag, and an
integer past ±(2^53 − 1) adds a warning.

Most cases were found in the October 2026 correctness review (cases e1–e13 of
its differential oracle).
