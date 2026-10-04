// The server Playwright drives (see playwright.config.js). It is the real app, wired like production, with two
// differences that exist only here: Clerk is replaced by a fake that reads a `test_session` cookie, and the
// database is the test database, seeded with a small organization. A /__e2e route signs a browser in as a
// seeded person. Nothing in this file ships: it lives under tests/ and nothing in src/ imports it.
import { randomBytes } from 'node:crypto';
import express from 'express';
import { unsubscribeToken } from '../../src/core/notify.js';
import { INTENT_LABELS } from '../../src/core/prompt-rules.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createAuditLimiter } from '../../src/lib/audit-limits.js';
import { createSafeFetcher } from '../../src/crawler/safe-fetch.js';
import { createAuditMail } from '../../src/lib/audit-mail.js';
import { loadConfig } from '../../src/lib/config.js';
import { createFunnel } from '../../src/lib/funnel.js';
import { createLogger } from '../../src/lib/logger.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createOtpStore } from '../../src/lib/otp.js';
import { createSecretBox } from '../../src/lib/secrets.js';
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

// The Content Studio: a page at each step on the dashboard project, and a WordPress connection on the sample project.
const contentIds = {};
{
  const html =
    '<p>A crown is a cap that covers a damaged tooth. A porcelain crown usually costs between $900 and $1,500 at Data Dental.</p>' +
    '<h2>How much does a crown cost?</h2><p>A porcelain crown costs between $900 and $1,500. The price depends on the tooth and the material.</p>' +
    '<h2>How long does a crown take?</h2><p>Same-day crowns take about two hours. A lab-made crown takes two visits.</p>' +
    '<h2>Does insurance cover a crown?</h2><p>Often in part. Ask your plan what it pays.</p>';
  const brief = {
    format: 'faq',
    title: 'How much does a crown cost in Austin?',
    metaDescription:
      'What a porcelain crown costs in Austin, what changes the price and how to pay for it.',
    audience: 'adults who need a crown',
    outline: [
      {
        heading: 'How much does a crown cost?',
        directAnswer: 'A porcelain crown costs between $900 and $1,500.',
        points: ['price range'],
        factIds: ['b1'],
      },
      {
        heading: 'How long does a crown take?',
        directAnswer: 'Same-day crowns take about two hours.',
        points: [],
        factIds: [],
      },
      {
        heading: 'Does insurance cover a crown?',
        directAnswer: 'Often in part. Ask your plan what it pays.',
        points: [],
        factIds: [],
      },
    ],
    entities: ['Austin'],
    internalLinks: [],
    schemaType: 'FAQPage',
    version: 'b1',
  };
  const research = {
    version: 'r1',
    warning: null,
    searches: 3,
    fetches: 1,
    facts: [
      {
        claim: 'A porcelain crown typically costs $800 to $1,700 per tooth.',
        url: 'https://www.ada.org/crowns',
        quote: 'typically costs between $800 and $1,700 per tooth',
        verified: true,
      },
      { claim: 'Half of adults have a crown.', url: 'https://example.test/stats', verified: false },
    ],
    pack: {
      question: 'How much does a crown cost?',
      engines: [
        { engineCode: 'perplexity', readable: 3, named: [{ name: 'Rival Smiles', count: 2 }] },
      ],
      sources: [
        {
          url: 'https://reviews.example.test/austin-dentists',
          title: 'Best dentists in Austin',
          timesCited: 3,
          isOwn: false,
          format: 'best_of',
        },
      ],
      format: { recommended: 'faq', basis: 'the way the question is asked' },
    },
  };
  const check = (code, label, weight, points, status, findings = []) => ({
    code,
    label,
    weight,
    points,
    status,
    blocking: false,
    findings,
  });
  const qc = {
    version: 1,
    score: 86,
    ready: true,
    blocking: [],
    words: 300,
    checks: [
      check('answer_first', 'Answer first', 25, 25, 'pass'),
      check('unsupported_claims', 'Claims have sources', 20, 14, 'warn', [
        'No source for: "A porcelain crown costs between $900 and $1,500."',
      ]),
      check('heading_structure', 'Headings', 15, 15, 'pass'),
      check('reading_level', 'Reading level', 10, 10, 'pass'),
      check('banned_words', 'Words to avoid', 10, 10, 'pass'),
      check('overlap', 'Not a copy of your site', 10, 10, 'pass'),
      check('schema_valid', 'Structured data', 10, 2, 'fail', [
        'A FAQPage is better with description.',
      ]),
    ],
  };
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: 'How much does a crown cost in Austin?',
        author: { '@type': 'Organization', name: 'Acme Dental' },
        publisher: { '@type': 'Organization', name: 'Acme Dental' },
        datePublished: '2026-10-04',
        dateModified: '2026-10-04',
      },
    ],
  };
  const make = (status, extra = {}) =>
    fx.contentItem(dashProject, {
      title: 'How much does a crown cost in Austin?',
      status,
      brief,
      research,
      qc,
      jsonld,
      html,
      userId: people.owner.id,
      ...extra,
    });
  contentIds.ready = (await make('ready')).public_id;
  contentIds.approved = (await make('approved')).public_id;
  contentIds.published = (
    await make('published', { publishedUrl: 'https://www.example.test/crown-cost/' })
  ).public_id;
  contentIds.working = (
    await fx.contentItem(dashProject, {
      title: 'Teeth whitening aftercare',
      status: 'drafting',
      brief,
      research,
    })
  ).public_id;
  contentIds.failed = (
    await fx.contentItem(dashProject, {
      title: 'Emergency dentist hours',
      status: 'failed',
      failure: {
        stage: 'researching',
        reason: 'The writing service was busy or unavailable. Try again in a few minutes.',
      },
    })
  ).public_id;
  await scoped.integrations.saveWordpress(project.id, {
    config: {
      siteUrl: 'https://wp.example.test',
      username: 'editor',
      siteName: 'Sample Dental Blog',
      pluginInstalled: true,
      pluginConnected: true,
      pluginVersion: '1.0.0',
      seoPlugin: 'yoast',
      canPublish: true,
      checkedAt: new Date().toISOString(),
    },
    secret: { ciphertext: Buffer.alloc(40, 1), wrappedDek: Buffer.alloc(60, 2), keyVersion: 1 },
    userId: people.owner.id,
  });
}

