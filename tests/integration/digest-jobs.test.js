import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import pino from 'pino';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createNotifier } from '../../src/lib/notify.js';
import { alertsEvaluate, digestSend, digestTick } from '../../src/worker/handlers/digest.js';

/**
 * The weekly digest and the alert emails (Milestone 8, tasks 8.13–8.15) against the real database and an in-memory
 * mailer: who is emailed, once, at the right hour, with an unsubscribe, and never about the same thing twice.
 */

const db = connectTestDb();
const fx = fixtures(db);
const mailer = memoryMailer();
const MONDAY = new Date('2026-10-26T08:10:00Z'); // a Monday, 08:10 UTC
let clock = MONDAY;
const jobs = {
  added: [],
  async add(name, data, opts) {
    this.added.push({ name, data, opts });
  },
};
const ctx = {
  db,
  jobs,
  logger: pino({ level: 'silent' }),
  now: () => clock,
  billing: { enforced: false },
  mail: createNotifier({
    db,
    mailer,
    baseUrl: 'https://aeocorner.test',
    secret: 'test-secret-test-secret-test-secret-123',
    now: () => clock,
  }),
};
after(async () => {
  await fx.cleanup();
  await db.close();
});

/** An organization on a plan, with an active project, a brand, a rival, one question and `weeks` of rolled-up history. */
async function tracked({ plan = 'growth', before = 4, after = 4, rivalAfter = 2 } = {}) {
  const o = await fx.org();
  await fx.setOrg(o.org.id, { plan_code: plan, billing_status: 'active' });
  const project = await fx.project(o.org.id, 'Digest Dental', { status: 'active', slotHour: 3 });
  await fx.engines(project, ['perplexity']);
  const brand = await fx.entity(project, { kind: 'brand', name: 'Digest Dental' });
  const rival = await fx.entity(project, { kind: 'competitor', name: 'Rival Dental' });
  const q = await fx.prompt(project, { text: `Best dentist ${Math.random()}?` });
  const days = [
    ['2026-09-07', before],
    ['2026-09-14', before],
    ['2026-09-21', before],
    ['2026-09-28', before],
    ['2026-10-05', after],
    ['2026-10-12', after],
    ['2026-10-19', after],
    ['2026-10-26', after],
  ];
  for (const [date, brandK] of days) {
    const run = await fx.run(project, {
      runDate: new Date(`${date}T03:00:00Z`),
      status: 'complete',
    });
    await fx.cell(run, q, { nOk: 30, brandK, brand, rivals: [{ entity: rival, k: rivalAfter }] });
    await o.scoped.metrics.rollupDay(project.id, run.run_date);
  }
  return { ...o, project, brand, rival, q };
}

const toOwner = (o) => mailer.sent.filter((m) => m.to === o.owner.email);

