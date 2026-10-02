// The server Playwright drives (see playwright.config.js). It is the real app, wired like production, with two
// differences that exist only here: Clerk is replaced by a fake that reads a `test_session` cookie, and the
// database is the test database, seeded with a small organization. A /__e2e route signs a browser in as a
// seeded person. Nothing in this file ships: it lives under tests/ and nothing in src/ imports it.
import { randomBytes } from 'node:crypto';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { loadConfig } from '../../src/lib/config.js';
import { createLogger } from '../../src/lib/logger.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { hashToken, newToken } from '../../src/lib/tokens.js';
import { createApp } from '../../src/web/app.js';

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

const tokens = {
  signedOut: await invite(`new.hire.${unique()}@example.test`, 'editor'),
  accept: await invite(people.invitee.email, 'viewer'),
  expired: await invite(`late.${unique()}@example.test`, 'viewer', { ttl: -1000 }),
};

const fixtureInfo = {
  orgId: org.public_id,
  tokens,
  unknownToken: 'x'.repeat(43),
  roles: Object.keys(people),
};

// --- the app ----------------------------------------------------------------------------------------
const app = createApp({
  config,
  logger,
  db,
  provider,
  mailer,
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
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
