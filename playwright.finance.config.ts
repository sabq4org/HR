import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /finance.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 40_000,
  outputDir: 'test-results-finance',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4319',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command: 'node --import tsx tests/support/finance-server.ts',
    url: 'http://127.0.0.1:4319/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
