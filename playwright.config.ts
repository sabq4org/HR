import { defineConfig, devices } from '@playwright/test';

// Explicitly opt in to the authorized synthetic preview; never accept arbitrary live targets.
const hostedPreview = process.env.HR_TEST_HOSTED === 'true';
export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: 'finance.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: hostedPreview
      ? 'https://hr-production-90b34ef5.up.railway.app'
      : 'http://127.0.0.1:4318',
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
  webServer: hostedPreview
    ? undefined
    : {
        command: 'npm run preview',
        url: 'http://127.0.0.1:4318/api/health',
        env: { PORT: '4318', HR_DB_PATH: ':memory:' },
        reuseExistingServer: false,
        timeout: 30_000,
      },
});
