import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { NOT_WIRED, SUBPROCESSORS } from '../../src/core/subprocessors.js';
import { appFor, envs } from './helpers.js';

/**
 * The subprocessor list against the code (Milestone 10, task 10.11). The public list must name every company the
 * software is wired to, and nothing it isn't. "Wired" is read from four places a vendor can't hide: the environment
 * variables the config reads, the host names in the source, the dependencies in package.json and the provider codes in
 * the reference data. Adding a vendor to any of them fails here until the list (and so the privacy page, the
 * subprocessor page and the DPA) says so.
 */

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir) =>
  readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = `${dir}/${f}`;
    if (statSync(join(ROOT, p)).isDirectory())
      return f === 'generated' || f === 'public' ? [] : walk(p);
    return p.endsWith('.js') && !p.endsWith('.test.js') ? [p] : [];
  });

const config = read('src/lib/config.js');
const source = walk('src').map(read).join('\n');
const pkg = JSON.parse(read('package.json'));
const seed = read('docs/db/seed_reference.sql');

const used = SUBPROCESSORS.filter((s) => s.status === 'in_use');

describe('every entry on the list is real', () => {
  test('each environment variable it names is read by the config', () => {
    for (const s of SUBPROCESSORS)
      for (const name of s.evidence.env ?? [])
        assert.ok(config.includes(name), `${s.name}: ${name} is not in src/lib/config.js`);
  });

  test('each host it names is in the source', () => {
    for (const s of SUBPROCESSORS)
      for (const host of s.evidence.hosts ?? [])
        assert.ok(source.includes(host), `${s.name}: ${host} is not in the source`);
  });

  test('each dependency it names is in package.json', () => {
    for (const s of SUBPROCESSORS)
      for (const dep of s.evidence.deps ?? [])
        assert.ok(pkg.dependencies[dep], `${s.name}: ${dep} is not a dependency`);
  });

  test('each provider code it names is in the reference data', () => {
    for (const s of SUBPROCESSORS)
      for (const code of s.evidence.providerCodes ?? [])
        assert.ok(
          seed.includes(`'${code}'`),
          `${s.name}: provider ${code} is not in seed_reference.sql`,
        );
  });

  test('every entry has some evidence, and an in-use one has evidence beyond a switched-off provider row', () => {
    for (const s of SUBPROCESSORS) {
      const e = s.evidence;
      assert.ok(
        Object.values(e).some((v) => v.length),
        `${s.name} has no evidence`,
      );
      if (s.status === 'in_use')
        assert.ok(
          e.env?.length || e.hosts?.length || e.deps?.length,
          `${s.name} is in use but nothing in the code shows it`,
        );
    }
  });

  test('the list names no vendor we know is not wired', () => {
    const names = SUBPROCESSORS.map((s) => `${s.key} ${s.name}`.toLowerCase()).join(' ');
    for (const key of Object.keys(NOT_WIRED)) {
      assert.ok(
        !names.includes(key.replace('_api', '')),
        `${key} is on the list: ${NOT_WIRED[key]}`,
      );
    }
  });
});

