/**
 * The `format` checks QuaC asserts (src/core/schema/formats.ts), against the
 * standards JSON Schema names: RFC 3339 for date/time/date-time/duration,
 * RFC 4122 uuid, RFC 5321/6531 email, RFC 1123/5890–5893 host names, RFC
 * 3986/3987 URIs and IRIs, RFC 6570 templates, ECMA-262 regex. The cases are
 * the official JSON-Schema-Test-Suite's (optional/format, 2020-12) where it
 * has them — the very ones ajv-formats failed — plus what QuaC's data meets
 * daily: DuckDB's timestamp text, `+05` offsets, `PT1.5S`.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKED_FORMATS,
  DURATION,
  NO_OP_FORMATS,
  UUID,
  isDate,
  isDateTime,
  isEmail,
  isHostname,
  isIdnEmail,
  isIdnHostname,
  isIri,
  isIriReference,
  isRegex,
  isTime,
  isUri,
  isUriReference,
  isUriTemplate,
  punycodeDecode,
  punycodeEncode,
  uncheckedFormats,
} from '../../../src/core/schema/formats';
import type { SchemaFile } from '../../../src/core/schema/types';

/** Characters written by code point, so nothing invisible sits in this file. */
const ZWJ = String.fromCodePoint(0x200d);
const ZWNJ = String.fromCodePoint(0x200c);
const KELVIN = String.fromCodePoint(0x212a); // KELVIN SIGN, which looks like K
const DEL = String.fromCodePoint(0x7f);
const PRIVATE_USE = String.fromCodePoint(0xf0000);

const accepts = (check: (s: string) => boolean, values: readonly string[]): void => {
  for (const v of values) expect(check(v), JSON.stringify(v)).toBe(true);
};
const rejects = (check: (s: string) => boolean, values: readonly string[]): void => {
  for (const v of values) expect(check(v), JSON.stringify(v)).toBe(false);
};

describe('date (RFC 3339 full-date)', () => {
  it('accepts real calendar dates, leap days by the Gregorian rule', () => {
    accepts(isDate, [
      '1963-06-19',
      '2020-02-29',
      '0400-02-29',
      '0001-01-01',
      '9999-12-31',
      '1582-10-10',
    ]);
  });
  it('rejects impossible days, other ISO 8601 forms and stray text', () => {
    rejects(isDate, [
      '2021-02-29',
      '2100-02-29',
      '0100-02-29',
      '2020-04-31',
      '2024-00-15',
      '2024-01-00',
      '1998-1-20',
      '20230328',
      '2023-W01',
      '2013-350',
      '+2020-01-01',
      '12020-01-01',
      ' 2024-01-15',
      '2024-01-15 ',
      '2020-01-01Z',
      '2020-01-01 00:00:00Z',
      '1963-06-1৪',
      '',
    ]);
  });
});

describe('time (RFC 3339 full-time)', () => {
  it('requires an offset, Z or ±HH:MM, in either case for Z', () => {
    accepts(isTime, [
      '08:30:06Z',
      '08:30:06z',
      '08:30:06+00:20',
      '08:30:06-08:00',
      '12:34:56-00:00',
    ]);
    rejects(isTime, ['12:00:00', '12:00:00.52', '08:30:06+01', '08:30:06+0130', '08:30:06 PST']);
  });
  it('reads any number of fraction digits as text — fifteen 9s is still second 59', () => {
    accepts(isTime, ['23:20:50.52Z', '00:59:59.999999999999999Z']);
    rejects(isTime, ['08:30:06.Z', '08:30:06,5Z']);
  });
  it('allows second 60 only where it is 23:59:60 in UTC', () => {
    accepts(isTime, [
      '23:59:60Z',
      '23:59:60+00:00',
      '01:29:60+01:30',
      '15:59:60-08:00',
      '00:29:60-23:30',
    ]);
    rejects(isTime, ['22:59:60Z', '23:58:60Z', '23:59:60+01:00', '23:59:60-00:30', '00:00:61Z']);
  });
  it('rejects out-of-range fields', () => {
    rejects(isTime, [
      '24:00:00Z',
      '00:60:00Z',
      '01:02:03+24:00',
      '01:02:03+00:60',
      '24:59:00+01:00',
    ]);
  });
});

describe('date-time (RFC 3339 §5.6)', () => {
  it('accepts T or t between a full-date and a full-time', () => {
    accepts(isDateTime, [
      '1963-06-19T08:30:06.283185Z',
      '1937-01-01T12:00:27.87+00:20',
      '1963-06-19t08:30:06.283185z',
      '1998-12-31T23:59:60Z',
      '1985-04-12T00:59:59.999999999999999Z',
      // How QuaC renders a TIMESTAMPTZ.
      '2024-01-15T03:00:00Z',
    ]);
  });
  it('rejects a space separator, a missing offset, short offsets — DuckDB’s own text among them', () => {
    rejects(isDateTime, [
      '2024-01-15 08:30:00', // DuckDB TIMESTAMP text
      '2024-01-15 03:00:00+00', // DuckDB TIMESTAMPTZ text
      '2024-01-15T08:30:00', // a naive timestamp: valid ISO 8601, not RFC 3339
      '1985-04-12T23:20:50+01',
      '1990-02-31T15:59:59.123-08:00',
      '1985-04-12T23:20Z',
      '2016-12-31T24:59:60+01:00',
      '1985-04-12T23:20:50Z\n',
      '+11963-06-19T08:30:06.283185Z',
    ]);
  });
});

