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
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The dummy Clerk keys name a real host (e2e-clerk.accounts.dev). Without this the browser downloads Clerk's
        // script from the internet, Clerk cannot load with fake keys, and every form post stalls for seconds.
        // Blocked, the script fails at once and the form is sent straight away (components.js).
        launchOptions: { args: ['--host-resolver-rules=MAP *.accounts.dev ~NOTFOUND'] },
      },
    },
  ],
  webServer: {
    // Build the CSS first so a fresh checkout (where src/web/public/build is git-ignored) works.
    // tests/e2e/server.js is the real app with a fake Clerk and the test database (MySQL must be running).
    command: 'npm run build:css && node tests/e2e/server.js',
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
      // Dummy Clerk keys (valid format, never used to call Clerk) so the app behaves as a configured one.
      // Set explicitly so real keys in a developer's .env can never reach the test server.
      CLERK_PUBLISHABLE_KEY: 'pk_test_ZTJlLWNsZXJrLmFjY291bnRzLmRldiQ',
      CLERK_SECRET_KEY: 'sk_test_e2e_not_real',
      CLERK_WEBHOOK_SECRET: '',
      CLERK_STAFF_PUBLISHABLE_KEY: '',
      CLERK_STAFF_SECRET_KEY: '',
      RESEND_API_KEY: '',
    },
  },
});
