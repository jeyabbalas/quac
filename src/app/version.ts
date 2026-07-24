/**
 * App version, injected at build time from package.json via a Vite `define`
 * (`__QUAC_VERSION__`). Sheet 5 of the Excel report and any future "about"
 * surface read it here rather than duplicating the version string. Falls back
 * to a dev sentinel under Vitest/`vite dev` where the define may be absent.
 * P20 owns bumping the package version.
 */
declare const __QUAC_VERSION__: string | undefined;

export const APP_VERSION =
  typeof __QUAC_VERSION__ === 'string' && __QUAC_VERSION__ !== '' ? __QUAC_VERSION__ : '0.0.0-dev';