describe('every vendor in the code is on the list', () => {
  /** Environment variables that belong to us, not to a vendor. */
  const OURS =
    /^(NODE_ENV|PORT|TRUST_PROXY|MAINTENANCE_MODE|QUEUE_PREFIX|APP_|DATABASE_URL|SHADOW_DATABASE_URL|REDIS_URL|TEST_|LOG_LEVEL|STAFF_HOST|SECRETS_|CLERK_SIGN_|CLERK_STAFF_|EXTRACTION_MODEL|CONTENT_MODEL|PERPLEXITY_MODEL|SERPAPI_COST|STRIPE_API_VERSION|AUDIT_|EMAIL_FROM|TURNSTILE_SITE|STRIPE_PUBLISHABLE|DO_SPACES_(ENDPOINT|REGION|BUCKET|PREFIX)|POSTHOG_(HOST|ASSETS)|CLOUDFLARE_ACCESS_AUD)/;

  const envNames = [...config.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  const claimed = new Set(SUBPROCESSORS.flatMap((s) => s.evidence.env ?? []));

  test('the config reads a few dozen variables, so the scan is looking at the right place', () => {
    assert.ok(envNames.length > 30, `only ${envNames.length} variables found`);
  });

  test('every variable that is not ours belongs to a listed vendor', () => {
    const orphans = envNames.filter((n) => !OURS.test(n) && !claimed.has(n));
    assert.deepEqual(orphans, [], `variables with no subprocessor: ${orphans.join(', ')}`);
  });

  test('every vendor SDK in package.json is on the list', () => {
    const claimedDeps = new Set(SUBPROCESSORS.flatMap((s) => s.evidence.deps ?? []));
    const vendorLike =
      /anthropic|openai|clerk|stripe|resend|sentry|posthog|langfuse|aws-sdk|googleapis|slack|twilio|sendgrid/;
    const unlisted = Object.keys(pkg.dependencies).filter(
      (d) => vendorLike.test(d) && !claimedDeps.has(d),
    );
    assert.deepEqual(unlisted, [], `dependencies with no subprocessor: ${unlisted.join(', ')}`);
  });

  test('every provider in the reference data is on the list, or known not to be wired', () => {
    const block = seed.slice(seed.indexOf('INSERT INTO providers'), seed.indexOf('AS new'));
    const codes = [...block.matchAll(/^\s*\('([a-z_]+)',/gm)].map((m) => m[1]);
    assert.ok(codes.length >= 5);
    const claimedCodes = new Set(SUBPROCESSORS.flatMap((s) => s.evidence.providerCodes ?? []));
    const missing = codes.filter((c) => !claimedCodes.has(c) && !NOT_WIRED[c]);
    assert.deepEqual(missing, [], `providers with no subprocessor: ${missing.join(', ')}`);
  });

  test('every host the engines and integrations call is on the list', () => {
    const files = [...walk('src/engines'), ...walk('src/integrations')];
    const hosts = new Set(
      files.flatMap((f) =>
        [
          ...read(f).matchAll(/(?:baseUrl\s*=|const API\s*=|_URL\s*=)\s*'https:\/\/([a-z0-9.-]+)/g),
        ].map((m) => m[1]),
      ),
    );
    assert.ok(hosts.size >= 3, 'the scan should find the provider base URLs');
    const claimedHosts = new Set(SUBPROCESSORS.flatMap((s) => s.evidence.hosts ?? []));
    const missing = [...hosts].filter((h) => !claimedHosts.has(h));
    assert.deepEqual(missing, [], `hosts with no subprocessor: ${missing.join(', ')}`);
  });
});

describe('the public pages show the list', () => {
  const app = appFor(envs.production);
  after(() => {});

  test('the subprocessor page names every company in use, and the ones switched off are marked as such', async () => {
    const { text } = await app.get('/subprocessors').expect(200);
    for (const s of used) assert.ok(text.includes(s.name), `${s.name} is missing`);
    assert.match(text, /Which backups are switched off?/);
    assert.match(text, /OpenAI/);
    for (const name of ['Sentry', 'Langfuse'])
      assert.ok(!text.includes(name), `${name} should not be listed`);
  });

  test('the privacy page shows the same companies, and the DPA points at the list', async () => {
    const privacy = (await app.get('/privacy').expect(200)).text;
    for (const s of used) assert.ok(privacy.includes(s.name), `${s.name} is missing from /privacy`);
    const dpa = (await app.get('/dpa').expect(200)).text;
    assert.match(dpa, /href="\/subprocessors"/);
    assert.match(dpa, /<h1[^>]*>Data Processing Agreement<\/h1>/);
    assert.match(dpa, /Draft — not yet reviewed by a lawyer/);
  });

  test('the footer links to both, and the sitemap lists both', async () => {
    const home = (await app.get('/').expect(200)).text;
    assert.match(home, /href="\/subprocessors"/);
    assert.match(home, /href="\/dpa"/);
    const sitemap = (await app.get('/sitemap.xml').expect(200)).text;
    assert.match(sitemap, /\/subprocessors</);
    assert.match(sitemap, /\/dpa</);
  });
});
