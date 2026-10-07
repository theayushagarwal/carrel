import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'npm run dev --workspace server',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 20000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SESSION_SECRET: 'test-session-secret-for-playwright-at-least-32-chars!',
        HOST_GRACE_MS: '1500',
        ENABLE_TEST_ENDPOINTS: 'true',
        ROOMS_PER_IP_PER_HOUR: '100',
      },
    },
    {
      command: 'npm run dev --workspace client',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 20000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
