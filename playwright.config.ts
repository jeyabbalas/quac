import { defineConfig, devices } from '@playwright/test';

// Port fixed by preview.strictPort in vite.config.ts.
const BASE_URL = 'http://localhost:4173/quac/';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The perf gate is a stopwatch; it must not run here, where it would be
      // sharing the machine with every other worker.
      testIgnore: /perf\.smoke/,
    },
    {
      // P22 task 2. Still part of the default `npm run test:e2e` — "gated in
      // CI" has to mean the default command — but ALONE: `fullyParallel:false`
      // plus `dependencies` means it starts only after the whole chromium
      // project has finished, so the 60 s measurement is of the app rather
      // than of five competing workers. `retries: 1` because a single
      // stopwatch reading on shared CI hardware is not evidence of a
      // regression; two consecutive ones are.
      name: 'perf',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /perf\.smoke/,
      dependencies: ['chromium'],
      fullyParallel: false,
      retries: 1,
    },
  ],
  webServer: [
    {
      // CI builds before running e2e; locally rebuild so tests never hit a stale dist/.
      command: process.env.CI ? 'npm run preview' : 'npm run build && npm run preview',
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // P16: cross-origin fixture host (ACAO:* except /no-cors/) for the share
      // journeys — a different port makes every fetch genuinely cross-origin.
      command: 'node tests/e2e/support/cors-server.mjs',
      url: 'http://localhost:4199/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
