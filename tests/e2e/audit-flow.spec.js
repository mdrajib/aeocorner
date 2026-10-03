import { expect, test } from '@playwright/test';

// The free audit as a visitor lives it, in a real browser against the e2e server (tests/e2e/server.js): the real form,
// code store and limits, no worker. A test moves an audit along through /__e2e/audit/* where the worker would.
const unique = () => Math.random().toString(36).slice(2, 8);

for (const [label, width] of [
  ['desktop', 1280],
  ['375px', 375],
]) {
  test(`domain in, code out, progress page (${label})`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const domain = `e2e-${unique()}.example.test`;
    const email = `visitor.${unique()}@acme-corp.test`;

    await page.goto('/');
    await page.locator('#hero-url').fill(domain);
    await page.getByRole('button', { name: 'Run my free audit' }).first().click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Where should we send your report?' }),
    ).toBeVisible();
    await page.getByLabel('Work email').fill(email);
    await page.getByRole('button', { name: 'Send my code' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Enter your 6-digit code' }),
    ).toBeVisible();
    const mail = (await (await request.get('/__e2e/mail')).json()).filter((m) => m.to === email);
    const code = mail.at(-1).text.match(/\b(\d{6})\b/)[1];

    await page.getByLabel('Code').fill(code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Start my audit' }).click();
    await expect(page.getByText(/That code isn’t right/)).toBeVisible();

    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Start my audit' }).click();
    await expect(page.getByRole('heading', { level: 1, name: `Checking ${domain}` })).toBeVisible();
    await expect(page.getByText('Waiting to ask ChatGPT')).toBeVisible();

    const jobs = await (await request.get('/__e2e/audit/jobs')).json();
    expect(jobs.filter((j) => j.name === 'audit.run').length).toBeGreaterThanOrEqual(1);
  });

  test(`the live page follows the audit to its report by itself (${label})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { publicId } = await (await request.get('/__e2e/audit/live')).json();

    await page.goto(`/audit/${publicId}/progress`);
    await expect(page.getByRole('heading', { level: 1, name: /^Checking / })).toBeVisible();
    // ChatGPT's answers are in already; the others are not. The stream has to deliver the change, with no reload.
    await expect(page.getByText('Waiting to ask Perplexity')).toBeVisible();

    await request.get(`/__e2e/audit/finish?id=${publicId}`);
    await page.waitForURL(`**/r/${publicId}`, { timeout: 15_000 });

    await expect(page.getByRole('heading', { level: 1, name: /AEO report for / })).toBeVisible();
    await expect(page.getByText('38/100')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start my 14-day trial' })).toBeVisible();
    await expect(page.getByText('one-sample snapshot')).toBeVisible();
  });
}

test('a report with an engine that could not be checked says so in words', async ({
  page,
  request,
}) => {
  const f = await (await request.get('/__e2e/fixtures')).json();
  await page.goto(`/r/${f.audits.partial}`);
  await expect(page.getByText('Some of this audit is incomplete')).toBeVisible();
  const gemini = page.locator('[data-engine="gemini"]');
  await expect(gemini.getByText('Couldn’t check', { exact: true })).toBeVisible();
  await expect(gemini.getByText('Not mentioned')).toHaveCount(0);
});

test('an unknown report address is a plain 404', async ({ page }) => {
  const response = await page.goto('/r/01HZZZZZZZZZZZZZZZZZZZZZZZ');
  expect(response.status()).toBe(404);
});
