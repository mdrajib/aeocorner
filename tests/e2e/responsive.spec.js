import { expect, test } from '@playwright/test';
import {
  appPages,
  auditPages,
  openAppPage,
  openAuditPage,
  pages,
  viewportWidths,
} from './pages.js';

// No horizontal overflow on any page at 375 / 768 / 1280 px (a 16px gutter and no sideways scroll).
for (const width of viewportWidths) {
  for (const entry of pages) {
    test(`no horizontal overflow at ${width}px: ${entry.name}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(entry.path);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
    });
  }
}

for (const width of viewportWidths) {
  for (const entry of appPages) {
    test(`no horizontal overflow at ${width}px: ${entry.name} (signed-in area)`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openAppPage(page, request, entry);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
    });
  }
}

for (const width of viewportWidths) {
  for (const entry of auditPages) {
    test(`no horizontal overflow at ${width}px: ${entry.name} (free audit)`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openAuditPage(page, request, entry);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
    });
  }
}

test('the audit form is usable at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');

  const input = page.locator('#hero-url');
  const submit = page.getByRole('button', { name: 'Run my free audit' }).first();
  await input.scrollIntoViewIfNeeded();

  // Both controls sit fully inside the viewport width and are big enough to tap.
  for (const control of [input, submit]) {
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  await input.fill('example.com');
  await submit.click();
  await expect(
    page.getByRole('heading', { name: 'Where should we send your report?' }),
  ).toBeVisible();

  // The next step is as usable on a phone as the first: big controls, nothing outside the viewport.
  for (const next of [
    page.getByLabel('Work email'),
    page.getByRole('button', { name: 'Send my code' }),
  ]) {
    const box = await next.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
