/**
 * The `format` checks QuaC asserts, written to the standards JSON Schema
 * names for them (2020-12 Validation §7.3), where ajv-formats is looser or
 * absent:
 *
 *   date, time, date-time  RFC 3339 §5.6: `T` (or `t`) between date and
 *                          time, never a space; an offset of `Z` or `±HH:MM`
 *                          and nothing else (`+05`, `+0530` are not RFC 3339);
 *                          a fraction of any length, read as digits, never as
 *                          a float (fifteen 9s is still second 59); a leap
 *                          second only where it is 23:59:60 in UTC
 *   duration               RFC 3339 Appendix A: whole-number components,
 *                          weeks alone, a `T` always followed by a component
 *   uuid                   RFC 4122: 8-4-4-4-12 hex digits, no `urn:uuid:`
 *   email / idn-email      RFC 5321 Mailbox / RFC 6531: quoted local parts,
 *                          address literals, single-label domains
 *   hostname / idn-hostname RFC 1123 + RFC 5890/5891 (IDNA2008), see below
 *   uri, uri-reference     RFC 3986, from its ABNF
 *   iri, iri-reference     RFC 3987: the same grammar widened by ucschar
 *                          (and iprivate in a query)
 *   uri-template           RFC 6570 level 4
 *   regex                  ECMA-262 core grammar (no Annex B identity escapes)
 *
 * IDNA2008 is approximated, and the approximation is stated here so nobody
 * mistakes it for the registry. A non-ASCII host goes through the runtime's
 * own WHATWG URL parser for UTS #46 mapping only — fullwidth characters and
 * ideographic full stops mapped, NFC applied, Punycode out — and every label
 * then meets the IDNA2008 rules here: the RFC 5892 exceptions; CONTEXTJ (a
 * joiner after a virama, or a non-joiner between joining letters — joining
 * types approximated from scripts plus the Arabic and Syriac right-joining
 * letters); CONTEXTO (middle dot, Greek keraia, Hebrew geresh/gershayim,
 * katakana middle dot, Arabic-Indic digits); the hyphen rules; the "letters,
 * digits and marks only" categories read through `\p{…}`; the RFC 5893
 * Bidi rule (Bidi classes approximated from scripts — JavaScript has no
 * `\p{Bidi_Class}`); and the DNS lengths (63 octets a label, 253 a name).
 * What needs the full derived-property table (an unassigned code point is
 * caught through `\p{Cn}`, as of the runtime's Unicode version) is otherwise
 * not checked.
 *
 * Pure: no Ajv here, so the checks can be tested and reused anywhere.
 */
import type { SchemaSet } from './types';
import { walkSchema } from './schema-walk';

// ---------------------------------------------------------------------------
// RFC 3339 §5.6 — date, time, date-time
// ---------------------------------------------------------------------------

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** RFC 3339 full-date. */
export function isDate(text: string): boolean {
  const m = FULL_DATE.exec(text);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const last = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month] ?? 0);
  return day <= last;
}

/** partial-time time-offset; the fraction is `\d+` text, never parsed as a number. */
const FULL_TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** RFC 3339 full-time: an offset is required; second 60 only at 23:59 UTC. */
export function isTime(text: string): boolean {
  const m = FULL_TIME.exec(text);
  if (m === null) return false;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3]);
  const sign = m[4] === '-' ? -1 : 1;
  const offsetHour = m[5] === undefined ? 0 : Number(m[5]);
  const offsetMinute = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  if (second < 60) return true;
  // A leap second is 23:59:60 UTC: the local time minus the offset.
  const utc =
    (((hour * 60 + minute - sign * (offsetHour * 60 + offsetMinute)) % 1440) + 1440) % 1440;
  return utc === 23 * 60 + 59;
}

/** RFC 3339 date-time: full-date "T" full-time, the `T` in either case. */
export function isDateTime(text: string): boolean {
  const separator = text[10];
  return (
    (separator === 'T' || separator === 't') && isDate(text.slice(0, 10)) && isTime(text.slice(11))
  );
}

// ---------------------------------------------------------------------------
// RFC 3339 Appendix A — duration; RFC 4122 — uuid
// ---------------------------------------------------------------------------