describe('alerts.evaluate', () => {
  test('a significant drop is emailed once, with the numbers, and the event is marked told', async () => {
    const t = await tracked();
    const event = await fx.changeEvent(t.project, { createdAt: MONDAY, entity: t.brand });
    mailer.sent.length = 0;
    const run = { orgId: String(t.org.id), projectId: String(t.project.id), runId: '1' };

    const result = await alertsEvaluate(ctx, run);
    assert.equal(result.alerts, 1);
    assert.equal(result.sent, 1);
    const [mail] = toOwner(t);
    assert.match(mail.email.subject, /fell 40 points: Digest Dental/);
    assert.match(mail.email.text, /72 of 120/);
    assert.match(mail.email.text, /significance test/);
    assert.match(mail.headers['List-Unsubscribe'], /\/unsubscribe\//);
    assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

    assert.ok((await fx.billingRows(t.org.id)) && true);
    // The same job again (a retry): nothing more is sent and the event stays told.
    await alertsEvaluate(ctx, run);
    assert.equal(toOwner(t).length, 1);
    const again = await t.scoped.alerts.pending(t.project.id, { now: clock });
    assert.equal(again.events.length, 0, 'the event is marked alerted');
    assert.ok(event);
  });

  test('a change that did not pass the test, a rise and an old event raise nothing', async () => {
    const t = await tracked();
    await fx.changeEvent(t.project, {
      createdAt: MONDAY,
      entity: t.brand,
      significant: false,
      key: 'a',
    });
    await fx.changeEvent(t.project, {
      createdAt: MONDAY,
      entity: t.brand,
      direction: 'up',
      key: 'b',
    });
    await fx.changeEvent(t.project, {
      entity: t.brand,
      key: 'c',
      createdAt: new Date(clock.getTime() - 30 * 86_400_000),
    });
    mailer.sent.length = 0;
    const result = await alertsEvaluate(ctx, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
    });
    assert.equal(result.alerts, 0);
    assert.equal(toOwner(t).length, 0);
  });

  test('a plan without alerts gets none, and its events are left for an upgrade within the window', async () => {
    const t = await tracked({ plan: 'starter' });
    await fx.changeEvent(t.project, { createdAt: MONDAY, entity: t.brand });
    mailer.sent.length = 0;
    const result = await alertsEvaluate(ctx, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
      runId: '1',
    });
    assert.match(result.skipped, /no alerts/);
    assert.equal(toOwner(t).length, 0);
    assert.equal((await t.scoped.alerts.pending(t.project.id, { now: clock })).events.length, 1);
  });

  test('someone who switched alerts off is not emailed, but the event is still marked told', async () => {
    const t = await tracked();
    await t.scoped.notifyPrefs.set(t.owner.id, { digest: true, alerts: false });
    await fx.changeEvent(t.project, { createdAt: MONDAY, entity: t.brand });
    mailer.sent.length = 0;
    const result = await alertsEvaluate(ctx, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
      runId: '1',
    });
    assert.equal(result.recipients, 0);
    assert.equal(toOwner(t).length, 0);
    assert.equal((await t.scoped.alerts.pending(t.project.id, { now: clock })).events.length, 0);
  });

  test('a negative claim is told once ever, in the answer’s own words; a new one is told again', async () => {
    const t = await tracked();
    await fx.claim(t.project, {
      entity: t.brand,
      value: 'Charges hidden fees on every crown',
      runDate: clock,
    });
    mailer.sent.length = 0;
    const run = (runId) => ({ orgId: String(t.org.id), projectId: String(t.project.id), runId });
    await alertsEvaluate(ctx, run('10'));
    assert.equal(toOwner(t).length, 1);
    assert.match(toOwner(t)[0].email.text, /Charges hidden fees on every crown/);
    assert.match(toOwner(t)[0].email.text, /not checked whether it is true/);

    // The next run finds the same claim again: no second email.
    clock = new Date(clock.getTime() + 3 * 86_400_000);
    await alertsEvaluate(ctx, run('11'));
    assert.equal(toOwner(t).length, 1);

    // A different claim is new.
    await fx.claim(t.project, {
      entity: t.brand,
      attribute: 'service',
      value: 'Never answers the phone',
      runDate: clock,
    });
    clock = new Date(clock.getTime() + 4 * 86_400_000);
    await alertsEvaluate(ctx, run('12'));
    assert.equal(toOwner(t).length, 2);
    assert.match(toOwner(t)[1].email.text, /Never answers the phone/);
    assert.doesNotMatch(toOwner(t)[1].email.text, /hidden fees/);
    clock = MONDAY;
  });

  test('a claim about a competitor, or a positive one, is not an alert', async () => {
    const t = await tracked();
    await fx.claim(t.project, { entity: t.rival, value: 'Overcharges', runDate: clock });
    await fx.claim(t.project, {
      entity: t.brand,
      value: 'Lovely staff',
      polarity: 'positive',
      runDate: clock,
    });
    const result = await alertsEvaluate(ctx, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
      runId: '1',
    });
    assert.equal(result.alerts, 0);
  });

  test('only one proactive email a day: a second alert the same day is held back, and says why', async () => {
    const t = await tracked();
    await fx.changeEvent(t.project, { createdAt: MONDAY, entity: t.brand, key: 'first' });
    mailer.sent.length = 0;
    await alertsEvaluate(ctx, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
      runId: '1',
    });
    await fx.changeEvent(t.project, {
      createdAt: MONDAY,
      entity: t.brand,
      kind: 'sov_change',
      key: 'second',
    });
    const second = await alertsEvaluate(ctx, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
      runId: '2',
    });
    assert.equal(second.sent, 0);
    assert.equal(toOwner(t).length, 1);
    const [row] = await db.notifications.messages.recentForUser(t.owner.id);
    assert.equal(row.status, 'suppressed');
    assert.equal(row.error, 'daily_cap');
  });
});

