/**
 * The JSON value of a DuckDB value — the standard text for the types JSON
 * lacks — on its way to the Ajv row loop.
 *
 * JSON Schema judges JSON values, so a Parquet value reaches the validator the
 * way JSON writes it: a number as a number, text as a string, true/false, a
 * list as an array, a struct or map as an object — and the types JSON has no
 * word for as the text a widely accepted standard gives them:
 *
 * | DuckDB                          | JSON value                                  |
 * |---------------------------------|---------------------------------------------|
 * | DATE                            | `2024-01-15` (RFC 3339 full-date)           |
 * | TIME, TIME_NS                   | `08:30:00.5` (ISO 8601 local time)          |
 * | TIME WITH TIME ZONE             | `08:30:00+05:30`, `08:30:00Z` (RFC 3339)    |
 * | TIMESTAMP, _S, _MS, _NS         | `2024-01-15T08:30:00` (ISO 8601 local)      |
 * | TIMESTAMP WITH TIME ZONE        | `2024-01-15T03:00:00Z` (RFC 3339, UTC)      |
 * | INTERVAL                        | `P1Y2M3DT4H5M6.5S` (ISO 8601 duration)      |
 * | BLOB                            | base64 (RFC 4648)                           |
 * | UUID                            | `550e8400-…` (RFC 4122, lowercase)          |
 * | FLOAT                           | the shortest decimal that is that float     |
 *
 * DuckDB's own text differs from every one of these: a space for the `T`,
 * `+00` for an offset, `1 year 2 months` for a duration, `\xFF` escapes for
 * bytes, and a FLOAT widened to `0.10000000149011612`. A naive TIMESTAMP or
 * TIME keeps no offset — it had none — so RFC 3339's `date-time` and `time`,
 * which require one, rightly reject it.
 *
 * Every function takes DuckDB's text (from `CAST(… AS VARCHAR)` or `to_json`)
 * and returns the standard form; text it does not recognise — `infinity`, a
 * BC date, a year past 9999 — comes back unchanged, and fails the formats it
 * should. Pure; runs in the validation worker and in node tests.
 */

/** Which standard rendering a DuckDB scalar type gets (absent ⇒ DuckDB's JSON is already standard). */
export type CanonicalKind = 'timestamp' | 'timestamptz' | 'timetz' | 'interval' | 'blob' | 'float';

const KIND_BY_TYPE: Readonly<Record<string, CanonicalKind>> = {
  TIMESTAMP: 'timestamp',
  DATETIME: 'timestamp',
  TIMESTAMP_S: 'timestamp',
  TIMESTAMP_MS: 'timestamp',
  TIMESTAMP_NS: 'timestamp',
  'TIMESTAMP WITH TIME ZONE': 'timestamptz',
  TIMESTAMPTZ: 'timestamptz',
  'TIME WITH TIME ZONE': 'timetz',
  TIMETZ: 'timetz',
  INTERVAL: 'interval',
  BLOB: 'blob',
  BYTEA: 'blob',
  BINARY: 'blob',
  VARBINARY: 'blob',
  FLOAT: 'float',
  FLOAT4: 'float',
  REAL: 'float',
};

/** The rendering a DuckDB scalar type name (as DESCRIBE prints it) needs, if any. */
export function canonicalKindOf(scalarName: string): CanonicalKind | undefined {
  return KIND_BY_TYPE[scalarName.toUpperCase()];
}

/** `2024-01-15 08:30:00.5` → `2024-01-15T08:30:00.5`. */
export function timestampText(text: string): string {
  return /^-?\d+-\d\d-\d\d \d/.test(text) ? text.replace(' ', 'T') : text;
}

/** An RFC 3339 offset: `Z` for zero, `±hh:mm` otherwise. */
function offsetText(sign: string, hours: string, minutes: string | undefined): string {
  if (hours === '00' && (minutes === undefined || minutes === '00')) return 'Z';
  return `${sign}${hours}:${minutes ?? '00'}`;
}

/** `2024-01-15 03:00:00+00` → `2024-01-15T03:00:00Z`; `…-05:30` keeps its offset. */
export function timestamptzText(text: string): string {
  const m = /^(-?\d+-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?)([+-])(\d\d)(?::?(\d\d))?$/.exec(text);
  if (m === null) return text;
  const [, date = '', time = '', sign = '+', hours = '00', minutes] = m;
  return `${date}T${time}${offsetText(sign, hours, minutes)}`;
}

/** `14:30:45.5-08` → `14:30:45.5-08:00`; a zero offset → `Z`. */
export function timetzText(text: string): string {
  const m = /^(\d\d:\d\d:\d\d(?:\.\d+)?)([+-])(\d\d)(?::?(\d\d))?$/.exec(text);
  if (m === null) return text;
  const [, time = '', sign = '+', hours = '00', minutes] = m;
  return `${time}${offsetText(sign, hours, minutes)}`;
}