describe('duration (RFC 3339 Appendix A)', () => {
  it('follows the ABNF nesting exactly', () => {
    accepts(
      (s) => DURATION.test(s),
      ['P4DT12H30M5S', 'PT0S', 'P2W', 'P1Y2M', 'P1M2D', 'PT1M2S', 'P01D', 'PT36H'],
    );
    rejects(
      (s) => DURATION.test(s),
      [
        'PT1.5S', // ISO 8601 allows a fraction; RFC 3339 does not
        'P1Y2D',
        'PT1H2S',
        'P1Y2W',
        'P0Y1W',
        'P1WT1H',
        'PT',
        'P',
        'P1YT',
        '-P1D',
        'P-1D',
        'PT0,5S',
        'P1D ',
      ],
    );
  });
});

describe('uuid (RFC 4122)', () => {
  it('is 8-4-4-4-12 hex in any case, nothing around it', () => {
    accepts(
      (s) => UUID.test(s),
      ['2EB8AA08-AA98-11EA-B4AA-73B441D16380', '00000000-0000-0000-0000-000000000000'],
    );
    rejects(
      (s) => UUID.test(s),
      [
        'urn:uuid:2eb8aa08-aa98-11ea-b4aa-73b441d16380',
        '{2eb8aa08-aa98-11ea-b4aa-73b441d16380}',
        '2eb8aa08aa9811eab4aa73b441d16380',
        '2eb8aa08-aa98-11ea-b4aa-73b441d16380\n',
      ],
    );
  });
});

describe('email (RFC 5321 Mailbox)', () => {
  it('accepts quoted local parts, address literals and single-label domains', () => {
    accepts(isEmail, [
      'joe.bloggs@example.com',
      '"joe bloggs"@example.com',
      '"joe@bloggs"@example.com',
      '""@iana.org',
      '"\\""@iana.org',
      'joe.bloggs@[127.0.0.1]',
      'joe.bloggs@[IPv6:::1]',
      'a@[ipv6:::1]',
      'test@io',
      'test@255.255.255.255',
      'te~st@example.com',
    ]);
  });
  it('rejects malformed addresses', () => {
    rejects(isEmail, [
      '2962',
      '@example.com',
      'joe.bloggs@',
      '.test@example.com',
      'te..st@example.com',
      'joe bloggs@example.com',
      'a@b@c.org',
      'test@iana.org.',
      'test@-iana.org',
      'aé@iana.org',
      'a@é.org',
      'joe.bloggs@[127.0.0.300]',
      'test@[RFC-5322-domain-literal]',
      'test@iana.org\n',
    ]);
  });
  it('idn-email widens the local part and the domain to Unicode', () => {
    accepts(isIdnEmail, [
      '실례@실례.테스트',
      'δοκιμή@example.com',
      '"δοκιμή"@example.com',
      'user@café.com',
      '𝕏@example.com',
    ]);
    rejects(isIdnEmail, [
      '2962',
      'user＠example.com',
      'δοκιμή@-example.com',
      'δοκιμή@example.com.',
      'δοκιμή@',
    ]);
  });
});

describe('hostname / idn-hostname (RFC 1123, IDNA2008)', () => {
  it('ASCII host names: labels of 1–63 LDH characters, no hyphen at an end, no trailing dot', () => {
    accepts(isHostname, [
      'www.example.com',
      'hostname',
      '1host',
      'a--b.com',
      'xn--9n2bp8q.xn--9t4b11yi5a',
    ]);
    rejects(isHostname, [
      '',
      '.',
      'example.',
      '.example',
      '-hostname',
      'hostname-',
      'host_name',
      'example.com\n',
      `${KELVIN}elvin.example.com`,
    ]);
    rejects(isHostname, [`${'a'.repeat(64)}.com`, `${'abcdefghij.'.repeat(23)}com`]);
  });
  it('checks an A-label as the U-label it stands for', () => {
    rejects(isHostname, [
      'xn--X', // not Punycode
      'XN--aa---o47jg78q', // "--" in positions 3–4 of the U-label
      'xn--07jt112bpxg.xn--9t4b11yi5a', // U+302E, DISALLOWED
      'xn--hello-txk', // begins with a combining mark
      'xn--al-0ea', // MIDDLE DOT without l·l
      'xn--11b2er09f', // ZERO WIDTH JOINER not after a virama
      'xn--ngb6iyr', // Arabic-Indic digits mixed with extended ones
    ]);
    accepts(isHostname, ['xn--ll-0ea', 'xn--11b2ezcw70k', 'xn--ngba5hb2804a', 'xn--vek778f']);
  });
  it('maps and checks Unicode names (UTS #46 mapping, IDNA2008 rules, Bidi)', () => {
    accepts(isIdnHostname, [
      '실례.테스트',
      'ßς་〇',
      'l·l',
      'α͵β',
      'א׳ב',
      '・ぁ',
      'ب٠ب',
      `क्${ZWJ}ष`,
      `بي${ZWNJ}بي`,
      '１２３',
      'a。b',
      'café.com',
    ]);
    rejects(isIdnHostname, [
      '〮실례.테스트',
      'a·l',
      'α͵S',
      'A׳ב',
      'def・abc',
      'ب٠۰',
      `क${ZWJ}ष`,
      `क्${ZWNJ}षx${ZWNJ}y`,
      '0a.א',
      'aא',
      'א0٠',
      '٠١',
      'a..b',
      'example.',
      '-> $1.00 <--',
      'ü'.repeat(60),
    ]);
  });
  it('Punycode round-trips (RFC 3492 §7.1 sample)', () => {
    const decoded = punycodeDecode('ihqwcrb4cv8a8dqg056pqjye');
    expect(decoded).not.toBeNull();
    expect(punycodeEncode(decoded ?? [])).toBe('ihqwcrb4cv8a8dqg056pqjye');
    expect(punycodeDecode('X')).toBeNull();
  });
});