const DUR_TIME = '(?:\\d+H(?:\\d+M(?:\\d+S)?)?|\\d+M(?:\\d+S)?|\\d+S)';
const DUR_DATE = '(?:\\d+Y(?:\\d+M(?:\\d+D)?)?|\\d+M(?:\\d+D)?|\\d+D)';

/** dur-date [dur-time] / dur-time / dur-week, exactly as Appendix A's ABNF nests them. */
export const DURATION = new RegExp(`^P(?:${DUR_DATE}(?:T${DUR_TIME})?|T${DUR_TIME}|\\d+W)$`);

export const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

// ---------------------------------------------------------------------------
// RFC 3986 / RFC 3987 — uri, uri-reference, iri, iri-reference
// ---------------------------------------------------------------------------

const HEXDIG = '[0-9A-Fa-f]';
const PCT = `%${HEXDIG}{2}`;
const SUB_DELIMS = "!$&'()*+,;=";
const UNRESERVED = 'A-Za-z0-9\\-._~';
const UCSCHAR =
  '\\u{A0}-\\u{D7FF}\\u{F900}-\\u{FDCF}\\u{FDF0}-\\u{FFEF}' +
  '\\u{10000}-\\u{1FFFD}\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}\\u{40000}-\\u{4FFFD}' +
  '\\u{50000}-\\u{5FFFD}\\u{60000}-\\u{6FFFD}\\u{70000}-\\u{7FFFD}\\u{80000}-\\u{8FFFD}' +
  '\\u{90000}-\\u{9FFFD}\\u{A0000}-\\u{AFFFD}\\u{B0000}-\\u{BFFFD}\\u{C0000}-\\u{CFFFD}' +
  '\\u{D0000}-\\u{DFFFD}\\u{E1000}-\\u{EFFFD}';
const IPRIVATE = '\\u{E000}-\\u{F8FF}\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}';

const DEC_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])';
const IPV4 = `${DEC_OCTET}(?:\\.${DEC_OCTET}){3}`;
const H16 = `${HEXDIG}{1,4}`;
const LS32 = `(?:${H16}:${H16}|${IPV4})`;
const IPV6 =
  '(?:' +
  [
    `(?:${H16}:){6}${LS32}`,
    `::(?:${H16}:){5}${LS32}`,
    `(?:${H16})?::(?:${H16}:){4}${LS32}`,
    `(?:(?:${H16}:){0,1}${H16})?::(?:${H16}:){3}${LS32}`,
    `(?:(?:${H16}:){0,2}${H16})?::(?:${H16}:){2}${LS32}`,
    `(?:(?:${H16}:){0,3}${H16})?::${H16}:${LS32}`,
    `(?:(?:${H16}:){0,4}${H16})?::${LS32}`,
    `(?:(?:${H16}:){0,5}${H16})?::${H16}`,
    `(?:(?:${H16}:){0,6}${H16})?::`,
  ].join('|') +
  ')';

/** RFC 4291 / RFC 3986 IPv6address — also the `ipv6` of an address literal. */
export const IPV6_ADDRESS = new RegExp(`^${IPV6}$`);
export const IPV4_ADDRESS = new RegExp(`^${IPV4}$`);

function uriPatterns(international: boolean): { absolute: RegExp; reference: RegExp } {
  const unreserved = international ? `${UNRESERVED}${UCSCHAR}` : UNRESERVED;
  const ipLiteral = `\\[(?:${IPV6}|[Vv]${HEXDIG}+\\.[${UNRESERVED}${SUB_DELIMS}:]+)\\]`;
  const regName = `(?:[${unreserved}${SUB_DELIMS}]|${PCT})*`;
  const host = `(?:${ipLiteral}|${IPV4}|${regName})`;
  const userinfo = `(?:[${unreserved}${SUB_DELIMS}:]|${PCT})*`;
  const authority = `(?:${userinfo}@)?${host}(?::[0-9]*)?`;
  const pchar = `(?:[${unreserved}${SUB_DELIMS}:@]|${PCT})`;
  const segment = `${pchar}*`;
  const segmentNz = `${pchar}+`;
  const segmentNzNc = `(?:[${unreserved}${SUB_DELIMS}@]|${PCT})+`;
  const pathAbempty = `(?:\\/${segment})*`;
  const pathAbsolute = `\\/(?:${segmentNz}(?:\\/${segment})*)?`;
  const pathNoscheme = `${segmentNzNc}(?:\\/${segment})*`;
  const pathRootless = `${segmentNz}(?:\\/${segment})*`;
  const query = international ? `(?:${pchar}|[\\/?${IPRIVATE}])*` : `(?:${pchar}|[\\/?])*`;
  const fragment = `(?:${pchar}|[\\/?])*`;
  const tail = `(?:\\?${query})?(?:#${fragment})?`;
  const scheme = '[A-Za-z][A-Za-z0-9+\\-.]*';
  const hierPart = `(?:\\/\\/${authority}${pathAbempty}|${pathAbsolute}|${pathRootless}|)`;
  const relativePart = `(?:\\/\\/${authority}${pathAbempty}|${pathAbsolute}|${pathNoscheme}|)`;
  return {
    absolute: new RegExp(`^${scheme}:${hierPart}${tail}$`, 'u'),
    reference: new RegExp(`^(?:${scheme}:${hierPart}|${relativePart})${tail}$`, 'u'),
  };
}

