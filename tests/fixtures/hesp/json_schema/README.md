# Household Economic Security Panel (HESP) JSON Schema

This is a hypothetical, survey schema for a tabular (JSON array of objects) household panel dataset. One JSON array element is one sampled household at one annual interview wave.

## Package layout

- `common/defs.json`: shared identifiers, yes/no definitions, imputation flags, and reserved missing-value codes.
- `core/categories/*.json`: category-specific data dictionary and field-level constraints.
- `core/core.schema.json`: modular table schema that composes all category schemas and enforces cross-field routing.
- `core/hesp.core.bundle.schema.json`: standalone equivalent with all references embedded in one file.
- `examples/valid_records.json`: baseline renter with a partner, one child, wage employment, and underbanked service use.
- `examples/valid_owner_selfemployed.json`: owner with a mortgage, no partner or children, self-employment, and full banking access.
- `examples/valid_public_housing_unbanked.json`: public-housing split-off household with children, unemployment, program participation, and unbanked status.
- `examples/invalid_renter_with_mortgage.json`: intentionally invalid record demonstrating a cross-category skip-pattern failure.
- `tools/validate.py`: local validator for either the modular or bundled entry point.
- `requirements.txt`: Python validation dependencies.

## Missing-value conventions

All variables are required so the table remains rectangular.

- `-666`: not applicable because of questionnaire routing.
- `-777`: respondent refused.
- `-888`: respondent did not know or value unavailable.
- `-999`: in-universe value not collected or unavailable after processing.
- Year fields use the corresponding four-digit negative sentinels: `-6666`, `-7777`, `-8888`, and `-9999`.
- String identifiers use labeled string sentinels where needed, such as `"NA"` for a non-split household's origin ID.

## Category variable counts

- `identification.json`: 16 variables
- `household_composition.json`: 28 variables
- `housing.json`: 24 variables
- `employment.json`: 32 variables
- `income.json`: 26 variables
- `social_programs.json`: 24 variables
- `assets.json`: 24 variables
- `debts_credit.json`: 26 variables
- `financial_services.json`: 17 variables
- `hardship_shocks.json`: 23 variables
- `panel_status.json`: 10 variables
- `derived_measures.json`: 15 variables

Total variables per record: **265**.

The core schema contains **171** table-level conditional or consistency blocks in addition to the 12 category references.

## Examples of enforced routing

- Partner demographic and employment fields are `-666` when no resident partner is present.
- Child roster slots are activated by `child_count`; school status is constrained by each child's age.
- Rent, owner value, mortgage, arrears, and rental-assistance fields follow housing tenure and mortgage count.
- Respondent and partner job fields follow labor-force status and pay basis.
- Income, public-program, asset, and debt amounts follow their corresponding receipt or ownership indicators.
- Banking status is checked against account ownership and alternative-financial-service use across category files.
- Shock details and coping methods activate only when their parent indicators are affirmative.
- Follow-up fields depend on next-wave eligibility and split-off status.
- Income-denominator ratios are structurally not applicable when annual income is nonpositive.

## Deliberate limits of JSON Schema

Standard JSON Schema cannot enforce uniqueness of a property such as `record_id` across otherwise different array items, compare two arbitrary properties, or verify arithmetic identities and sums. The schema documents those soft checks with `$comment`, descriptions, and `x-derivation`; a production ETL or quality-control layer should enforce them separately.

The `$id` values use the illustrative namespace `https://schemas.example.org/hesp/`. Replace that namespace before publishing the schema package.
