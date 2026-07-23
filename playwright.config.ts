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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // CI builds before running e2e; locally rebuild so tests never hit a stale dist/.
    command: process.env.CI ? 'npm run preview' : 'npm run build && npm run preview',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
