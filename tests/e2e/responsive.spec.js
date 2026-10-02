import { expect, test } from '@playwright/test';
import { pages, viewportWidths } from './pages.js';

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
  await expect(page.getByRole('heading', { name: 'The free audit opens soon' })).toBeVisible();
});
