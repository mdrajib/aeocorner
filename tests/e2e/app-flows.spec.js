import { expect, test } from '@playwright/test';

// End-to-end flows in a real browser against the e2e server (tests/e2e/server.js): fake Clerk, real app,
// real test database. Each test makes its own people and organizations, so the tests can run in parallel.
const unique = () => Math.random().toString(36).slice(2, 8);

async function signInAsNewPerson(page, { email, next = '/app' } = {}) {
  const query = new globalThis.URLSearchParams({ as: 'fresh', next });
  if (email) query.set('email', email);
  await page.goto(`/__e2e/login?${query}`);
}

async function createOrganization(page, name) {
  await expect(page).toHaveURL(/\/app\/new-org$/);
  await page.getByLabel('Organization name').fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('sign in → create an organization → land in the empty shell as its owner', async ({
  page,
}) => {
  await signInAsNewPerson(page);
  await createOrganization(page, `Flow Co ${unique()}`);
  await expect(page.getByText('Your organization is ready.')).toBeVisible();
  await expect(page.getByText('No projects yet')).toBeVisible();
  await expect(page.getByText('You’re signed in as')).toContainText('Owner');
  await expect(page.getByRole('link', { name: 'Team', exact: true })).toBeVisible();
});

test('the create form explains a bad name instead of failing silently', async ({ page }) => {
  await signInAsNewPerson(page);
  await page.getByLabel('Organization name').fill('a');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText('Use between 2 and 128 characters.')).toBeVisible();
  await expect(page.getByLabel('Organization name')).toHaveAttribute('aria-invalid', 'true');
});

test('invite a teammate, who signs in with that address and joins; then change their role and remove them', async ({
  page,
  browser,
  request,
}) => {
  const org = `Team Co ${unique()}`;
  const joinerEmail = `joiner.${unique()}@example.test`;

  // The owner invites.
  await signInAsNewPerson(page);
  await createOrganization(page, org);
  await page.getByRole('link', { name: 'Team', exact: true }).click();
  await page.getByLabel('Email address').fill(joinerEmail);
  await page.locator('#invite-role').selectOption('editor');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation sent.')).toBeVisible();
  await expect(page.getByRole('cell', { name: joinerEmail })).toBeVisible();

  // The email carries the link.
  const mail = await (await request.get('/__e2e/mail')).json();
  const sent = mail.filter((m) => m.to === joinerEmail).at(-1);
  expect(sent.subject).toContain(org);
  const link = sent.text.match(/https?:\/\/\S+\/invite\/[\w-]+/)[0];
  const invitePath = new URL(link).pathname;

  // The teammate opens it in their own browser, signed in with that address, and accepts.
  const context = await browser.newContext({ baseURL: page.url().split('/app')[0] });
  const joiner = await context.newPage();
  await signInAsNewPerson(joiner, { email: joinerEmail, next: invitePath });
  await expect(joiner.getByRole('heading', { name: `Join ${org}` })).toBeVisible();
  await joiner.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(joiner.getByText('You’ve joined the organization.')).toBeVisible();
  await expect(joiner.getByText('You’re signed in as')).toContainText('Editor');
  await expect(joiner.getByRole('link', { name: 'Team', exact: true })).toHaveCount(0);
  await context.close();

  // Back with the owner: the new member is listed; change the role, then remove.
  await page.reload();
  await page.getByRole('link', { name: 'Team', exact: true }).click();
  const row = page.getByRole('row', { name: new RegExp(joinerEmail) });
  await expect(row).toBeVisible();
  await row.getByLabel(/^Role for/).selectOption('admin');
  await row.getByRole('button', { name: /^Save role/ }).click();
  await expect(page.getByText('Role updated.')).toBeVisible();
  await expect(
    page.getByRole('row', { name: new RegExp(joinerEmail) }).getByLabel(/^Role for/),
  ).toHaveValue('admin');

  await page
    .getByRole('row', { name: new RegExp(joinerEmail) })
    .getByRole('button', { name: /^Remove/ })
    .click();
  await expect(page.getByText('Member removed.')).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(joinerEmail) })).toHaveCount(0);
});

test('a wrong address on the invitation is explained, and cannot accept', async ({
  page,
  request,
}) => {
  const org = `Guard Co ${unique()}`;
  await signInAsNewPerson(page);
  await createOrganization(page, org);
  await page.getByRole('link', { name: 'Team', exact: true }).click();
  await page.getByLabel('Email address').fill(`someone.else.${unique()}@example.test`);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText('Invitation sent.')).toBeVisible();

  const mail = await (await request.get('/__e2e/mail')).json();
  const link = mail.at(-1).text.match(/https?:\/\/\S+\/invite\/[\w-]+/)[0];

  // The owner (a different person) opens the link.
  await page.goto(new URL(link).pathname);
  await expect(page.getByText('This isn’t the right account')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
});

test('sign out ends the session: the signed-in area asks for sign-in again', async ({ page }) => {
  await page.route('https://accounts.example.test/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>Clerk sign-in stand-in</h1>',
    }),
  );
  await signInAsNewPerson(page);
  await createOrganization(page, `Exit Co ${unique()}`);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Is AI sending your customers',
  );

  // Without a session the signed-in area now sends the browser to sign in (checked without following the
  // redirect, since the stand-in sign-in host does not exist).
  const res = await page.request.get('/app', { maxRedirects: 0, headers: { Accept: 'text/html' } });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toBe('/sign-in?next=%2Fapp');
});

test('the app pages obey the strict CSP: no console errors while using them', async ({ page }) => {
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));

  await signInAsNewPerson(page);
  await createOrganization(page, `Csp Co ${unique()}`);
  // The created-notice banner is dismissed by Alpine (CSP build); a violation would show up as a console error.
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Your organization is ready.')).toBeHidden();
  await page.getByRole('link', { name: 'Team', exact: true }).click();
  await page.locator('summary', { hasText: 'Csp Co' }).click();
  await expect(page.getByRole('link', { name: '+ Create another organization' })).toBeVisible();
  expect(problems).toEqual([]);
});
