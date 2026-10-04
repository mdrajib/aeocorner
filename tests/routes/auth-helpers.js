import { createHmac, randomBytes } from 'node:crypto';
import request from 'supertest';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { loadConfig } from '../../src/lib/config.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createApp } from '../../src/web/app.js';
import { csrfToken } from '../../src/web/auth/csrf.js';
import { silentLogger } from './helpers.js';

/** A real-format Clerk key pair: pk_test_ + base64("<frontend API>$"). The secret is never used to call Clerk. */
const frontendApi = 'example-12.clerk.accounts.dev';
export const clerkKeys = {
  CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${frontendApi}$`).toString('base64')}`,
  CLERK_SECRET_KEY: 'sk_test_not_a_real_key',
  CLERK_WEBHOOK_SECRET: `whsec_${randomBytes(24).toString('base64')}`,
};

export const APP_SECRET = 'test-secret-test-secret-test-secret-123';
export const BASE = 'http://localhost:3000';

/**
 * A stand-in for Clerk with the same four methods as the real provider (src/web/auth/provider.js).
 * A test "signs in" by getting a header value from signIn() and sending it as `X-Test-Session`.
 */
export function fakeClerk() {
  const sessions = new Map();
  const clerkUsers = new Map();
  const revoked = [];

  return {
    configured: true,
    signInUrl: `https://accounts.example.test/sign-in`,
    signUpUrl: `https://accounts.example.test/sign-up`,
    revoked,
    middleware: () => (req, res, next) => next(),
    async authenticate(req) {
      return sessions.get(req.get('x-test-session')) ?? null;
    },
    async fetchUser(id) {
      return clerkUsers.get(id) ?? null;
    },
    async endSession(sessionId) {
      revoked.push(sessionId);
    },

    /**
     * Register a Clerk user and a session for them. `emails` defaults to one verified address.
     * Returns { session, sessionId, csrf } where `session` is the X-Test-Session header value.
     */
    signIn(clerkUser, { emails, claims = {} } = {}) {
      const user = {
        ...clerkUser,
        emails: emails ?? [{ address: clerkUser.email, verified: true, primary: true }],
      };
      clerkUsers.set(user.id, user);
      const sessionId = `sess_${randomBytes(6).toString('hex')}`;
      const session = `t_${randomBytes(6).toString('hex')}`;
      sessions.set(session, { clerkUserId: user.id, sessionId, claims });
      return { session, sessionId, csrf: csrfToken(APP_SECRET, sessionId) };
    },
  };
}

/** Everything a signed-in-area test needs: app, real test database, fake Clerk, in-memory mailer. */
export function authHarness({
  env = {},
  provider = fakeClerk(),
  staffProvider,
  cloudflareKeys,
  queues,
  jobs,
  content,
  billing,
  google,
  domainVerifier,
  funnel,
} = {}) {
  const db = connectTestDb();
  const fx = fixtures(db);
  const mailer = memoryMailer();
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: BASE,
    APP_SECRET,
    ...clerkKeys,
    ...env,
  });
  const app = createApp({
    config,
    logger: silentLogger,
    db,
    provider,
    staffProvider,
    mailer,
    cloudflareKeys,
    queues,
    jobs,
    ...(content ? { content } : {}),
    ...(billing ? { billing } : {}),
    ...(google ? { google } : {}),
    ...(domainVerifier ? { domainVerifier } : {}),
    ...(funnel ? { funnel } : {}),
  });
  const agent = request(app);

  /** Sign a fixture user in and return helpers that send their session on every call. */
  async function signedIn(overrides = {}, options) {
    const user = await fx.user(overrides);
    const clerkUser = fx.clerkUser({ id: user.clerk_user_id, email: user.email, name: user.name });
    const auth = provider.signIn(clerkUser, options);
    const headers = { 'X-Test-Session': auth.session };
    return {
      user,
      ...auth,
      get: (path) => agent.get(path).set(headers),
      post: (path, body = {}, { csrf = auth.csrf, extra = {} } = {}) =>
        agent
          .post(path)
          .set(headers)
          .set(extra)
          .type('form')
          .send({ ...(csrf === null ? {} : { _csrf: csrf }), ...body }),
    };
  }

  return {
    db,
    fx,
    app,
    agent,
    config,
    mailer,
    provider,
    signedIn,
    async close() {
      await fx.cleanup();
      await db.close();
    },
  };
}

/** Sign a webhook body the way Svix does, so the real signature check runs end to end. */
export function svixHeaders({ secret, id, body, timestamp = Math.floor(Date.now() / 1000) }) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
    'content-type': 'application/json',
  };
}

export const orgPathOf = (res) => res.headers.location.match(/^\/app\/o\/([0-9A-Z]{26})/)?.[1];
export const tokenIn = (text) => text.match(/\/invite\/([A-Za-z0-9_-]{40,})/)?.[1];
