// The server Playwright drives (see playwright.config.js). It is the real app, wired like production, with two
// differences that exist only here: Clerk is replaced by a fake that reads a `test_session` cookie, and the
// database is the test database, seeded with a small organization. A /__e2e route signs a browser in as a
// seeded person. Nothing in this file ships: it lives under tests/ and nothing in src/ imports it.
import { randomBytes } from 'node:crypto';
import { INTENT_LABELS } from '../../src/core/prompt-rules.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createAuditLimiter } from '../../src/lib/audit-limits.js';
import { createAuditMail } from '../../src/lib/audit-mail.js';
import { loadConfig } from '../../src/lib/config.js';
import { createFunnel } from '../../src/lib/funnel.js';
import { createLogger } from '../../src/lib/logger.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createOtpStore } from '../../src/lib/otp.js';
import { hashToken, newToken } from '../../src/lib/tokens.js';
import { createApp } from '../../src/web/app.js';
import { auditFixtures } from '../helpers/audit-fixtures.js';
import { refreshProject } from '../../src/worker/handlers/actions.js';
import { generatedSet } from '../helpers/question-sets.js';
import { connectTestRedis } from '../helpers/redis.js';

const config = loadConfig(process.env);
const logger = createLogger(config);
const db = connectTestDb();
const fx = fixtures(db);
const mailer = memoryMailer();
const unique = () => randomBytes(3).toString('hex');
const DAY = 24 * 60 * 60 * 1000;

// --- the fake Clerk ---------------------------------------------------------------------------------
const sessions = new Map(); // cookie value -> { clerkUserId, sessionId, claims }
const clerkUsers = new Map(); // clerk user id -> user in our shape

const provider = {
  configured: true,
  signInUrl: 'https://accounts.example.test/sign-in',
  signUpUrl: 'https://accounts.example.test/sign-up',
  middleware: () => (req, res, next) => next(),
  async authenticate(req) {
    const cookie = (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .find(([name]) => name === 'test_session');
    return sessions.get(cookie?.[1]) ?? null;
  },
  async fetchUser(id) {
    return clerkUsers.get(id) ?? null;
  },
  async endSession(sessionId) {
    for (const [cookie, s] of sessions) if (s.sessionId === sessionId) sessions.delete(cookie);
  },
};

function startSession(user) {
  const clerkUser = {
    id: user.clerk_user_id,
    email: user.email,
    name: user.name,
    emails: [{ address: user.email, verified: true, primary: true }],
  };
  clerkUsers.set(clerkUser.id, clerkUser);
  const cookie = randomBytes(8).toString('hex');
  sessions.set(cookie, { clerkUserId: clerkUser.id, sessionId: `sess_${cookie}`, claims: {} });
  return cookie;
}

// --- seed data --------------------------------------------------------------------------------------
await fx.purgeLeftovers('e2e_');

const person = (name, extra = {}) =>
  fx.user({
    id: `e2e_${unique()}`,
    name,
    email: `${name.toLowerCase().replace(/\W+/g, '.')}.${unique()}@example.test`,
    ...extra,
  });

const people = {
  owner: await person('Maya Chen'),
  admin: await person('Priya Rao'),
  editor: await person('Sam Lee'),
  viewer: await person('Jo Park'),
  invitee: await person('Dana Invitee'),
  newcomer: await person('Nia Newcomer'),
};

const { org, scoped } = await fx.org({ owner: people.owner, name: 'Acme Dental' });
for (const role of ['admin', 'editor', 'viewer']) {
  await scoped.memberships.add({ userId: people[role].id, role });
}

async function invite(email, role, { ttl = 7 * DAY } = {}) {
  const token = newToken();
  await scoped.invitations.create({
    email,
    role,
    inviterUserId: people.owner.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttl),
  });
  return token;
}

