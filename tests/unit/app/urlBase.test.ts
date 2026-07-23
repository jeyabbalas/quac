import { describe, expect, it } from 'vitest';
import { assetUrl, joinBase } from '../../../src/app/urlBase';

describe('joinBase', () => {
  it('joins a trailing-slash base', () => {
    expect(joinBase('/quac/', 'logo/quac-logo.svg')).toBe('/quac/logo/quac-logo.svg');
  });

  it('adds the missing trailing slash', () => {
    expect(joinBase('/quac', 'logo/quac-logo.svg')).toBe('/quac/logo/quac-logo.svg');
  });

  it('never produces a double slash', () => {
    expect(joinBase('/quac/', '/logo/quac-logo.svg')).toBe('/quac/logo/quac-logo.svg');
    expect(joinBase('/quac/', '//logo/quac-logo.svg')).toBe('/quac/logo/quac-logo.svg');
    expect(joinBase('/', '/favicon.svg')).toBe('/favicon.svg');
  });
});

describe('assetUrl (import.meta.env.BASE_URL-derived)', () => {
  // The Vitest 4 node env reports BASE_URL as '/' regardless of the vite `base`
  // (vitest-dev/vitest#8895), so assert derivation invariants rather than the
  // literal '/quac/'. The deployed base is asserted in tests/e2e/smoke.spec.ts.
  it('prefixes the current BASE_URL without doubling slashes', () => {
    const base = import.meta.env.BASE_URL;
    expect(typeof base).toBe('string');
    const url = assetUrl('logo/quac-logo.svg');
    expect(url.startsWith(base)).toBe(true);
    expect(url.endsWith('logo/quac-logo.svg')).toBe(true);
    expect(url.slice(1)).not.toContain('//');
  });
});