const URI_PATTERNS = uriPatterns(false);
const IRI_PATTERNS = uriPatterns(true);

export const isUri = (text: string): boolean => URI_PATTERNS.absolute.test(text);
export const isUriReference = (text: string): boolean => URI_PATTERNS.reference.test(text);
export const isIri = (text: string): boolean => IRI_PATTERNS.absolute.test(text);
export const isIriReference = (text: string): boolean => IRI_PATTERNS.reference.test(text);

// ---------------------------------------------------------------------------
// RFC 6570 — uri-template (level 4)
// ---------------------------------------------------------------------------

/**
 * A literal is any character but CTL, SP, DQUOTE, `%` outside a
 * pct-encoding, `<`, `>`, `\`, `^`, `` ` ``, `{`, `|`, `}` — RFC 6570 §2.1's
 * prose, which (unlike a typo in its ABNF, see the errata) allows the
 * apostrophe.
 */
const TEMPLATE_LITERAL = `(?:[^\\u{0}-\\u{20}\\u{7F}"%<>\\\\^\`{|}]|${PCT})`;
const VARCHAR = `(?:[A-Za-z0-9_]|${PCT})`;
const VARSPEC = `${VARCHAR}(?:\\.?${VARCHAR})*(?::[1-9][0-9]{0,3}|\\*)?`;
const EXPRESSION = `\\{[+#./;?&=,!@|]?${VARSPEC}(?:,${VARSPEC})*\\}`;
const URI_TEMPLATE = new RegExp(`^(?:${TEMPLATE_LITERAL}|${EXPRESSION})*$`, 'u');

export const isUriTemplate = (text: string): boolean => URI_TEMPLATE.test(text);

// ---------------------------------------------------------------------------
// regex — ECMA-262 core grammar
// ---------------------------------------------------------------------------

/** Escapes that mean something in a non-Unicode pattern; `\` + any other letter is Annex B only. */
const KNOWN_LETTER_ESCAPES = new Set([
  'b',
  'B',
  'c',
  'd',
  'D',
  'f',
  'k',
  'n',
  'r',
  's',
  'S',
  't',
  'v',
  'w',
  'W',
  'x',
  'u',
]);

/**
 * A regular expression in ECMA-262's own grammar. A pattern valid with the
 * `u` flag is; one valid only without it is too, unless it leans on Annex B's
 * web-compatibility identity escapes (`\a`, `\e`, `\z`…), which the core
 * grammar rejects. `\Z` (a PCRE anchor ECMA-262 lacks) never is.
 */
export function isRegex(text: string): boolean {
  try {
    new RegExp(text, 'u');
    return true;
  } catch {
    // fall through to the non-Unicode grammar
  }
  try {
    new RegExp(text);
  } catch {
    return false;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\') continue;
    const next = text[i + 1] ?? '';
    if (/^[A-Za-z]$/.test(next) && !KNOWN_LETTER_ESCAPES.has(next)) return false;
    i += 1; // skip the escaped character, `\\` included
  }
  return true;
}

// ---------------------------------------------------------------------------
// Punycode (RFC 3492)
// ---------------------------------------------------------------------------

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_CODE_POINT = 0x10ffff;

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

function digitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 22; // 0-9 → 26-35
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
  return BASE;
}