// A project with two competitors, for the project screens.
const project = await scoped.projects.create({
  name: 'Sample Dental',
  domain: `sample-${unique()}.example.test`,
  country: 'US',
  language: 'en',
  createdByUserId: people.owner.id,
});
await scoped.entities.addCompetitor(project.id, {
  name: 'Rival Smiles',
  primaryDomain: 'rival.example.test',
});
await scoped.entities.addCompetitor(project.id, { name: 'BrightSmile' });
await scoped.entities.addCompetitor(project.id, {
  name: 'Suggested Dental Co',
  primaryDomain: 'suggested.example.test',
  source: 'brand_kit',
  status: 'suggested',
});
// A Brand Kit with two versions, and a full question set, for the Brand Kit, Prompt Manager and setup screens.
await scoped.brandKits.save(project.id, {
  kit: {
    identity: {
      brandName: 'Sample Dental',
      aliases: ['Sample'],
      category: 'family dental practice',
      definition: 'A family dental practice in Austin.',
      geography: 'Austin, Texas',
    },
    offerings: { items: [{ name: 'Check-ups', price: '$99' }, { name: 'Braces' }] },
  },
  source: 'extracted',
  expectedVersion: null,
  actorUserId: people.owner.id,
});
await scoped.brandKits.save(project.id, {
  kit: {
    identity: { brandName: 'Sample Dental', category: 'family dental practice' },
    offerings: {
      items: [{ name: 'Check-ups', price: '$99' }],
      audiences: ['families'],
      differentiators: ['Open on Saturdays'],
    },
    facts: [{ label: 'Founded', value: '2009' }],
    voice: { tone: ['friendly'], readingLevel: 'plain' },
  },
  source: 'edited',
  expectedVersion: 1,
  actorUserId: people.owner.id,
});
await scoped.prompts.importMany(
  project.id,
  generatedSet(30, { brand: 'Sample Dental' }).map((q) => ({
    ...q,
    clusterName: INTENT_LABELS[q.intent],
  })),
  { source: 'generated', limit: 50 },
);
const firstPrompt = (await scoped.prompts.list(project.id))[0];
const editorSeat = await scoped.memberships.getByUser(people.editor.id);

// Two projects with tracking on: one whose last check was incomplete, one whose check is still running.
async function trackedProject(name, run) {
  const tracked = await scoped.projects.create({
    name,
    domain: `${name.toLowerCase().replace(/\W+/g, '-')}-${unique()}.example.test`,
    country: 'US',
    language: 'en',
    createdByUserId: people.owner.id,
  });
  await scoped.prompts.add(tracked.id, {
    text: `What is the best ${name} option?`,
    intent: 'discovery',
  });
  await scoped.projects.startTracking(tracked.id, { actorUserId: people.owner.id });
  await fx.run(tracked, run);
  return tracked;
}
const incompleteProject = await trackedProject('Partial Dental', {
  status: 'partial',
  trigger: 'schedule',
  counts: { tasks_planned: 8, tasks_ok: 6, tasks_no_answer: 0, tasks_failed: 2 },
});
const runningProject = await trackedProject('Running Dental', {
  status: 'collecting',
  trigger: 'onboarding',
  counts: { tasks_planned: 8 },
});