describe('digest.send', () => {
  const data = (t, at = MONDAY) => ({
    orgId: String(t.org.id),
    projectId: String(t.project.id),
    at: at.toISOString(),
  });

  test('on Monday morning the owner gets one digest with the figures, the drop and an unsubscribe', async () => {
    const t = await tracked({ before: 18, after: 6 });
    await fx.changeEvent(t.project, {
      entity: t.brand,
      createdAt: new Date('2026-10-25T10:00:00Z'),
    });
    mailer.sent.length = 0;
    const result = await digestSend(ctx, data(t));
    assert.equal(result.sent, 1);
    const [mail] = toOwner(t);
    assert.match(mail.email.subject, /^Digest Dental: .*fell/);
    assert.match(mail.email.text, /How often AI names you: 20%/);
    assert.match(mail.email.text, /Something dropped this week/);
    assert.match(mail.email.html, /Unsubscribe/);
    assert.match(mail.headers['List-Unsubscribe'], /unsubscribe\/\d+\.digest\./);
    assert.match(mail.email.text, /\/projects\/[0-9A-Z]{26}\/dashboard/);
  });

  test('the same week is sent once, however often the job runs', async () => {
    const t = await tracked();
    mailer.sent.length = 0;
    await digestSend(ctx, data(t));
    await digestSend(ctx, data(t));
    await digestSend(ctx, data(t, new Date('2026-10-26T08:40:00Z')));
    assert.equal(toOwner(t).length, 1);
    // The next Monday is a new digest.
    clock = new Date('2026-11-02T08:10:00Z');
    await digestSend(ctx, data(t, clock));
    assert.equal(toOwner(t).length, 2);
    clock = MONDAY;
  });

  test('a steady week says so, and a quiet week still has its figures', async () => {
    const t = await tracked({ before: 12, after: 12 });
    mailer.sent.length = 0;
    await digestSend(ctx, data(t));
    const [mail] = toOwner(t);
    assert.match(mail.email.text, /steady week/);
    assert.match(mail.email.text, /40%/);
  });

  test('it goes only to members whose local time is Monday 08:00', async () => {
    const t = await tracked();
    const other = await fx.member(t.org, 'editor');
    await fx.setUser(other.user.id, { timezone: 'America/New_York' }); // 04:10 there
    mailer.sent.length = 0;
    await digestSend(ctx, data(t));
    assert.equal(toOwner(t).length, 1);
    assert.equal(mailer.sent.filter((m) => m.to === other.user.email).length, 0);
    const later = new Date('2026-10-26T12:10:00Z'); // 08:10 in New York
    await digestSend(ctx, data(t, later));
    assert.equal(mailer.sent.filter((m) => m.to === other.user.email).length, 1);
  });

  test('a member who switched the digest off, and a client seat on another project, get nothing', async () => {
    const t = await tracked();
    await t.scoped.notifyPrefs.set(t.owner.id, { digest: false, alerts: true });
    const seat = await fx.member(t.org, 'viewer');
    const elsewhere = await fx.project(t.org.id, 'Another client');
    await t.scoped.memberships.setProjectAccess({
      membershipId: seat.membership.id,
      access: 'selected',
      projectIds: [elsewhere.id],
    });
    mailer.sent.length = 0;
    const result = await digestSend(ctx, data(t));
    assert.equal(result.sent, 0);
    assert.equal(mailer.sent.length, 0);
  });

  test('a week with no readable answers says so; it never shows a figure as zero', async () => {
    const o = await fx.org();
    await fx.setOrg(o.org.id, { plan_code: 'growth', billing_status: 'active' });
    const project = await fx.project(o.org.id, 'Silent', { status: 'active' });
    await fx.engines(project, ['perplexity']);
    await fx.entity(project, { kind: 'brand', name: 'Silent Co' });
    mailer.sent.length = 0;
    await digestSend(ctx, {
      orgId: String(o.org.id),
      projectId: String(project.id),
      at: MONDAY.toISOString(),
    });
    const [mail] = toOwner(o);
    assert.match(mail.email.text, /could not read any answers/);
    assert.doesNotMatch(mail.email.text, /: 0%/);
  });

  test('an address that bounced is never emailed', async () => {
    const t = await tracked();
    await db.notifications.suppressions.add({ email: t.owner.email, reason: 'bounce' });
    mailer.sent.length = 0;
    const result = await digestSend(ctx, data(t));
    assert.equal(result.sent, 0);
    assert.equal(toOwner(t).length, 0);
  });
});

