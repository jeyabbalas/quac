// Nested-value rules, shared across test tiers: one seed table holding a list
// of structs with DATEs and DECIMALs in it, a struct, a MAP and a list of
// strings; rules that read, correct (SQL and JavaScript) and select those
// values; and the flags both runtimes must produce. The node tier
// (tests/unit/rules/nested.test.ts) and the browser tier
// (tests/browser/rulesNested.browser.test.ts) assert the same expectations —
// the point being that the values a rule shows and a JS correction receives
// are the JSON the data holds on BOTH: a date inside a list read through Arrow
// is epoch milliseconds in the browser and a Date object on Node, and a MAP
// cannot be written back from VARCHAR text at all.
//
// Pure data — no node imports (the browser tier imports this module).

import type { QCFlag } from '../../src/core/flags/flag';

export const NESTED_RULES_SETUP_SQL: readonly string[] = [
  `CREATE OR REPLACE TABLE quac_typed AS SELECT CAST(r AS BIGINT) AS __row__, id, visits, address, labs, tags FROM (VALUES
    (0, 'A', [{'d': DATE '2024-01-05', 'w': 70.5}, {'d': DATE '2024-02-05', 'w': 71.0}],
       {'city': 'Riverton', 'country': 'us'}, MAP {'ldl': 1.25::DECIMAL(10,2)}, ['x', NULL]),
    (1, 'B', [{'d': DATE '2023-12-31', 'w': 80.0}],
       {'city': 'Lakeside', 'country': 'US'}, MAP {'ldl': 2.50::DECIMAL(10,2), 'hdl': 3.75::DECIMAL(10,2)}, ['y']),
    (2, 'C', [], {'city': NULL, 'country': 'mx'}, MAP {}, [])
  ) t(r, id, visits, address, labs, tags)`,
];

export const NESTED_RULES_CSV = [
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled',
  "N1,validate,row,visits,\"len(list_filter(visits, v -> v.d < DATE '2024-01-01')) > 0\",,,warning,A visit before 2024.,true",
  'N2,correct,row,address,address.country <> upper(address.country),sql,"struct_update(address, country := upper(address.country))",info,Country upper-cased.,true',
  'N3,correct,row,visits,len(visits) > 0,js,"(value) => value.map((v) => ({ ...v, w: Math.round(v.w) }))",info,Weights rounded.,true',
  'N4,correct,row,labs,cardinality(labs) > 0,js,"(value) => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v * 2]))",info,Labs doubled.,true',
  'N5,validate,dataset,visits,"SELECT id, visits FROM data WHERE len(visits) = 1",,,info,One visit only.,true',
  'N6,validate,row,tags,"len(list_filter(tags, t -> t IS NULL)) > 0",,,error,A tag is missing.,true',
].join('\r\n');

/**
 * What the run emits. Corrections run first (in file order); validations see
 * the corrected values. Dates inside nested values read as ISO strings,
 * DECIMALs as numbers — on both runtimes.
 */
export const NESTED_RULES_EXPECTED_FLAGS: QCFlag[] = [
  {
    source: 'rules',
    ruleId: 'N2',
    scope: 'cell',
    row: 0,
    column: 'address',
    severity: 'info',
    message: 'Country upper-cased.',
    value: { city: 'Riverton', country: 'us' },
    correction: {
      before: { city: 'Riverton', country: 'us' },
      after: { city: 'Riverton', country: 'US' },
    },
  },
  {
    source: 'rules',
    ruleId: 'N2',
    scope: 'cell',
    row: 2,
    column: 'address',
    severity: 'info',
    message: 'Country upper-cased.',
    value: { city: null, country: 'mx' },
    correction: { before: { city: null, country: 'mx' }, after: { city: null, country: 'MX' } },
  },
  {
    source: 'rules',
    ruleId: 'N3',
    scope: 'cell',
    row: 0,
    column: 'visits',
    severity: 'info',
    message: 'Weights rounded.',
    value: [
      { d: '2024-01-05', w: 70.5 },
      { d: '2024-02-05', w: 71 },
    ],
    correction: {
      before: [
        { d: '2024-01-05', w: 70.5 },
        { d: '2024-02-05', w: 71 },
      ],
      after: [
        { d: '2024-01-05', w: 71 },
        { d: '2024-02-05', w: 71 },
      ],
    },
  },
  {
    source: 'rules',
    ruleId: 'N4',
    scope: 'cell',
    row: 0,
    column: 'labs',
    severity: 'info',
    message: 'Labs doubled.',
    value: { ldl: 1.25 },
    correction: { before: { ldl: 1.25 }, after: { ldl: 2.5 } },
  },
  {
    source: 'rules',
    ruleId: 'N4',
    scope: 'cell',
    row: 1,
    column: 'labs',
    severity: 'info',
    message: 'Labs doubled.',
    value: { ldl: 2.5, hdl: 3.75 },
    correction: { before: { ldl: 2.5, hdl: 3.75 }, after: { ldl: 5, hdl: 7.5 } },
  },
  {
    source: 'rules',
    ruleId: 'N1',
    scope: 'cell',
    row: 1,
    column: 'visits',
    severity: 'warning',
    message: 'A visit before 2024.',
    value: [{ d: '2023-12-31', w: 80 }],
  },
  {
    source: 'rules',
    ruleId: 'N5',
    scope: 'dataset',
    severity: 'info',
    message: 'One visit only. — id=\'B\'; visits=[{"d":"2023-12-31","w":80}]',
  },
  {
    source: 'rules',
    ruleId: 'N6',
    scope: 'cell',
    row: 0,
    column: 'tags',
    severity: 'error',
    message: 'A tag is missing.',
    value: ['x', null],
  },
];

/** The corrected work table, nested columns as JSON text. */
export const NESTED_RULES_CORRECTED_SQL =
  'SELECT __row__::INTEGER AS r, CAST(to_json(visits) AS VARCHAR) AS visits, ' +
  'CAST(to_json(address) AS VARCHAR) AS address, CAST(to_json(labs) AS VARCHAR) AS labs ' +
  'FROM quac_work ORDER BY __row__';

export const NESTED_RULES_CORRECTED_ROWS = [
  {
    r: 0,
    visits: '[{"d":"2024-01-05","w":71.0},{"d":"2024-02-05","w":71.0}]',
    address: '{"city":"Riverton","country":"US"}',
    labs: '{"ldl":2.5}',
  },
  {
    r: 1,
    visits: '[{"d":"2023-12-31","w":80.0}]',
    address: '{"city":"Lakeside","country":"US"}',
    labs: '{"ldl":5.0,"hdl":7.5}',
  },
  { r: 2, visits: '[]', address: '{"city":null,"country":"MX"}', labs: '{}' },
];