const digitChar = (d: number): string => String.fromCharCode(d < 26 ? d + 0x61 : d + 22);

/** The code points a Punycode string (no `xn--`) encodes, or null when it is not valid Punycode. */
export function punycodeDecode(input: string): number[] | null {
  const output: number[] = [];
  const delimiter = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(delimiter, 0); j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  for (let index = delimiter > 0 ? delimiter + 1 : 0; index < input.length;) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitValue(input.charCodeAt(index));
      index += 1;
      if (digit >= BASE) return null;
      if (digit > Math.floor((MAX_CODE_POINT * 4 - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - oldi, length, oldi === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > MAX_CODE_POINT || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  return output;
}

/** Punycode for a list of code points (RFC 3492 §6.3). */
export function punycodeEncode(codePoints: readonly number[]): string {
  let output = '';
  for (const cp of codePoints) if (cp < 0x80) output += String.fromCharCode(cp);
  const basic = output.length;
  let handled = basic;
  if (basic > 0) output += '-';
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < codePoints.length) {
    let m = MAX_CODE_POINT + 1;
    for (const cp of codePoints) if (cp >= n && cp < m) m = cp;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const cp of codePoints) {
      if (cp < n) delta += 1;
      if (cp !== n) continue;
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
        if (q < t) break;
        output += digitChar(t + ((q - t) % (BASE - t)));
        q = Math.floor((q - t) / (BASE - t));
      }
      output += digitChar(q);
      bias = adapt(delta, handled + 1, handled === basic);
      delta = 0;
      handled += 1;
    }
    delta += 1;
    n += 1;
  }
  return output;
}

// ---------------------------------------------------------------------------
// hostname / idn-hostname — RFC 1123, RFC 5890–5893, UTS #46
// ---------------------------------------------------------------------------

/** RFC 5892 §2.6: exceptions that are PVALID / DISALLOWED whatever their category says. */
const PVALID_EXCEPTIONS = new Set([0x00df, 0x03c2, 0x06fd, 0x06fe, 0x0f0b, 0x3007]);
const DISALLOWED_EXCEPTIONS = new Set([
  0x0640, 0x07fa, 0x302e, 0x302f, 0x3031, 0x3032, 0x3033, 0x3034, 0x3035, 0x303b,
]);
const MIDDLE_DOT = 0x00b7;
const GREEK_KERAIA = 0x0375;
const HEBREW_GERESH = 0x05f3;
const HEBREW_GERSHAYIM = 0x05f4;
const KATAKANA_MIDDLE_DOT = 0x30fb;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;

/** Canonical_Combining_Class = Virama (9), Unicode 15.0 — CONTEXTJ's one data dependency. */
const VIRAMA = new Set([
  0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d3b, 0x0d3c, 0x0d4d, 0x0dca,
  0x0e3a, 0x0eba, 0x0f84, 0x1039, 0x103a, 0x1714, 0x1715, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0x1baa,
  0x1bab, 0x1bf2, 0x1bf3, 0x2d7f, 0xa806, 0xa82c, 0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f,
  0x11046, 0x11070, 0x1107f, 0x110b9, 0x11133, 0x11134, 0x111c0, 0x11235, 0x112ea, 0x1134d, 0x11442,
  0x114c2, 0x115bf, 0x1163f, 0x116b6, 0x1172b, 0x11839, 0x1193d, 0x1193e, 0x119e0, 0x11a34, 0x11a47,
  0x11a99, 0x11c3f, 0x11d44, 0x11d45, 0x11d97, 0x11f41, 0x11f42,
]);

/**
 * Right-joining letters of the Arabic and Syriac blocks (ArabicShaping.txt,
 * Joining_Type=R) — the rest of a joining script's letters are read as
 * dual-joining, an approximation good for the ZWNJ rule's purpose.
 */