// A project with several weeks of results and one finished check, for the dashboard screens: some answers named the
// brand, some a rival, one question could not be fully read, and one engine failed. The earlier weeks are rollup rows
// written directly, so the trend has points to draw.
const dashProject = await scoped.projects.create({
  name: 'Data Dental',
  domain: `data-dental-${unique()}.example.test`,
  country: 'US',
  language: 'en',
  createdByUserId: people.owner.id,
});
const dashQ1 = (
  await scoped.prompts.add(dashProject.id, {
    text: 'Who is the best family dentist in Austin?',
    intent: 'discovery',
  })
).prompt;
const dashQ2 = (
  await scoped.prompts.add(dashProject.id, {
    text: 'Which dentist is the cheapest in Austin?',
    intent: 'discovery',
  })
).prompt;
await scoped.projects.startTracking(dashProject.id, { actorUserId: people.owner.id });
const dashBrand = (await scoped.entities.list(dashProject.id, { kind: 'brand' }))[0];
const dashRival = await fx.entity(dashProject, {
  kind: 'competitor',
  name: 'Rival Smiles',
  domains: ['rival.example.test'],
});
{
  const hostId = unique();
  const dashRun = await fx.run(dashProject, { status: 'rolling_up', trigger: 'schedule' });
  await fx.readAnswer(dashRun, dashQ1, {
    excerpt: 'For a family dentist in Austin, Data Dental is a top pick, followed by Rival Smiles.',
    mentions: [
      {
        entity: dashBrand,
        listRank: 1,
        stance: 'recommended',
        sentiment: 2,
        excerpt: 'Data Dental is a top pick.',
      },
      { entity: dashRival, listRank: 2, stance: 'neutral', sentiment: 0 },
    ],
    citations: [
      { url: `https://reviews-${hostId}.example.test/austin-dentists` },
      { url: `https://data-dental-${hostId}.example.test/`, isOwn: true, owner: dashBrand },
    ],
  });
  await fx.readAnswer(dashRun, dashQ1, {
    sampleIdx: 1,
    excerpt: 'Rival Smiles is often recommended for families.',
    mentions: [{ entity: dashRival, listRank: 1, stance: 'recommended', sentiment: 1 }],
    citations: [{ url: `https://reviews-${hostId}.example.test/austin-dentists` }],
  });
  await fx.readAnswer(dashRun, dashQ2, {
    excerpt: 'Prices vary a lot between practices in Austin.',
    citations: [{ url: `https://forum-${hostId}.example.test/cheap-dentist` }],
  });
  const failed = await scoped.snapshots.create({
    runId: dashRun.id,
    promptId: dashQ2.id,
    engineCode: 'gemini',
    sampleIdx: 0,
    providerCode: 'dataforseo',
    method: 'ui_capture',
  });
  await scoped.snapshots.fail(failed.snapshot.id, 'provider down');
  await fx.collectedAnswer(dashRun, dashQ2, { engine: 'perplexity', sampleIdx: 1 });
  const outcome = await scoped.runs.settle(dashRun.id);
  await scoped.metrics.rollupDay(dashProject.id, dashRun.run_date);
  await scoped.runs.finish(dashRun.id, outcome.status);
  const weeksAgo = (n) => new Date(Date.now() - n * 7 * DAY).toISOString().slice(0, 10);
  await fx.seedMetrics(
    dashProject,
    [3, 2, 1].flatMap((n, i) =>
      ['perplexity', 'gemini'].flatMap((engine) => [
        {
          date: weeksAgo(n),
          engine,
          entityKind: 'brand',
          nAnswers: 12,
          kMentioned: 2 + i * 2 + (engine === 'gemini' ? 0 : 1),
          citationsTotal: 10,
          citationsEntity: 1 + i,
        },
        {
          date: weeksAgo(n),
          engine,
          entityKind: String(dashRival.id),
          nAnswers: 12,
          kMentioned: 5,
        },
      ]),
    ),
  );
}

// The Action Center: a scan that found two things, raised as recommendations. One fix is marked done and has a result.
const actionIds = {};
{
  const scoped = db.forOrg(org.id);
  await fx.scan(dashProject, {
    checks: [
      {
        code: 'A1',
        status: 'fail',
        points: 0,
        possible: 8,
        summary: 'robots.txt blocks OAI-SearchBot',
      },
      {
        code: 'C1',
        status: 'partial',
        points: 3,
        possible: 6,
        summary: 'Organization schema has no logo',
      },
      { code: 'F3', status: 'partial', points: 1, possible: 3, summary: 'Two pages share a title' },
    ],
  });
  await refreshProject({ db, scoped }, { projectId: dashProject.id, now: new Date() });
  const recs = await scoped.recommendations.list(dashProject.id);
  const byRule = (code) => recs.find((r) => r.ruleCode === code);
  actionIds.open = String(byRule('readiness.A1').id);
  const won = byRule('readiness.C1');
  await scoped.recommendations.markDone(dashProject.id, won.id, { userId: people.owner.id });
  await scoped.recommendations.settleVerification(dashProject.id, won.id, {
    verdict: 'verified',
    reason: 'passed',
  });
  await fx.forceOutcome(
    { ...won, org_id: org.id, project_id: dashProject.id },
    { verdict: 'proven_win' },
  );
  await fx.forceRecommendation(won.id, { status: 'proven_win' });
  actionIds.win = String(won.id);
}

const tokens = {
  signedOut: await invite(`new.hire.${unique()}@example.test`, 'editor'),
  accept: await invite(people.invitee.email, 'viewer'),
  expired: await invite(`late.${unique()}@example.test`, 'viewer', { ttl: -1000 }),
};

