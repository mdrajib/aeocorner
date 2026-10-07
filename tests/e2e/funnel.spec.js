import { expect, test } from '@playwright/test';

// The public funnel in a real browser (Milestone 9, task 9.09): the free audit's steps and the sign-up are counted on the
// server and sent to PostHog. Here PostHog is a stand-in on the e2e server (/__e2e/posthog), so what was sent can be read
// back. The point of the test: the events fire, the campaign tags arrive, and not one event carries personal data.
const unique = () => Math.random().toString(36).slice(2, 8);

const ALLOWED_PROPERTIES = new Set([
  'has_competitor',
  'from_audit',
  'consent',
  'cached',
  'status',
  'score_band',
  'tool',
  'outcome',
  'utm_source',
  'utm_medium',
  'utm_campaign',
]);

const eventsOf = async (request) => (await request.get('/__e2e/posthog/events')).json();

test('a visit with campaign tags, through the audit and into a sign-up, is counted without personal data', async ({
  page,
  request,
}) => {
  const tag = `pw${unique()}`;
  const domain = `e2e-${unique()}.example.test`;
  const email = `funnel.${unique()}@acme-corp.test`;

  // 1. Arrive with campaign tags; the form carries them.
  await page.goto(
    `/?utm_source=${tag}&utm_medium=e2e&utm_campaign=funnel-check&utm_content=${email}`,
  );
  await page.locator('#hero-url').fill(domain);
  await page.getByRole('button', { name: 'Run my free audit' }).first().click();

  // 2. The email step, then the code.
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Send my code' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Enter your 6-digit code' }),
  ).toBeVisible();
  const mail = (await (await request.get('/__e2e/mail')).json()).filter((m) => m.to === email);
  await page.getByLabel('Code').fill(mail.at(-1).text.match(/\b(\d{6})\b/)[1]);
  await page.getByRole('button', { name: 'Start my audit' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Checking ${domain}` })).toBeVisible();

  // 3. A person signs up: their first organization is the last step of the funnel.
  const before = (await eventsOf(request)).filter((e) => e.event === 'signup_completed').length;
  await page.goto('/__e2e/login?as=fresh&next=/app/new-org');
  await page
    .getByLabel(/Organization name|Name/)
    .first()
    .fill(`Funnel Co ${unique()}`);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/app\/o\/[0-9A-Z]{26}/);

  await expect
    .poll(
      async () => (await eventsOf(request)).filter((e) => e.event === 'signup_completed').length,
    )
    .toBe(before + 1);

  const events = await eventsOf(request);
  const names = events.map((e) => e.event);
  for (const step of [
    'audit_form_submitted',
    'audit_email_submitted',
    'audit_code_verified',
    'signup_completed',
  ]) {
    expect(names, step).toContain(step);
  }

  // The campaign tags reached the first event as plain labels; the tag that held an email address did not.
  const submitted = events.find(
    (e) => e.event === 'audit_form_submitted' && e.properties.utm_source === tag.toLowerCase(),
  );
  expect(submitted, 'the tagged visit was counted').toBeTruthy();
  expect(submitted.properties.utm_medium).toBe('e2e');
  expect(submitted.properties.utm_campaign).toBe('funnel-check');

  // Nothing identifying anywhere: no email, domain or address, only the allowed properties, no person profile.
  const everything = JSON.stringify(events);
  expect(everything).not.toContain(email);
  expect(everything).not.toContain(domain);
  expect(everything).not.toMatch(/@|\/audit\/|\/app\/o\/|\/r\//);
  for (const event of events) {
    expect(event.properties.$process_person_profile).toBe(false);
    for (const key of Object.keys(event.properties).filter((k) => !k.startsWith('$'))) {
      expect(ALLOWED_PROPERTIES.has(key), `property ${key} on ${event.event}`).toBe(true);
    }
  }
  expect(new Set(events.map((e) => e.distinct_id)).size, 'no event shares an id with another').toBe(
    events.length,
  );
});
