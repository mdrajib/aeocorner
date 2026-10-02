import { expect, test } from '@playwright/test';
import { publicSitePages } from './pages.js';

// The public site must not call out to third-party hosts (no CDNs, no fonts, no trackers). The only
// hosts ever allowed are PostHog and Cloudflare Turnstile — and only when configured, which the
// Playwright web server deliberately is not (playwright.config.js). The CSP unit tests cover the
// configured case.
const ALLOWED_THIRD_PARTY = [/(^|\.)posthog\.com$/, /^challenges\.cloudflare\.com$/];

for (const entry of publicSitePages) {
  test(`only first-party requests: ${entry.name}`, async ({ page, baseURL }) => {
    const ownHost = new URL(baseURL).host;
    const external = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!['http:', 'https:'].includes(url.protocol)) return; // data: and blob: are not network calls
      if (url.host === ownHost) return;
      if (ALLOWED_THIRD_PARTY.some((re) => re.test(url.hostname))) return;
      external.push(request.url());
    });

    await page.goto(entry.path, { waitUntil: 'networkidle' });
    expect(external, `Third-party requests on ${entry.path}`).toEqual([]);
  });
}