const fixtureInfo = {
  get audits() {
    return auditSeeds;
  },
  orgId: org.public_id,
  projectId: project.public_id,
  incompleteProjectId: incompleteProject.public_id,
  runningProjectId: runningProject.public_id,
  dashboardProjectId: dashProject.public_id,
  dashboardPromptId: String(dashQ1.id),
  actionOpenId: actionIds.open,
  actionWinId: actionIds.win,
  promptId: String(firstPrompt.id),
  membershipId: String(editorSeat.id),
  tokens,
  unknownToken: 'x'.repeat(43),
  roles: Object.keys(people),
};

// --- the free audit -----------------------------------------------------------------------------------
// The real form, code store and limits (Redis, under a private key prefix) with a Turnstile that always passes and a
// job queue that only remembers: no worker runs here, so audits in these tests are moved along by /__e2e/audit/*.
const testRedis = connectTestRedis({ role: 'producer' });
const auditFx = auditFixtures({ db, fx });
const auditSeeds = {
  awaiting: (await auditFx.seedAudit('awaiting_verification')).public_id,
  queued: (await auditFx.seedAudit('queued')).public_id,
  running: (await auditFx.liveAudit()).public_id,
  complete: (await auditFx.finishedAudit()).public_id,
  partial: (await auditFx.finishedAudit({ status: 'partial', failEngine: 'gemini' })).public_id,
  failed: await (async () => {
    const audit = await auditFx.seedAudit('running');
    await db.audits.fail(audit.id, 'site_unreadable');
    return audit.public_id;
  })(),
};
const queuedJobs = [];
const audit = {
  otp: createOtpStore(testRedis.redis, {
    prefix: testRedis.prefix,
    secret: 'e2e-otp-secret-e2e-otp-secret',
  }),
  limiter: createAuditLimiter({ redis: testRedis.redis, prefix: testRedis.prefix, db }),
  turnstile: { verify: async () => ({ ok: true }) },
  mail: createAuditMail({ mailer, baseUrl: config.baseUrl }),
  jobs: { add: async (name, data) => void queuedJobs.push({ name, data }) },
  funnel: createFunnel({ posthog: null }),
};

// --- the app ----------------------------------------------------------------------------------------
const app = createApp({
  config,
  logger,
  db,
  provider,
  mailer,
  audit,
  extraRoutes(application) {
    application.get('/__e2e/fixtures', (req, res) => res.json(fixtureInfo));

    // Sign this browser in as a seeded person (or a brand-new one with `as=fresh`), then go to `next`.
    application.get('/__e2e/login', async (req, res, next) => {
      try {
        const as = String(req.query.as ?? 'owner');
        const email = typeof req.query.email === 'string' ? { email: req.query.email } : {};
        const user = as === 'fresh' ? await person('Fresh Person', email) : people[as];
        if (!user) return res.status(400).send('unknown person');
        res.cookie('test_session', startSession(user), {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        });
        res.redirect(302, String(req.query.next ?? '/app'));
      } catch (err) {
        next(err);
      }
    });

    // An audit that is running, and a way to finish it: the page's live update needs something to wait for.
    application.get('/__e2e/audit/live', async (req, res, next) => {
      try {
        res.json({ publicId: (await auditFx.liveAudit()).public_id });
      } catch (err) {
        next(err);
      }
    });
    application.get('/__e2e/audit/finish', async (req, res, next) => {
      try {
        const found = await db.audits.getByPublicId(String(req.query.id));
        if (!found) return res.status(404).send('no such audit');
        await auditFx.completeLive(found);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
    application.get('/__e2e/audit/jobs', (req, res) => res.json(queuedJobs));

    // The emails the app "sent", newest last, so a test can click the link inside.
    application.get('/__e2e/mail', (req, res) =>
      res.json(
        mailer.sent.map((m) => ({ to: m.to, subject: m.email.subject, text: m.email.text })),
      ),
    );
  },
});

const server = app.listen(config.port, '127.0.0.1', () => {
  logger.warn({ port: config.port }, 'e2e server ready (fake Clerk, test database)');
});

async function shutdown() {
  server.close();
  await fx.cleanup().catch(() => {});
  await testRedis.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
