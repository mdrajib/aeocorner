import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { appPages, openAppPage, pages } from '../pages.js';

// WCAG 2.1 AA (MVP §10). The gate is zero serious or critical violations on every registered page.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function describeViolations(violations) {
  return violations
    .map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help}\n${v.nodes.map((n) => `   ${n.target.join(' ')}`).join('\n')}`,
    )
    .join('\n');
}

async function expectNoSeriousViolations(page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(blocking, describeViolations(blocking)).toEqual([]);
}

for (const entry of pages) {
  test(`a11y: ${entry.name} (${entry.path})`, async ({ page }) => {
    const response = await page.goto(entry.path);
    expect(response.status()).toBe(entry.status ?? 200);
    await expectNoSeriousViolations(page);
  });
}

for (const entry of appPages) {
  test(`a11y: ${entry.name} (signed-in area)`, async ({ page, request }) => {
    const response = await openAppPage(page, request, entry);
    expect(response.status()).toBe(entry.status ?? 200);
    await expectNoSeriousViolations(page);
  });
}

test('a11y: team page with the invite form in its error state', async ({ page, request }) => {
  await openAppPage(
    page,
    request,
    appPages.find((p) => p.name === 'team'),
  );
  await page.locator('#invite-email').fill('not-an-email');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.locator('#invite-email-error')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('a11y: organization switcher open', async ({ page, request }) => {
  await openAppPage(
    page,
    request,
    appPages.find((p) => p.name === 'org-home'),
  );
  await page.locator('summary', { hasText: 'Acme Dental' }).click();
  await expect(page.getByRole('link', { name: '+ Create another organization' })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('a11y: home with the audit form in its error state', async ({ page }) => {
  await page.goto('/');
  await page.locator('#hero-url').fill('not a website');
  await page.getByRole('button', { name: 'Run my free audit' }).first().click();
  await expect(page.locator('#hero-url-error')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('a11y: styleguide with the modal open', async ({ page }) => {
  await page.goto('/_styleguide');
  await page.getByRole('button', { name: 'Open a dialog' }).click();
  await expect(page.locator('dialog#sg-modal')).toBeVisible();
  await expectNoSeriousViolations(page);
});

test('a11y: mobile menu open', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await page.locator('summary', { hasText: 'Menu' }).click();
  await expectNoSeriousViolations(page);
});
