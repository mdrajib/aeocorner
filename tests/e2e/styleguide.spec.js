import { expect, test } from '@playwright/test';

// Collect everything the browser would show in its console, including CSP violations, which arrive
// as console errors ("Refused to execute inline script…"). A strict CSP only works if this stays empty.
function watchConsole(page) {
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`requestfailed: ${req.url()}`));
  return problems;
}

test('the styleguide renders with no console errors, CSP violations or failed requests', async ({
  page,
}) => {
  const problems = watchConsole(page);
  await page.goto('/_styleguide', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { level: 1, name: 'Component styleguide' })).toBeVisible();
  expect(problems).toEqual([]);
});

test('the styleguide shows every component group', async ({ page }) => {
  await page.goto('/_styleguide');
  for (const heading of [
    'Buttons',
    'Form fields',
    'Cards',
    'Tables',
    'Tabs',
    'Badges',
    'Modals',
    'Stat tiles',
    'Result cells and answers',
    'Banners',
    'Empty, loading and error states',
    'Progress stepper',
    'Meters',
    'Toasts',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
  }
});

test('"Couldn\'t check" is its own state and never reads as "Not mentioned"', async ({ page }) => {
  await page.goto('/_styleguide');
  const unknown = page.locator('#results .result-cell[data-state="unknown"]');
  await expect(unknown).toHaveText(/Couldn’t check/);
  await expect(unknown).not.toHaveText(/Not mentioned/);
});

test('tabs switch on click and with the arrow keys', async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto('/_styleguide');
  const overview = page.getByRole('tab', { name: 'Overview' });
  const engines = page.getByRole('tab', { name: 'Engines' });

  await expect(overview).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Overview panel.')).toBeVisible();

  await engines.click();
  await expect(engines).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Engines panel.')).toBeVisible();
  await expect(page.getByText('Overview panel.')).toBeHidden();

  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Competitors' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('Competitors panel.')).toBeVisible();
  expect(problems).toEqual([]);
});

test('the modal opens, traps Escape, and closes from its buttons', async ({ page }) => {
  await page.goto('/_styleguide');
  const dialog = page.locator('dialog#sg-modal');

  await page.getByRole('button', { name: 'Open a dialog' }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Open a dialog' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('a dismissible banner can be closed, and a toast appears and escapes HTML', async ({
  page,
}) => {
  await page.goto('/_styleguide');
  const banner = page.getByText('Fix verified', { exact: true });
  await expect(banner).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();

  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('toast', { detail: { message: '<b>bold</b> & safe', tone: 'info' } }),
    ),
  );
  const toast = page.locator('.toast');
  await expect(toast).toHaveText('<b>bold</b> & safe');
  await expect(toast.locator('b')).toHaveCount(0);
});

test('email previews render', async ({ page }) => {
  const html = await page.request.get('/_styleguide/email/verification-code');
  expect(html.status()).toBe(200);
  expect(await html.text()).toContain('482915');
  const text = await page.request.get('/_styleguide/email/verification-code.txt');
  expect(text.status()).toBe(200);
  expect(await text.text()).toContain('482915');
});