describe('digest.tick', () => {
  test('queues one send per project that has someone at Monday 08:00, once per hour', async () => {
    const t = await tracked();
    jobs.added.length = 0;
    const result = await digestTick(ctx, { at: MONDAY.toISOString() });
    assert.ok(result.projects >= 1);
    const mine = jobs.added.filter((j) => j.data.projectId === String(t.project.id));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, 'digest.send');
    assert.equal(mine[0].data.at, MONDAY.toISOString());
    const again = await digestTick(ctx, { at: new Date('2026-10-26T08:50:00Z').toISOString() });
    const ids = new Set(
      jobs.added.filter((j) => j.data.projectId === String(t.project.id)).map((j) => j.opts.jobId),
    );
    assert.equal(ids.size, 1, 'a second tick in the same hour has the same job ID');
    assert.ok(again.projects >= 1);
  });

  test('at any other hour nothing is queued for UTC members', async () => {
    const t = await tracked();
    jobs.added.length = 0;
    await digestTick(ctx, { at: new Date('2026-10-26T13:00:00Z').toISOString() });
    assert.equal(jobs.added.filter((j) => j.data.projectId === String(t.project.id)).length, 0);
    await digestTick(ctx, { at: new Date('2026-10-27T08:00:00Z').toISOString() }); // a Tuesday
    assert.equal(jobs.added.filter((j) => j.data.projectId === String(t.project.id)).length, 0);
  });

  test('with billing enforced an organization that may not collect gets no digest', async () => {
    const paid = await tracked();
    const none = await tracked();
    await fx.setOrg(none.org.id, { plan_code: null, billing_status: 'none' });
    jobs.added.length = 0;
    await digestTick({ ...ctx, billing: { enforced: true } }, { at: MONDAY.toISOString() });
    const projects = jobs.added.map((j) => j.data.projectId);
    assert.ok(projects.includes(String(paid.project.id)));
    assert.ok(!projects.includes(String(none.project.id)));
  });
});

describe('feature flags', () => {
  const off = async (t, key) => {
    const boss = await fx.staff({ roles: ['super_admin'] });
    await db.system.flags.ensureKnown();
    await db.system.flags.setOverride({
      key,
      orgPublicId: t.org.public_id,
      enabled: false,
      staffId: boss.id,
    });
  };

  test('the digest, for one customer, can be switched off without a deploy', async () => {
    const t = await tracked();
    await off(t, 'digest.weekly');
    mailer.sent.length = 0;
    const result = await digestSend(ctx, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
      at: MONDAY.toISOString(),
    });
    assert.equal(result.skipped, 'switched off');
    assert.equal(toOwner(t).length, 0);
    const other = await tracked();
    mailer.sent.length = 0;
    const sent = await digestSend(ctx, {
      orgId: String(other.org.id),
      projectId: String(other.project.id),
      at: MONDAY.toISOString(),
    });
    assert.equal(sent.sent, 1, 'everyone else still gets theirs');
  });

  test('alerts, for one customer, can be switched off', async () => {
    const t = await tracked();
    await off(t, 'alerts.emails');
    await fx.changeEvent(t.project, { createdAt: MONDAY, entity: t.brand });
    mailer.sent.length = 0;
    const result = await alertsEvaluate(ctx, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
      runId: '1',
    });
    assert.equal(result.skipped, 'switched off');
    assert.equal(toOwner(t).length, 0);
    assert.equal(
      (await t.scoped.alerts.pending(t.project.id, { now: clock })).events.length,
      1,
      'left for when it is switched back on',
    );
  });
});