const RIGHT_JOINING = new Set([
  0x0622, 0x0623, 0x0624, 0x0625, 0x0627, 0x0629, 0x062f, 0x0630, 0x0631, 0x0632, 0x0648, 0x0671,
  0x0672, 0x0673, 0x0675, 0x0676, 0x0677, 0x0688, 0x0689, 0x068a, 0x068b, 0x068c, 0x068d, 0x068e,
  0x068f, 0x0690, 0x0691, 0x0692, 0x0693, 0x0694, 0x0695, 0x0696, 0x0697, 0x0698, 0x0699, 0x06c0,
  0x06c3, 0x06c4, 0x06c5, 0x06c6, 0x06c7, 0x06c8, 0x06c9, 0x06ca, 0x06cb, 0x06cd, 0x06cf, 0x06d2,
  0x06d3, 0x06d5, 0x06ee, 0x06ef, 0x0759, 0x075a, 0x075b, 0x076b, 0x076c, 0x0771, 0x0773, 0x0774,
  0x0778, 0x0779, 0x0710, 0x0715, 0x0716, 0x0717, 0x0718, 0x0719, 0x071e, 0x0728, 0x072a, 0x072c,
  0x072f, 0x074d,
]);
/** Letters that do not join at all (hamza and its kin). */
const NON_JOINING = new Set([0x0621, 0x0674, 0x06dd]);
const JOINING_SCRIPT =
  /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Mandaic}\p{Script=Manichaean}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Sogdian}\p{Script=Psalter_Pahlavi}]$/u;
const TRANSPARENT = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** Joining_Type, approximated: T for marks and format characters, R/D/U for joining-script letters. */
function joiningType(char: string, cp: number): 'D' | 'R' | 'T' | 'U' {
  if (cp === ZWNJ || cp === ZWJ) return 'U';
  if (TRANSPARENT.test(char)) return 'T';
  if (!JOINING_SCRIPT.test(char) || !/^\p{L}$/u.test(char)) return 'U';
  if (RIGHT_JOINING.has(cp)) return 'R';
  if (NON_JOINING.has(cp)) return 'U';
  return 'D';
}

/**
 * RFC 5892 Appendix A.1/A.2: a ZERO WIDTH JOINER only after a virama; a
 * ZERO WIDTH NON-JOINER after a virama, or between a left/dual-joining and a
 * right/dual-joining letter, transparent characters aside.
 */
function joinerAllowed(chars: readonly string[], cps: readonly number[], i: number): boolean {
  if (VIRAMA.has(cps[i - 1] ?? -1)) return true;
  if (cps[i] === ZWJ) return false;
  let before = i - 1;
  while (before >= 0 && joiningType(chars[before] ?? '', cps[before] ?? 0) === 'T') before -= 1;
  let after = i + 1;
  while (after < cps.length && joiningType(chars[after] ?? '', cps[after] ?? 0) === 'T') after += 1;
  if (before < 0 || after >= cps.length) return false;
  const left = joiningType(chars[before] ?? '', cps[before] ?? 0);
  const right = joiningType(chars[after] ?? '', cps[after] ?? 0);
  return left === 'D' && (right === 'R' || right === 'D');
}

type BidiClass = 'L' | 'R' | 'AL' | 'AN' | 'EN' | 'ES' | 'CS' | 'ET' | 'ON' | 'BN' | 'NSM';

const RTL_SCRIPT_R =
  /^[\p{Script=Hebrew}\p{Script=Samaritan}\p{Script=Nko}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Phoenician}\p{Script=Kharoshthi}\p{Script=Avestan}\p{Script=Old_South_Arabian}\p{Script=Imperial_Aramaic}]$/u;
const RTL_SCRIPT_AL =
  /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Hanifi_Rohingya}\p{Script=Sogdian}]$/u;
const NSM = /^[\p{Mn}\p{Me}]$/u;

/**
 * Bidi_Class, approximated from scripts and a few ranges — JavaScript has no
 * `\p{Bidi_Class}`. Exact for the characters a host name label can hold
 * (letters, digits, marks, the hyphen); `ON` stands in for everything else.
 */
