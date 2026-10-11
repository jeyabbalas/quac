// Deterministic generator for the nested-data example (examples/nested/).
//
// Writes examples/nested/participants.json: 40 study participants, each a
// JSON record whose values are nested the ways DuckDB reads nested JSON — a
// struct (`address`, `consent`), lists of structs (`household`, `visits`), lists
// of strings (`phones`, `diagnoses`), an open object of lab results (`labs`)
// and a column whose type varies from record to record (`notes`, which DuckDB
// keeps as JSON). Most records are clean; PROBLEMS below names the ones that
// are not, and why, so the example's README can promise exactly what a run
// finds.
//
// Byte-determinism: two runs write identical bytes (mulberry32, fixed seed,
// no timestamps). Regenerate with `node scripts/generate-nested-example.mjs`;
// `npm run fixtures:check` fails if the committed file drifts from it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'examples', 'nested', 'participants.json');

const SEED = 20261011;

/**
 * @typedef {{ name?: string, relation: string, age: number | null }} Member
 * @typedef {{ date: string, weight_kg: number | null, systolic_bp: number, fasting: boolean, pulse?: number }} Visit
 * @typedef {{
 *   participant_id: string, enrolled_on: string, age: number,
 *   address: { street: string, city?: string, postcode: string, country: string, unit?: string },
 *   household: Member[], phones: string[], visits: Visit[],
 *   labs: Record<string, number | string>, diagnoses: string[],
 *   consent: { data_sharing: boolean, recontact: boolean, signed_on?: string },
 *   notes: string | number | { interpreter?: string, language?: string } | null,
 * }} Participant
 */

/**
 * mulberry32 — the house PRNG (generate-fixtures.mjs uses the same).
 * @param {number} seed
 * @returns {() => number}
 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(SEED);
/** @type {(lo: number, hi: number) => number} */
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
/** @type {<T>(list: readonly T[]) => T} */
const pick = (list) => /** @type {any} */ (list[int(0, list.length - 1)]);
/** @type {(x: number, places: number) => number} */
const round = (x, places) => Number(x.toFixed(places));

const FIRST = ['Ada', 'Grace', 'Alan', 'Katherine', 'Linus', 'Radia', 'Edsger', 'Barbara', 'Donald', 'Hedy', 'Tim', 'Frances', 'Ken', 'Margaret', 'Dennis', 'Shafi'];
const STREETS = ['Oak St', 'Maple Ave', 'Cedar Rd', 'Elm St', 'Birch Ln', 'Willow Way', 'Pine Ct', 'Spruce Dr'];
const CITIES = ['Springfield', 'Riverton', 'Lakeside', 'Fairview', 'Greenville', 'Hillcrest'];
const RELATIONS = ['spouse', 'partner', 'child', 'parent', 'sibling', 'other'];
const LABS = ['glucose', 'hba1c', 'ldl', 'hdl', 'creatinine'];
/** @type {Record<string, [number, number, number]>} */
const LAB_RANGE = { glucose: [70, 180, 0], hba1c: [4.8, 9.5, 1], ldl: [60, 190, 0], hdl: [30, 90, 0], creatinine: [0.5, 1.4, 2] };
const DIAGNOSES = ['E11.9', 'I10', 'E78.5', 'J45.9', 'M54.5'];
const NOTES = ['Prefers morning visits.', 'Hard of hearing — speak up.', 'Travels by bus; allow extra time.'];

/**
 * ISO date `days` after 2024-01-01.
 * @param {number} days
 */