/**
 * DuckDB's BLOB text — printable ASCII as itself, every other byte (and `\`
 * and `"`) as `\xHH` — to base64.
 */
export function blobBase64(text: string): string {
  let binary = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\\' && text[i + 1] === 'x' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 2, i + 4))) {
      binary += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16));
      i += 4;
    } else {
      binary += String.fromCharCode(text.charCodeAt(i) & 0xff);
      i += 1;
    }
  }
  return btoa(binary);
}

const INTERVAL_UNIT: Readonly<Record<string, 'Y' | 'M' | 'D'>> = {
  year: 'Y',
  years: 'Y',
  month: 'M',
  months: 'M',
  mon: 'M',
  mons: 'M',
  day: 'D',
  days: 'D',
};

/** A seconds field without the zeros ISO 8601 does not need: `06.500` → `6.5`. */
function secondsText(text: string): string {
  const [whole = '0', fraction] = text.split('.');
  const trimmed = fraction?.replace(/0+$/, '') ?? '';
  return `${String(Number(whole))}${trimmed === '' ? '' : `.${trimmed}`}`;
}

/**
 * DuckDB's INTERVAL text — `1 year 2 months 3 days 04:05:06.5`, `-1 day`,
 * `36:00:00` — to an ISO 8601 duration: `P1Y2M3DT4H5M6.5S`, `-P1D`, `PT36H`,
 * `PT0S` for zero. Components of mixed sign have no ISO 8601 form; they come
 * out signed one by one (`P1M-2D`), which no duration format accepts.
 */
export function intervalIso(text: string): string {
  let rest = text.trim();
  const parts = { Y: 0, M: 0, D: 0 };
  const unit = /^(-?\d+) (years?|months?|mons?|days?)\b\s*/;
  for (let m = unit.exec(rest); m !== null; m = unit.exec(rest)) {
    const key = INTERVAL_UNIT[m[2] ?? ''];
    if (key !== undefined) parts[key] += Number(m[1]);
    rest = rest.slice(m[0].length);
  }
  let hours = 0;
  let minutes = 0;
  let seconds = '0';
  let timeNegative = false;
  if (rest !== '') {
    const t = /^(-?)(\d+):(\d\d):(\d\d(?:\.\d+)?)$/.exec(rest);
    if (t === null) return text;
    timeNegative = t[1] === '-';
    hours = Number(t[2]);
    minutes = Number(t[3]);
    seconds = t[4] ?? '0';
  }
  const hasTime = hours !== 0 || minutes !== 0 || Number(seconds) !== 0;
  const signs = [Math.sign(parts.Y), Math.sign(parts.M), Math.sign(parts.D)];
  if (hasTime) signs.push(timeNegative ? -1 : 1);
  const nonZero = signs.filter((s) => s !== 0);
  const negative = nonZero.length > 0 && nonZero.every((s) => s < 0);
  const mixed = !negative && nonZero.some((s) => s < 0);
  const n = (value: number): number => (negative ? Math.abs(value) : value);

  let out = negative ? '-P' : 'P';
  if (parts.Y !== 0) out += `${String(n(parts.Y))}Y`;
  if (parts.M !== 0) out += `${String(n(parts.M))}M`;
  if (parts.D !== 0) out += `${String(n(parts.D))}D`;
  if (hasTime) {
    const sign = mixed && timeNegative ? '-' : '';
    out += 'T';
    if (hours !== 0) out += `${sign}${String(hours)}H`;
    if (minutes !== 0) out += `${sign}${String(minutes)}M`;
    if (Number(seconds) !== 0) out += `${sign}${secondsText(seconds)}S`;
  }
  return out === 'P' || out === '-P' ? 'PT0S' : out;
}

/**
 * A FLOAT read as a double (`to_json` widens 0.1f to 0.10000000149011612)
 * back to the shortest decimal that is still that float — the number the
 * dataset meant, and the one DuckDB itself prints.
 */
export function float32Shortest(value: number): number {
  if (!Number.isFinite(value)) return value;
  const f = Math.fround(value);
  if (f === 0) return f;
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(f.toPrecision(digits));
    if (Math.fround(candidate) === f) return candidate;
  }
  return f;
}

/** The standard JSON value of one DuckDB value, given the rendering its type needs. */
export function canonicalValue(kind: CanonicalKind, value: unknown): unknown {
  if (kind === 'float') return typeof value === 'number' ? float32Shortest(value) : value;
  if (typeof value !== 'string') return value;
  switch (kind) {
    case 'timestamp':
      return timestampText(value);
    case 'timestamptz':
      return timestamptzText(value);
    case 'timetz':
      return timetzText(value);
    case 'interval':
      return intervalIso(value);
    case 'blob':
      return blobBase64(value);
  }
}
