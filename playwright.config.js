import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build the CSS first so a fresh checkout (where src/web/public/build is git-ignored) works.
    command: 'npm run build:css && node src/web/server.js',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NODE_ENV: 'development',
      APP_ENV: 'development',
      PORT: String(PORT),
      APP_BASE_URL: `http://127.0.0.1:${PORT}`,
      LOG_LEVEL: 'warn',
      // No third-party integrations in the sweep: the third-party-request test depends on this.
      TURNSTILE_SITE_KEY: '',
      POSTHOG_API_KEY: '',
    },
  },
});
