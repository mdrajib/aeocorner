import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// The free tools in a real browser (Milestone 17): a visitor fills in the form and gets the answer, with JavaScript off
// and on, and the page's content policy is not tripped. The e2e server plants three sites (tests/e2e/server.js).
const PATH = '/tools/robots-txt-checker';

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the form posts and the answer is the same page with the result in it', async ({ page }) => {
    await page.goto(PATH);
    await page.getByLabel('Website to check').fill('blocks-ai.example.test');
    await page.getByRole('button', { name: 'Check my robots.txt' }).click();

    await expect(page).toHaveURL(/\/tools\/robots-txt-checker/);
    await expect(page.locator('#result')).toContainText('robots.txt blocks 1 of');
    await expect(page.locator('#result')).toContainText('OAI-SearchBot');
    await expect(page.locator('#result')).toContainText('Blocked');
    // The answer is private to the visitor.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('a mistake in the address is shown beside the field, and what was typed is kept', async ({
    page,
  }) => {
    await page.goto(PATH);
    await page.getByLabel('Website to check').fill('not a website');
    await page.getByRole('button', { name: 'Check my robots.txt' }).click();
    await expect(page.getByText('That doesn’t look like a website address')).toBeVisible();
    await expect(page.getByLabel('Website to check')).toHaveValue('not a website');
  });
});

test('with JavaScript: no robots.txt is an answer, and a site that did not answer is “Couldn’t check”', async ({
  page,
}) => {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));

  await page.goto(PATH);
  await page.getByLabel('Website to check').fill('open.example.test');
  await page.getByRole('button', { name: 'Check my robots.txt' }).click();
  await expect(page.locator('#result')).toContainText(
    'no robots.txt, so every AI crawler is allowed',
  );
  await expect(page.locator('#result')).not.toContainText('Couldn’t check');

  await page.getByLabel('Website to check').fill('down.example.test');
  await page.getByRole('button', { name: 'Check my robots.txt' }).click();
  await expect(page.locator('#result')).toContainText('Couldn’t check');
  await expect(page.locator('#result')).toContainText('took too long');
  await expect(page.locator('#result')).not.toContainText('no robots.txt');

  expect(problems, 'no console error, which includes a content policy violation').toEqual([]);
});

test('the hub lists the tool, and the tool page and the hub link to each other', async ({
  page,
}) => {
  await page.goto('/tools');
  await page.getByRole('link', { name: 'Robots.txt checker for AI crawlers' }).click();
  await expect(page).toHaveURL(/\/tools\/robots-txt-checker$/);
  await page.getByRole('link', { name: 'Free tools', exact: true }).first().click();
  await expect(page).toHaveURL(/\/tools$/);
});

test.describe('the structured data validator', () => {
  const VALIDATOR = '/tools/structured-data-validator';
  const org = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Acme',
    url: 'https://acme-test.com',
  };

  test.describe('without JavaScript', () => {
    // With JavaScript off Playwright cannot scroll a button into view, and this form is taller than the window.
    test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 1600 } });

    test('pasted code is checked, and a wrong value is named', async ({ page }) => {
      await page.goto(VALIDATOR);
      await page
        .getByLabel('Or paste your JSON-LD')
        .fill(JSON.stringify({ ...org, url: 'acme-test.com' }));
      await page.getByRole('button', { name: 'Check my structured data' }).click();
      await expect(page.locator('#result')).toContainText('1 problem in 1 block');
      await expect(page.locator('#result')).toContainText('$.url');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    });

    test('giving both an address and code is explained beside the field', async ({ page }) => {
      await page.goto(VALIDATOR);
      await page.getByLabel('Page address').fill('acme-test.com/about');
      await page.getByLabel('Or paste your JSON-LD').fill('{}');
      await page.getByRole('button', { name: 'Check my structured data' }).click();
      await expect(page.getByText('Use one or the other')).toBeVisible();
      await expect(page.getByLabel('Page address')).toHaveValue('acme-test.com/about');
    });
  });

  test('with JavaScript: a valid block, then the same page again with a block that is not JSON', async ({
    page,
  }) => {
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(VALIDATOR);
    await page.getByLabel('Or paste your JSON-LD').fill(JSON.stringify(org));
    await page.getByRole('button', { name: 'Check my structured data' }).click();
    await expect(page.locator('#result')).toContainText('no errors found');
    await page.getByLabel('Or paste your JSON-LD').fill('{ "@type": ');
    await page.getByRole('button', { name: 'Check my structured data' }).click();
    await expect(page.locator('#result')).toContainText('Not valid JSON');
    expect(problems).toEqual([]);
  });
});