function bidiClass(char: string, cp: number): BidiClass {
  if (NSM.test(char)) return 'NSM';
  if (
    (cp >= 0x30 && cp <= 0x39) ||
    inRange(cp, 0x06f0, 0x06f9) ||
    cp === 0xb2 ||
    cp === 0xb3 ||
    cp === 0xb9 ||
    inRange(cp, 0x2070, 0x2079) ||
    inRange(cp, 0x2080, 0x2089) ||
    inRange(cp, 0xff10, 0xff19) ||
    inRange(cp, 0x1d7ce, 0x1d7ff)
  ) {
    return 'EN';
  }
  if (
    inRange(cp, 0x0600, 0x0605) ||
    inRange(cp, 0x0660, 0x0669) ||
    cp === 0x066b ||
    cp === 0x066c ||
    cp === 0x06dd ||
    inRange(cp, 0x0890, 0x0891) ||
    cp === 0x08e2 ||
    inRange(cp, 0x10e60, 0x10e7e)
  ) {
    return 'AN';
  }
  if (RTL_SCRIPT_R.test(char)) return 'R';
  if (RTL_SCRIPT_AL.test(char)) return 'AL';
  if (cp === 0x2b || cp === 0x2d) return 'ES';
  if (cp === 0x2c || cp === 0x2e || cp === 0x2f || cp === 0x3a || cp === 0xa0) return 'CS';
  if (/^\p{Cf}$/u.test(char)) return 'BN';
  if (/^[\p{L}\p{N}\p{Mc}]$/u.test(char)) return 'L';
  return 'ON';
}

/** RFC 5893 §2, for one label of a Bidi domain name (one with any R, AL or AN character). */
function satisfiesBidiRule(label: string): boolean {
  const chars = Array.from(label);
  const classes = chars.map((c) => bidiClass(c, c.codePointAt(0) ?? 0));
  const first = classes[0];
  if (first !== 'L' && first !== 'R' && first !== 'AL') return false; // rule 1
  let end = classes.length - 1;
  while (end > 0 && classes[end] === 'NSM') end -= 1;
  const last = classes[end];
  if (first === 'L') {
    const allowed = new Set<BidiClass>(['L', 'EN', 'ES', 'CS', 'ET', 'ON', 'BN', 'NSM']);
    return classes.every((c) => allowed.has(c)) && (last === 'L' || last === 'EN'); // rules 5, 6
  }
  const allowed = new Set<BidiClass>(['R', 'AL', 'AN', 'EN', 'ES', 'CS', 'ET', 'ON', 'BN', 'NSM']);
  if (!classes.every((c) => allowed.has(c))) return false; // rule 2
  if (last !== 'R' && last !== 'AL' && last !== 'EN' && last !== 'AN') return false; // rule 3
  return !(classes.includes('EN') && classes.includes('AN')); // rule 4
}

const isRtlLabel = (label: string): boolean =>
  Array.from(label).some((c) => {
    const cls = bidiClass(c, c.codePointAt(0) ?? 0);
    return cls === 'R' || cls === 'AL' || cls === 'AN';
  });

const LETTER_DIGIT = /^[\p{Ll}\p{Lu}\p{Lo}\p{Nd}\p{Lm}\p{Mn}\p{Mc}]$/u;
const IGNORABLE = /^[\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Noncharacter_Code_Point}]$/u;
const UNASSIGNED = /^\p{Cn}$/u;
const GREEK = /^\p{Script=Greek}$/u;
const HEBREW = /^\p{Script=Hebrew}$/u;
const KANA_OR_HAN = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const LEADING_MARK = /^\p{M}/u;

const inRange = (cp: number, lo: number, hi: number): boolean => cp >= lo && cp <= hi;

/** RFC 5892 §2.4/§2.8: the ignorable blocks and the old Hangul jamo. */
function inDisallowedBlock(cp: number): boolean {
  return (
    inRange(cp, 0x20d0, 0x20ff) || // Combining Diacritical Marks for Symbols
    inRange(cp, 0x1d100, 0x1d1ff) || // Musical Symbols
    inRange(cp, 0x1d200, 0x1d24f) || // Ancient Greek Musical Notation
    inRange(cp, 0x1100, 0x11ff) || // Hangul Jamo
    inRange(cp, 0xa960, 0xa97f) || // Hangul Jamo Extended-A
    inRange(cp, 0xd7b0, 0xd7ff) // Hangul Jamo Extended-B
  );
}

/** RFC 5892 §2.2: a character that NFKC + case folding changes is not stable, hence DISALLOWED. */
function isUnstable(char: string): boolean {
  const folded = char.normalize('NFKC').toLowerCase().normalize('NFKC');
  return folded !== char;
}

/**
 * The IDNA2008 rules one U-label must meet (RFC 5891 §5.4, RFC 5892): no
 * hyphen at either end or in positions 3–4, no leading combining mark, the
 * exceptions, the CONTEXTJ and CONTEXTO rules and the letters-and-digits
 * categories. The Bidi rule spans the whole name — `isAsciiDomain`.
 */
