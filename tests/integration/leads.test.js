import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/** Capturing leads (Milestone 1, task 1.16): the consent box is stored exactly as ticked. */
const db = connectTestDb();
const fx = fixtures(db);

after(async () => {
  await fx.cleanup();
  await db.close();
});

const address = () => `Lead-${Math.random().toString(36).slice(2)}@Example.TEST`;

describe('lead capture', () => {
  test('a lead is found again by its ID, and an unknown ID finds nothing', async () => {
    const lead = await fx.lead({ email: address() });
    assert.equal((await db.leads.get(lead.id)).email, lead.email);
    assert.equal(await db.leads.get(999_999_999n), null);
  });

  test('an unticked consent box is stored as no consent', async () => {
    const lead = await fx.lead({ email: address(), consent: false, consentVersion: 'v1' });
    assert.equal(lead.consent_marketing, false);
    assert.equal(lead.consent_version, null, 'no version is recorded for consent never given');
    assert.equal(lead.consent_at, null);
  });

  test('anything other than a real true is no consent', async () => {
    for (const consent of ['true', 1, 'on', undefined, null]) {
      const lead = await fx.lead({ email: address(), consent, consentVersion: 'v1' });
      assert.equal(lead.consent_marketing, false, String(consent));
    }
  });

  test('a ticked box records that it was ticked, which wording, and when', async () => {
    const now = new Date('2026-10-03T10:00:00Z');
    const lead = await fx.lead({ email: address(), consent: true, consentVersion: 'v1', now });
    assert.equal(lead.consent_marketing, true);
    assert.equal(lead.consent_version, 'v1');
    assert.equal(lead.consent_at.toISOString(), now.toISOString());
    assert.equal(lead.delete_after.toISOString(), '2027-10-03T10:00:00.000Z', 'kept 12 months');
  });

  test('the address is stored once, in lower case, with its domain', async () => {
    const email = address();
    const a = await fx.lead({ email });
    const b = await fx.lead({ email: email.toUpperCase() });
    assert.equal(a.id, b.id);
    assert.equal(a.email, email.toLowerCase());
    assert.equal(a.email_domain, 'example.test');
  });

  test('a later unticked audit does not withdraw consent given earlier', async () => {
    const email = address();
    await fx.lead({ email, consent: true, consentVersion: 'v1' });
    const again = await fx.lead({ email, consent: false });
    assert.equal(again.consent_marketing, true);
    assert.equal(again.consent_version, 'v1');
  });

  test('another audit restarts the 12 months, unless the lead already became a customer', async () => {
    const email = address();
    await fx.lead({ email, now: new Date('2026-01-01T00:00:00Z') });
    const later = await fx.lead({ email, now: new Date('2026-06-01T00:00:00Z') });
    assert.equal(later.delete_after.toISOString(), '2027-06-01T00:00:00.000Z');
  });

  test('verifying marks the time once', async () => {
    const lead = await fx.lead({ email: address() });
    await db.leads.markVerified(lead.id, new Date('2026-10-03T10:00:00Z'));
    const row = await db.leads.markVerified(lead.id, new Date('2026-10-04T10:00:00Z'));
    assert.equal(row.verified_at.toISOString(), '2026-10-03T10:00:00.000Z');
  });
});
