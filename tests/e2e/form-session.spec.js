import { expect, test } from '@playwright/test';

// A form sent from a signed-in page must carry a session cookie that Clerk has just renewed, on every press and
// however slowly Clerk answers (components.js). Clerk is a stand-in here: its token call takes 3 seconds (longer than
// the old two-second wait) and writes the cookie only when it finishes. The page is served by the test, not the app.
const PAGE = '/__form-session';
const POSTED = '/__form-session/posted';

const html = `<!doctype html><meta charset="utf-8"><title>form</title>
<script data-clerk-publishable-key="pk_test_x">
  window.calls = [];
  window.Clerk = {
    load: () => Promise.resolve(),
    session: {
      getToken: (opts) =>
        new Promise((resolve) => {
          window.calls.push(Boolean(opts && opts.skipCache));
          setTimeout(() => { document.cookie = '__session=fresh' + window.calls.length + '; path=/'; resolve('t'); }, 3000);
        }),
    },
  };
</script>
<form method="post" action="${POSTED}"><button type="submit">Send</button></form>
<script src="/js/components.js"></script>`;

test('a form waits for a freshly fetched token, even a slow one, on every press, and is sent once', async ({
  page,
}) => {
  const posts = [];
  await page.route(`**${PAGE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.route(`**${POSTED}`, async (route) => {
    posts.push(route.request().headers().cookie ?? '');
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>done</h1>' });
  });

  await page.goto(PAGE);
  const send = page.getByRole('button', { name: 'Send' });
  await send.click();
  await send.click({ force: true }); // an impatient second press while Clerk is still working
  await expect(page.getByRole('heading', { name: 'done' })).toBeVisible({ timeout: 10_000 });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain('__session=fresh1');

  // The same page, a second press later: it asks Clerk again (it used to skip the wait the second time).
  await page.goto(PAGE);
  await page.evaluate(() => {
    window.calls.push(false); // a call count that starts above zero, so the cookie name proves this press waited
  });
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'done' })).toBeVisible({ timeout: 10_000 });
  expect(posts).toHaveLength(2);
  expect(posts[1]).toContain('__session=fresh2');
});

test('a form is still sent when Clerk never answers, after the limit', async ({ page }) => {
  const noClerk = html.replace('}, 3000);', '}, 3000000);'); // Clerk's token call outlasts the test
  const posts = [];
  await page.route(`**${PAGE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: noClerk }),
  );
  await page.route(`**${POSTED}`, async (route) => {
    posts.push(1);
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>done</h1>' });
  });
  await page.goto(PAGE);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('heading', { name: 'done' })).toBeVisible({ timeout: 15_000 });
  expect(posts).toHaveLength(1);
});