export function isIdna2008Label(label: string): boolean {
  const chars = Array.from(label);
  const cps = chars.map((c) => c.codePointAt(0) ?? 0);
  if (cps.length === 0) return false;
  if (label.startsWith('-') || label.endsWith('-')) return false;
  if (chars[2] === '-' && chars[3] === '-') return false;
  if (LEADING_MARK.test(label)) return false;
  const hasArabicIndic = cps.some((cp) => inRange(cp, 0x0660, 0x0669));
  const hasExtendedArabicIndic = cps.some((cp) => inRange(cp, 0x06f0, 0x06f9));
  if (hasArabicIndic && hasExtendedArabicIndic) return false;
  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i] ?? 0;
    const char = chars[i] ?? '';
    if (PVALID_EXCEPTIONS.has(cp)) continue;
    if (DISALLOWED_EXCEPTIONS.has(cp)) return false;
    if (cp < 0x80) {
      if (!/^[a-z0-9-]$/.test(char)) return false;
      continue;
    }
    switch (cp) {
      case MIDDLE_DOT:
        if (cps[i - 1] !== 0x6c || cps[i + 1] !== 0x6c) return false;
        continue;
      case GREEK_KERAIA:
        if (!GREEK.test(chars[i + 1] ?? '')) return false;
        continue;
      case HEBREW_GERESH:
      case HEBREW_GERSHAYIM:
        if (!HEBREW.test(chars[i - 1] ?? '')) return false;
        continue;
      case KATAKANA_MIDDLE_DOT:
        if (!KANA_OR_HAN.test(chars.filter((_, j) => cps[j] !== KATAKANA_MIDDLE_DOT).join('')))
          return false;
        continue;
      case ZWNJ:
      case ZWJ:
        if (!joinerAllowed(chars, cps, i)) return false;
        continue;
      default:
        break;
    }
    if (UNASSIGNED.test(char) || IGNORABLE.test(char) || inDisallowedBlock(cp)) return false;
    if (isUnstable(char)) return false;
    if (!LETTER_DIGIT.test(char)) return false;
  }
  return true;
}

/**
 * The U-label an `xn--` label stands for — canonical Punycode decoding to a
 * valid, non-ASCII label — or null when it stands for none.
 */
function uLabelOf(label: string): string | null {
  const body = label.slice(4).toLowerCase();
  const decoded = punycodeDecode(body);
  if (decoded === null || decoded.length === 0) return null;
  if (decoded.every((cp) => cp < 0x80)) return null;
  if (punycodeEncode(decoded) !== body) return null;
  const uLabel = String.fromCodePoint(...decoded);
  return isIdna2008Label(uLabel) ? uLabel : null;
}

const LDH_LABEL = /^[A-Za-z0-9-]{1,63}$/;

/**
 * A domain written in ASCII, checked label by label: 1–63 LDH characters,
 * no hyphen at either end, an `xn--` label valid Punycode for a valid
 * U-label, at most 253 characters, no empty label (so no leading, trailing
 * or doubled dot) — and, when any label is right-to-left, the Bidi rule on
 * every label (RFC 5893).
 */
function isAsciiDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  const uLabels: string[] = [];
  for (const label of domain.split('.')) {
    if (!LDH_LABEL.test(label)) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    if (/^xn--/i.test(label)) {
      const uLabel = uLabelOf(label);
      if (uLabel === null) return false;
      uLabels.push(uLabel);
    } else {
      uLabels.push(label);
    }
  }
  return !uLabels.some(isRtlLabel) || uLabels.every(satisfiesBidiRule);
}

/** ASCII punctuation no host name holds — it would also steer the URL parser elsewhere. */
const NOT_IN_HOST = /[!"#$%&'()*+,/:;<=>?@[\\\]^_`{|}~]/;

/** Space, a control character, or ASCII punctuation outside LDH. */
function hasNonHostCharacter(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return NOT_IN_HOST.test(name);
}

/**
 * UTS #46 mapping by the runtime's URL parser — fullwidth forms and
 * ideographic full stops mapped, NFC applied, Punycode out. Returns that
 * ASCII form, or null when the parser rejects the name outright.
 */
function uts46ToAscii(name: string): string | null {
  if (hasNonHostCharacter(name)) return null;
  try {
    return new URL(`http://${name}/`).hostname;
  } catch {
    return null;
  }
}

/** RFC 1123 host name, its A-labels checked as IDNA2008 would (RFC 5890 §2.3.2.1). */
export function isHostname(text: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(text)) return false; // ASCII only: `idn-hostname` is the Unicode one
  if (!isAsciiDomain(text)) return false;
  if (/(?:^|\.)xn--/i.test(text) && uts46ToAscii(text) === null) return false;
  return true;
}