test.describe('the sitemap checker', () => {
  const SITEMAP = '/tools/sitemap-checker';

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });

    test('a site with a sitemap: found, pointed to, counted, and some addresses quoted', async ({
      page,
    }) => {
      await page.goto(SITEMAP);
      await page.getByLabel('Website or sitemap address').fill('maps.example.test');
      await page.getByRole('button', { name: 'Check my sitemap' }).click();
      await expect(page.locator('#result')).toContainText(
        'Your sitemap is at https://maps.example.test/sitemap.xml, and robots.txt points to it',
      );
      await expect(page.locator('#result')).toContainText('3 of 3');
      await expect(page.locator('#result')).toContainText('https://maps.example.test/pricing');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    });
  });

  test('with JavaScript: no sitemap is an answer, and a site that did not answer is “Couldn’t check”', async ({
    page,
  }) => {
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(SITEMAP);
    await page.getByLabel('Website or sitemap address').fill('open.example.test');
    await page.getByRole('button', { name: 'Check my sitemap' }).click();
    await expect(page.locator('#result')).toContainText('found no sitemap at the usual addresses');
    await expect(page.locator('#result')).not.toContainText('Couldn’t check');

    await page.getByLabel('Website or sitemap address').fill('down.example.test');
    await page.getByRole('button', { name: 'Check my sitemap' }).click();
    await expect(page.locator('#result')).toContainText('Couldn’t check');
    await expect(page.locator('#result')).not.toContainText('found no sitemap');
    expect(problems).toEqual([]);
  });
});

test.describe('the robots.txt generator', () => {
  const GENERATOR = '/tools/robots-txt-generator';

  test.describe('without JavaScript', () => {
    // With JavaScript off Playwright cannot scroll a button into view, and this form is taller than the window.
    test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 4000 } });

    test('the choices become a file, and the file can be downloaded', async ({ page }) => {
      await page.goto(GENERATOR);
      await page.getByLabel('AI training crawlers', { exact: false }).selectOption('block');
      await page.getByLabel('Paths to keep every crawler out of').fill('/admin/');
      await page.getByRole('button', { name: 'Make my robots.txt' }).click();

      const box = page.locator('#tool-output');
      await expect(box).toHaveValue(/User-agent: GPTBot/);
      await expect(box).toHaveValue(/Disallow: \/admin\//);
      await expect(page.locator('#result')).toContainText('blocks 7 AI crawlers');

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        // A synthetic click: with JavaScript off the page cannot scroll the button into view while the anchor settles.
        page.getByRole('button', { name: 'Download robots.txt' }).dispatchEvent('click'),
      ]);
      expect(download.suggestedFilename()).toBe('robots.txt');
      const { createReadStream } = await import('node:fs');
      const chunks = [];
      for await (const chunk of createReadStream(await download.path())) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toContain('User-agent: GPTBot');
    });

    test('a path of just / is explained beside the field', async ({ page }) => {
      await page.goto(GENERATOR);
      await page.getByLabel('Paths to keep every crawler out of').fill('/');
      await page.getByRole('button', { name: 'Make my robots.txt' }).click();
      await expect(page.getByText('would keep every crawler out of your whole site')).toBeVisible();
      await expect(page.getByLabel('Paths to keep every crawler out of')).toHaveValue('/');
    });
  });

  test('with JavaScript: the Copy button is there and the page raises no console error', async ({
    page,
  }) => {
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(GENERATOR);
    await page.getByRole('button', { name: 'Make my robots.txt' }).click();
    await expect(page.locator('#result')).toContainText('allows every crawler');
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test.describe('the schema markup generator', () => {
  const SCHEMA = '/tools/schema-markup-generator';

  test.describe('without JavaScript', () => {
    // With JavaScript off Playwright cannot scroll a button into view, and this form is taller than the window.
    test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 7000 } });

    test('what is typed becomes valid markup that can be downloaded', async ({ page }) => {
      await page.goto(SCHEMA);
      await page.locator('#tool-name').fill('Acme Ltd');
      await page.locator('#tool-url').fill('acme-test.com');
      await page.locator('#tool-city').fill('Leeds');
      await page.getByRole('button', { name: 'Make my markup' }).click();

      await expect(page.locator('#result')).toContainText('Your Organization markup is ready');
      const box = page.locator('#tool-output');
      await expect(box).toHaveValue(/"@type": "Organization"/);
      await expect(box).toHaveValue(/"addressLocality": "Leeds"/);
      await expect(box).not.toHaveValue(/logo/);

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download structured-data.html' }).dispatchEvent('click'),
      ]);
      expect(download.suggestedFilename()).toBe('structured-data.html');
    });

    test('a missing required field is explained beside it, and what was typed is kept', async ({
      page,
    }) => {
      await page.goto(SCHEMA);
      await page.locator('#tool-url').fill('acme-test.com');
      await page.getByRole('button', { name: 'Make my markup' }).click();
      await expect(page.getByText('Enter the name of the business.')).toBeVisible();
      await expect(page.locator('#tool-url')).toHaveValue('acme-test.com');
    });
  });

  test('with JavaScript: choosing FAQ page and pasting questions works, with no console error', async ({
    page,
  }) => {
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(SCHEMA);
    await page.getByLabel('Type of markup').selectOption('FAQPage');
    await page.locator('#tool-faq').fill('How long?\n45 minutes.\n\nWalk-ins?\nYes.');
    await page.getByRole('button', { name: 'Make my markup' }).click();
    await expect(page.locator('#result')).toContainText('Your FAQPage markup is ready');
    await expect(page.locator('#tool-output')).toHaveValue(/"@type": "Question"/);
    expect(problems).toEqual([]);
  });
});