// Billing and traffic (Milestone 8): the organization is on a trial; the dashboard project has Google connected with eight weeks of
// AI visits, the running project is waiting for a property to be chosen, and the incomplete one has not connected Google.
const googleSecret = createSecretBox(config.secrets);
{
  await fx.setOrg(org.id, { plan_code: 'starter', billing_status: 'trialing' });
  const trial = new Date(Date.now() + 6 * DAY);
  await db.system.billing.subscriptions.apply({
    parsed: {
      stripeSubscriptionId: `sub_e2e_${unique()}`,
      stripeCustomerId: `cus_e2e_${unique()}`,
      orgPublicId: org.public_id,
      planCode: 'starter',
      status: 'trialing',
      orgStatus: 'trialing',
      trialEndsAt: trial,
      currentPeriodStart: new Date(),
      currentPeriodEnd: trial,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      addons: [],
    },
  });
  const grant = (project) =>
    scoped.google.saveGrant(project.id, {
      secret: googleSecret.encrypt('rt-e2e', `google:${org.id}:${project.id}`),
      scopes: [],
      properties: [{ id: '123456789', name: 'Data Dental - GA4', account: 'Data Dental' }],
      sites: [{ siteUrl: 'https://data-dental.example.test/', level: 'siteOwner' }],
      userId: people.owner.id,
    });
  await grant(runningProject);
  await grant(dashProject);
  await scoped.google.choose(dashProject.id, {
    ga4PropertyId: '123456789',
    gscSiteUrl: 'https://data-dental.example.test/',
  });
  const monday = (weeksAgo) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - weeksAgo * 7);
    return d.toISOString().slice(0, 10);
  };
  const rows = [];
  for (let w = 1; w <= 9; w += 1) {
    const date = monday(w);
    rows.push(
      {
        metricDate: date,
        channel: 'chatgpt',
        landingPage: '/pricing',
        sessions: 8 + w,
        engagedSessions: 5,
        keyEvents: 1,
        revenue: 0,
        currency: 'USD',
      },
      {
        metricDate: date,
        channel: 'perplexity',
        landingPage: '/',
        sessions: 4,
        engagedSessions: 3,
        keyEvents: 0,
        revenue: 0,
        currency: 'USD',
      },
      {
        metricDate: date,
        channel: 'all',
        landingPage: '',
        sessions: 180,
        engagedSessions: 110,
        keyEvents: 6,
        revenue: 0,
        currency: 'USD',
      },
    );
  }
  await scoped.traffic.saveGa4(dashProject.id, rows);
  await scoped.traffic.saveSearch(dashProject.id, [
    {
      metricDate: monday(1),
      dimension: 'query',
      value: 'data dental austin',
      isBranded: true,
      clicks: 14,
      impressions: 60,
      avgPosition: 1.3,
    },
  ]);
  await scoped.google.syncResult(dashProject.id, {
    ok: true,
    from: monday(9),
    to: new Date(Date.now() - DAY).toISOString().slice(0, 10),
  });
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
  contentReadyId: contentIds.ready,
  contentApprovedId: contentIds.approved,
  contentPublishedId: contentIds.published,
  contentWorkingId: contentIds.working,
  contentFailedId: contentIds.failed,
  unsubscribeToken: unsubscribeToken(
    { userId: String(people.owner.id), pref: 'digest' },
    config.appSecret,
  ),
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
const queuedContentJobs = [];
const posthogEvents = [];
const audit = {
  otp: createOtpStore(testRedis.redis, {
    prefix: testRedis.prefix,
    secret: 'e2e-otp-secret-e2e-otp-secret',
  }),
  limiter: createAuditLimiter({ redis: testRedis.redis, prefix: testRedis.prefix, db }),
  turnstile: { verify: async () => ({ ok: true }) },
  mail: createAuditMail({ mailer, baseUrl: config.baseUrl }),
  jobs: { add: async (name, data) => void queuedJobs.push({ name, data }) },
  // The funnel posts to a PostHog stand-in on this same server (/__e2e/posthog), so a test can read what was sent.
  funnel: createFunnel({
    posthog: { host: `http://127.0.0.1:${config.port}/__e2e/posthog`, apiKey: 'phc_e2e' },
  }),
};

// --- the app ----------------------------------------------------------------------------------------
const app = createApp({
  config,
  logger,
  db,
  provider,
  mailer,
  audit,
  // The Content Studio's own queue (it only remembers), a Redis that holds no draft, and the dev key for secrets.
  content: {
    jobs: { add: async (name, data) => void queuedContentJobs.push({ name, data }) },
    redis: { get: async () => null },
    prefix: 'e2e',
    secrets: createSecretBox(config.secrets),
    fetcher: createSafeFetcher(),
  },
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
    application.get('/__e2e/content/jobs', (req, res) => res.json(queuedContentJobs));

    // A PostHog stand-in: the funnel's server-side events land here, and a test reads them back.
    application.post('/__e2e/posthog/capture/', express.json(), (req, res) => {
      posthogEvents.push(req.body);
      res.json({ status: 1 });
    });
    application.get('/__e2e/posthog/events', (req, res) => res.json(posthogEvents));

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