/** RFC 5890 internationalised host name (see the module note on the UTS #46 approximation). */
export function isIdnHostname(text: string): boolean {
  if (text === '') return false;
  if (/^[\x21-\x7e]+$/.test(text)) return isHostname(text);
  const ascii = uts46ToAscii(text);
  return ascii !== null && isAsciiDomain(ascii);
}

// ---------------------------------------------------------------------------
// email / idn-email — RFC 5321 Mailbox, RFC 6531
// ---------------------------------------------------------------------------

const ATEXT = "A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~";
const DOT_STRING = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*$`);
const IDN_DOT_STRING = new RegExp(
  `^[${ATEXT}\\u{80}-\\u{10FFFF}]+(?:\\.[${ATEXT}\\u{80}-\\u{10FFFF}]+)*$`,
  'u',
);
const QUOTED_STRING = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/;
const IDN_QUOTED_STRING = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e\u{80}-\u{10FFFF}]|\\[\x20-\x7e])*"$/u;

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** `[1.2.3.4]` or `[IPv6:…]` (the tag in any case). */
function isAddressLiteral(literal: string): boolean {
  if (!literal.startsWith('[') || !literal.endsWith(']')) return false;
  const inner = literal.slice(1, -1);
  if (/^ipv6:/i.test(inner)) return IPV6_ADDRESS.test(inner.slice(5));
  return IPV4_ADDRESS.test(inner);
}

function isMailbox(text: string, international: boolean): boolean {
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) return false;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const localOk = international
    ? IDN_DOT_STRING.test(local) || IDN_QUOTED_STRING.test(local)
    : DOT_STRING.test(local) || QUOTED_STRING.test(local);
  if (!localOk || utf8Length(local) > 64) return false;
  if (domain.startsWith('[')) return isAddressLiteral(domain);
  return international ? isIdnHostname(domain) : isAsciiDomain(domain);
}

export const isEmail = (text: string): boolean => isMailbox(text, false);
export const isIdnEmail = (text: string): boolean => isMailbox(text, true);

// ---------------------------------------------------------------------------
// Which formats QuaC checks
// ---------------------------------------------------------------------------

/** Formats that test a value — standard (§7.3) and the Ajv/OpenAPI extensions that do something. */
export const CHECKED_FORMATS: ReadonlySet<string> = new Set([
  'date',
  'time',
  'date-time',
  'duration',
  'email',
  'idn-email',
  'hostname',
  'idn-hostname',
  'ipv4',
  'ipv6',
  'uri',
  'uri-reference',
  'iri',
  'iri-reference',
  'uuid',
  'uri-template',
  'json-pointer',
  'relative-json-pointer',
  'regex',
  // Ajv / OpenAPI extensions that do check something
  'iso-time',
  'iso-date-time',
  'url',
  'json-pointer-uri-fragment',
  'byte',
  'int32',
  'int64',
]);

/** Registered (Ajv / OpenAPI) but accept every value. */
export const NO_OP_FORMATS: ReadonlySet<string> = new Set([
  'float',
  'double',
  'password',
  'binary',
]);

/**
 * The `format` names a schema set uses that QuaC does not test values
 * against — unknown names (`datetime`, a vendor format) and the no-op ones —
 * sorted, each once. Only real `format` keywords count: a property named
 * `format`, or `"format"` inside an `enum` value, is not one.
 */
export function uncheckedFormats(set: Pick<SchemaSet, 'schemas'>): string[] {
  const found = new Set<string>();
  for (const file of set.schemas) {
    walkSchema(file.json, (node) => {
      const format = node.format;
      if (typeof format === 'string' && !CHECKED_FORMATS.has(format)) found.add(format);
    });
  }
  return [...found].sort();
}