test.describe('the llms.txt generator', () => {
  const LLMS = '/tools/llms-txt-generator';

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 3000 } });

    test('what is typed becomes the file, says no engine needs it, and downloads', async ({
      page,
    }) => {
      await page.goto(LLMS);
      await page.locator('#tool-name').fill('Acme Dental');
      await page.locator('#tool-links').fill('Pricing | acme-test.com/pricing | Plans and prices');
      await page.getByRole('button', { name: 'Make my llms.txt' }).click();

      await expect(page.locator('#result')).toContainText('Your llms.txt is ready, with 1 link');
      await expect(page.locator('#result')).toContainText(
        'No AI engine is known to need an llms.txt file',
      );
      await expect(page.locator('#tool-output')).toHaveValue(
        /# Acme Dental[\s\S]*- \[Pricing\]\(https:\/\/acme-test\.com\/pricing\): Plans and prices/,
      );
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Download llms.txt' }).dispatchEvent('click'),
      ]);
      expect(download.suggestedFilename()).toBe('llms.txt');
    });

    test('a bad line is explained beside the field, and what was typed is kept', async ({
      page,
    }) => {
      await page.goto(LLMS);
      await page.locator('#tool-name').fill('Acme');
      await page.locator('#tool-links').fill('Pricing');
      await page.getByRole('button', { name: 'Make my llms.txt' }).click();
      await expect(page.getByText('Line 1: write a title')).toBeVisible();
      await expect(page.locator('#tool-name')).toHaveValue('Acme');
    });
  });

  test('with JavaScript it works, with no console error', async ({ page }) => {
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(LLMS);
    await page.locator('#tool-name').fill('Acme');
    await page.getByRole('button', { name: 'Make my llms.txt' }).click();
    await expect(page.locator('#result')).toContainText('Your llms.txt is ready, with 0 links');
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
    expect(problems).toEqual([]);
  });
});

test('a run is counted by tool and outcome only, and the audit link carries utm_source=tools', async ({
  page,
  request,
}) => {
  const typed = `typed-${Math.random().toString(36).slice(2, 8)}`;
  const count = async () =>
    (await (await request.get('/__e2e/posthog/events')).json()).filter(
      (e) => e.event === 'tool_used',
    );
  const before = (await count()).length;
  await page.goto('/tools/llms-txt-generator');
  await expect(page.locator('main a[href*="utm_source=tools"]')).toHaveAttribute(
    'href',
    '/?utm_source=tools&utm_campaign=llms-txt-generator#audit',
  );
  await page.locator('#tool-name').fill(typed);
  await page.getByRole('button', { name: 'Make my llms.txt' }).click();
  await expect(page.locator('#result')).toContainText('Your llms.txt is ready');
  // Other tests in this file run at the same time and are counted too, so look for ours among the new events.
  await expect.poll(async () => (await count()).length).toBeGreaterThan(before);
  const events = await count();
  const ours = events.slice(before).filter((e) => e.properties.tool === 'llms-txt-generator');
  expect(ours.length).toBeGreaterThan(0);
  for (const e of events) {
    expect(
      Object.keys(e.properties)
        .filter((k) => !k.startsWith('$'))
        .sort(),
    ).toEqual(['outcome', 'tool']);
  }
  expect(JSON.stringify(events)).not.toContain(typed);
});

// The pages above are swept empty by a11y.spec.js and responsive.spec.js. The page after a run is the one a visitor
// reads most, so it gets the same two checks (WCAG 2.1 AA, no sideways scroll at phone width).
const ANSWERED = [
  {
    slug: 'robots-txt-checker',
    fill: (page) => page.getByLabel('Website to check').fill('blocks-ai.example.test'),
    button: 'Check my robots.txt',
  },
  {
    slug: 'structured-data-validator',
    fill: (page) =>
      page.getByLabel('Or paste your JSON-LD').fill(
        JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'Acme',
          url: 'acme-test.com',
        }),
      ),
    button: 'Check my structured data',
  },
  {
    slug: 'sitemap-checker',
    fill: (page) => page.getByLabel('Website or sitemap address').fill('maps.example.test'),
    button: 'Check my sitemap',
  },
  {
    slug: 'robots-txt-generator',
    fill: (page) => page.getByLabel('Paths to keep every crawler out of').fill('/admin/'),
    button: 'Make my robots.txt',
  },
  {
    slug: 'schema-markup-generator',
    fill: (page) => page.locator('#tool-name').fill('Acme Ltd'),
    button: 'Make my markup',
  },
  {
    slug: 'llms-txt-generator',
    fill: (page) => page.locator('#tool-name').fill('Acme'),
    button: 'Make my llms.txt',
  },
];

for (const tool of ANSWERED) {
  test(`the answered page of ${tool.slug}: no serious accessibility problem, no sideways scroll at 375px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/tools/${tool.slug}`);
    await tool.fill(page);
    await page.getByRole('button', { name: tool.button }).click();
    await expect(page.locator('#result')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