function isoDate(days) {
  const d = new Date(Date.UTC(2024, 0, 1) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * The ISO date `days` after another.
 * @param {string} iso
 * @param {number} days
 */
function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function phone() {
  return `+1555${String(int(1000000, 9999999))}`;
}

/**
 * @param {number} n
 * @returns {Participant}
 */
function participant(n) {
  const id = `P${String(n).padStart(4, '0')}`;
  const name = pick(FIRST);
  const age = int(21, 84);
  const enrolledDay = int(0, 200);
  /** @type {Member[]} */
  const household = [{ name, relation: 'self', age }];
  for (let i = int(0, 3); i > 0; i -= 1) {
    const relation = pick(RELATIONS);
    household.push({
      name: pick(FIRST),
      relation,
      age: relation === 'child' ? int(0, 17) : rand() < 0.15 ? null : int(18, 90),
    });
  }
  /** @type {Visit[]} */
  const visits = [];
  let day = enrolledDay;
  const weight = 55 + rand() * 55;
  for (let i = int(1, 3); i > 0; i -= 1) {
    day += int(14, 60);
    visits.push({
      date: isoDate(day),
      weight_kg: rand() < 0.1 ? null : round(weight + (rand() - 0.5) * 6, 1),
      systolic_bp: int(102, 168),
      fasting: rand() < 0.5,
    });
  }
  /** @type {string[]} */
  const diagnoses = [];
  for (let i = int(0, 2); i > 0; i -= 1) {
    const code = pick(DIAGNOSES);
    if (!diagnoses.includes(code)) diagnoses.push(code);
  }
  /** @type {Record<string, number | string>} */
  const labs = {};
  for (const lab of LABS) {
    if (rand() < 0.7) {
      // HbA1c in the diabetes range only alongside the diabetes code (R05).
      const [lo, hi, places] =
        lab === 'hba1c'
          ? diagnoses.includes('E11.9')
            ? [6.5, 9.5, 1]
            : [4.8, 6.4, 1]
          : (LAB_RANGE[lab] ?? [0, 1, 0]);
      labs[lab] = round(lo + rand() * (hi - lo), places);
    }
  }
  const roll = rand();
  const notes = roll < 0.6 ? null : roll < 0.8 ? pick(NOTES) : { interpreter: pick(['es', 'fr', 'zh']) };
  return {
    participant_id: id,
    enrolled_on: isoDate(enrolledDay),
    age,
    address: {
      street: `${String(int(1, 999))} ${pick(STREETS)}`,
      city: pick(CITIES),
      postcode: String(int(10000, 99999)),
      country: 'US',
    },
    household,
    phones: rand() < 0.3 ? [phone(), phone()] : [phone()],
    visits,
    labs,
    diagnoses,
    consent: { data_sharing: rand() < 0.8, recontact: rand() < 0.6, signed_on: isoDate(enrolledDay) },
    notes,
  };
}

const records = Array.from({ length: 40 }, (_, i) => participant(i + 1));
/**
 * `list[i]`, which the planted cases know is there.
 * @template T
 * @param {readonly T[]} list
 * @param {number} i
 * @returns {T}
 */
function at(list, i) {
  const item = list[i];
  if (item === undefined) throw new Error(`no item ${String(i)}`);
  return item;
}

/** @param {string} id */
const by = (id) => {
  const record = records.find((r) => r.participant_id === id);
  if (record === undefined) throw new Error(`no ${id}`);
  return record;
};

/**
 * The planted problems, by participant. `schema` ones are JSON Schema
 * findings, `rule` ones QC-rule findings, `fixed` ones are corrected by a rule
 * and then pass the schema.
 * @type {[string, 'schema' | 'rule' | 'fixed', string, (r: Participant) => void][]}
 */
export const PROBLEMS = [
  ['P0003', 'schema', 'address has no city (required within address)', (r) => delete r.address.city],
  ['P0004', 'fixed', "address.country 'us' is lowercase — R08 corrects it to 'US'", (r) => { r.address.country = 'us'; }],
  ['P0005', 'schema', 'household[2] is 130 years old (maximum 120)', (r) => { r.household = [at(r.household, 0), { name: 'Edsger', relation: 'parent', age: 130 }]; }],
  ['P0006', 'schema', "household[2].relation 'cousin' is not an allowed value", (r) => { r.household = [at(r.household, 0), { name: 'Hedy', relation: 'cousin', age: 40 }]; }],
  ['P0007', 'rule', "household lists nobody as 'self' (R02)", (r) => { at(r.household, 0).relation = 'other'; }],
  ['P0008', 'schema', 'phones[2] repeats phones[1] (uniqueItems)', (r) => { r.phones = ['+15550104477', '+15550104477']; }],
  ['P0009', 'fixed', "phones[1] '+1 555-010-2030' has spaces and dashes — R07 (JavaScript) strips them", (r) => { r.phones = ['+1 555-010-2030']; }],
  ['P0010', 'schema', "phones[1] '5550102' is too short for the pattern", (r) => { r.phones = ['5550102']; }],
  ['P0011', 'schema', 'visits is empty (minItems 1)', (r) => { r.visits = []; }],
  ['P0012', 'schema', "visits[1].date '2024-02-30' is not a real date", (r) => { at(r.visits, 0).date = '2024-02-30'; }],
  ['P0013', 'schema', 'visits[1].weight_kg 412 is above the maximum 250', (r) => { at(r.visits, 0).weight_kg = 412; }],
  ['P0014', 'schema', "visits[1] has a field 'pulse' the schema does not allow", (r) => { at(r.visits, 0).pulse = 72; }],
  ['P0015', 'rule', 'a visit is dated before enrollment (R03)', (r) => { at(r.visits, 0).date = '2023-12-01'; }],
  ['P0016', 'rule', 'systolic_bp 196 at a visit (R04, warning)', (r) => { at(r.visits, 0).systolic_bp = 196; }],
  ['P0017', 'schema', 'visits[1].systolic_bp 260 is above the maximum 250 (and R04 warns)', (r) => { at(r.visits, 0).systolic_bp = 260; }],
  ['P0018', 'schema', 'labs.ldl -1.2 is below the minimum 0', (r) => { r.labs.ldl = -1.2; }],
  ['P0019', 'schema', "labs.glucose 'high' is text, not a number", (r) => { r.labs.glucose = 'high'; }],
  ['P0020', 'schema', "labs key 'LDL-C' breaks the lab-name pattern", (r) => { r.labs['LDL-C'] = 131; }],
  ['P0021', 'fixed', "diagnoses 'e11.9' is lowercase — R06 corrects it to 'E11.9'", (r) => { r.diagnoses = ['e11.9', 'I10']; }],
  ['P0022', 'schema', 'diagnoses[2] repeats diagnoses[1] (uniqueItems)', (r) => { r.diagnoses = ['I10', 'I10']; }],
  ['P0023', 'schema', 'consent has no signed_on (required within consent)', (r) => delete r.consent.signed_on],
  ['P0024', 'schema', 'notes is the number 42 — text, an object or null expected', (r) => { r.notes = 42; }],
  ['P0025', 'schema', "notes.interpreter 'klingon' is not an allowed language", (r) => { r.notes = { interpreter: 'klingon' }; }],
  ['P0026', 'schema', 'age 17 is below the minimum 18', (r) => { r.age = 17; at(r.household, 0).age = 17; }],
  ['P0027', 'schema', "participant_id 'P27' does not match ^P[0-9]{4}$", (r) => { r.participant_id = 'P27'; }],
  ['P0028', 'rule', 'HbA1c 7.9 with no E11.9 diagnosis (R05)', (r) => { r.labs.hba1c = 7.9; r.diagnoses = r.diagnoses.filter((d) => d !== 'E11.9'); }],
  ['P0029', 'rule', 'notes is an object with no interpreter language (R10)', (r) => { r.notes = { language: 'es' }; }],
  ['P0031', 'rule', 'participant_id repeats P0030 (R01, unique)', (r) => { r.participant_id = 'P0030'; }],
  ['P0033', 'schema', "address has a field 'unit' the schema does not allow", (r) => { r.address.unit = '4B'; }],
  ['P0034', 'schema', "household[2] has no name (required within each member)", (r) => { r.household = [at(r.household, 0), { relation: 'child', age: 9 }]; }],
  ['P0035', 'rule', 'weight drops 18 kg between visits (R09, dataset)', (r) => {
    const base = 84.2;
    r.visits = [
      { date: at(r.visits, 0).date, weight_kg: base, systolic_bp: 128, fasting: true },
      { date: addDays(at(r.visits, 0).date, 42), weight_kg: base - 18, systolic_bp: 124, fasting: false },
    ];
  }],
];

for (const [id, , , apply] of PROBLEMS) apply(by(id));

mkdirSync(dirname(OUT), { recursive: true });
// One record per line: readable, diffable, and still one JSON array.
const text = `[\n${records.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n`;
writeFileSync(OUT, text);
console.log(`generate-nested-example: wrote ${String(records.length)} participants → ${OUT}`);
