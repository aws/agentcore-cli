import { ENV_FILE } from './constants';
import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

function getPort(): number {
  try {
    const raw = readFileSync(ENV_FILE, 'utf-8');
    const match = raw.match(/^PORT=(\d+)$/m);
    if (match) return parseInt(match[1]!, 10);
  } catch {}
  return 8081;
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  outputDir: './test-results',
  reporter: [['html', { open: 'never', outputFolder: './playwright-report' }]],

  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',

  use: {
    baseURL: `http://localhost:${getPort()}`,
    trace: process.env.PLAYWRIGHT_TRACE === 'off' ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