describe('uri / uri-reference / iri / iri-reference', () => {
  it('URIs by the RFC 3986 grammar', () => {
    accepts(isUri, [
      'http://example.com/a?b=c#d',
      'urn:example:resource',
      'file:/etc/hosts',
      'http://[2001:db8::1]',
      "http://-.~_!$&'()*+,;=:%40:80%2f::::::@example.com",
    ]);
    rejects(isUri, [
      '//foo.bar/?baz=qux#quux',
      'http://example.com:abc/path',
      'http://[::ffff:01.2.3.4]',
      'http:/[::1]',
      'http://ƒøø.com/',
      '/abc',
    ]);
    accepts(isUriReference, ['/abc', 'abc', '#frag', '//host/path', '?q=1']);
    rejects(isUriReference, [
      '/a"b',
      '/[::1]',
      '//example.com:abc/p',
      '//a@b@example.com/',
      '1:b',
      '\\\\WINDOWS\\fileshare',
    ]);
  });
  it('IRIs widen the same grammar to Unicode (and private use in a query)', () => {
    accepts(isIri, [
      'http://ƒøø.ßår/?∂éœ=πîx#πîüx',
      'http://ƒøø.ßår/𐌀',
      `http://ƒøø.ßår/?q=${PRIVATE_USE}`,
    ]);
    rejects(isIri, ['http://ƒøø.ßår/%6G', 'http://ƒøø.ßår/%', '/abc', 'âππ', 'http://ƒøø.ßår/\n']);
    accepts(isIriReference, ['//ƒøø.ßår/?∂éœ=πîx#πîüx', '/âππ', 'âππ', '#ƒrägmênt']);
    rejects(isIriReference, ['#ƒräg\\mênt', '/%A', '/âππ\n']);
  });
});

describe('uri-template (RFC 6570)', () => {
  it('literals and level-4 expressions', () => {
    accepts(isUriTemplate, [
      'http://example.com/dictionary/{term:1}/{term}',
      '{a.b}',
      "a'b",
      '{+path}/here',
      '{?x,y*}',
    ]);
    rejects(isUriTemplate, [
      'http://example.com/dictionary/{term:1}/{term',
      `a${DEL}b`,
      '{a b}',
      '{:1}',
    ]);
  });
});

describe('regex (ECMA-262)', () => {
  it('accepts either dialect but not Annex B identity escapes of letters', () => {
    accepts(isRegex, ['^[a-z]+$', '\\p{L}+', '^\\d{3}\\-\\d{4}$', '\\\\a']);
    rejects(isRegex, ['^(abc]', '\\a', '(?i)x', 'a\\Z']);
  });
});

describe('which formats QuaC checks', () => {
  const file = (json: unknown): SchemaFile => ({
    fileId: 'a.json',
    relativePath: 'a.json',
    retrievalUri: 'quac-set:/a.json',
    raw: '',
    json,
    draft: '2020-12',
    classification: 'schema',
    refs: [],
  });

  it('every standard format is checked; float/double/password/binary are not', () => {
    for (const f of [
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
    ]) {
      expect(CHECKED_FORMATS.has(f), f).toBe(true);
    }
    expect([...NO_OP_FORMATS].sort()).toEqual(['binary', 'double', 'float', 'password']);
  });

  it('uncheckedFormats names only real format keywords that check nothing', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          format: { type: 'string', format: 'date' }, // a property NAMED format
          when: { type: 'string', format: 'datetime' }, // a typo: unchecked
          secret: { type: 'string', format: 'password' }, // registered, checks nothing
          kind: { enum: [{ format: 'not-a-keyword' }] }, // data, not a keyword
          nested: { anyOf: [{ format: 'x-phone' }, { $ref: '#/$defs/d' }] },
        },
      },
      $defs: { d: { format: 'date-time' } },
    };
    expect(uncheckedFormats({ schemas: [file(schema)] })).toEqual([
      'datetime',
      'password',
      'x-phone',
    ]);
  });
});
