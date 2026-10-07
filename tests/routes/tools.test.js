import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import pino from 'pino';
import request from 'supertest';
import { z } from 'zod';
import { validateJsonLd } from '../../src/core/jsonld.js';
import { loadConfig } from '../../src/lib/config.js';
import { createToolRunner } from '../../src/lib/tool-runner.js';
import { createApp } from '../../src/web/app.js';
import { publicPages } from '../../src/web/pages.js';
import { toolDefinitions } from '../../src/web/tools/index.js';
import { toolPages } from '../../src/web/tools/registry.js';
import { CouldntCheck } from '../../src/lib/tool-runner.js';
import { checkbox, siteInput } from '../../src/web/tools/shared.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The free tools' routes and pages (Milestone 17, task 17.04), with stand-in tools: the hub, a tool's page, what a run
 * does and in what order (closed? valid? human? busy? allowed? run), and what the answer is allowed to carry. The real
 * tools have their own tests; this is the machinery they share.
 */
const config = loadConfig({
  ...envs.production,
  POSTHOG_API_KEY: 'phc_test',
  POSTHOG_HOST: 'https://posthog.test',
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
});

const faq = [{ q: 'Is it free?', a: 'Yes, and it needs no account.' }];

/** A generator: our own code on what was typed. */
const shout = {
  slug: 'shout',
  kind: 'generate',
  name: 'Shout generator',
  crumb: 'Shout generator',
  title: 'Shout generator: make text loud | AEO Corner',
  description: 'Makes text loud. A stand-in tool for the tests.',
  lastmod: '2026-10-06',
  lead: 'Turns what you type into capitals.',
  cannotSee: 'It cannot tell whether anyone is listening.',
  faq,
  submitLabel: 'Make it loud',
  fields: [
    { name: 'text', label: 'Your text', type: 'textarea', rows: 3 },
    { name: 'twice', label: 'Say it twice', type: 'checkbox' },
  ],
  schema: z.object({
    text: z.string({ error: 'Type something.' }).min(1, { error: 'Type something.' }).max(500),
    twice: checkbox,
  }),
  run: async (ctx, input) => ({
    headline: `Shouted ${input.text.length} characters`,
    sections: [
      {
        heading: 'Result',
        rows: [
          { label: input.text.toUpperCase(), state: 'good', value: input.twice ? 'twice' : '' },
        ],
      },
    ],
    output: { filename: 'shout.txt', text: input.text.toUpperCase() },
  }),
};

/** A checker: asks someone's site. */
const peek = {
  slug: 'peek',
  kind: 'fetch',
  name: 'Peek checker',
  crumb: 'Peek checker',
  title: 'Peek checker: look at a site | AEO Corner',
  description: 'Looks at one file of a site. A stand-in tool for the tests.',
  lastmod: '2026-10-06',
  lead: 'Looks at one file of your site.',
  cannotSee: 'It cannot see behind a login.',
  faq,
  fields: [{ name: 'url', label: 'Your website', type: 'text', inputmode: 'url' }],
  schema: z.object({ url: siteInput }),
  domain: (input) => input.url.domain,
  run: async (ctx, input) => {
    const res = await ctx.get(`${input.url.origin}/robots.txt`);
    if (!res.ok) throw new CouldntCheck('The site did not answer.');
    return { headline: `Read ${input.url.domain}`, sections: [] };
  },
};

const definitions = [shout, peek];

/** The services, as stand-ins that record what they were asked. */
function services(over = {}) {
  const log = { admit: [], turnstile: [], ran: [] };
  const svc = {
    definitions,
    limiter: {
      admit: async (args) => {
        log.admit.push(args);
        return { allowed: true };
      },
    },
    turnstile: {
      verify: async (args) => {
        log.turnstile.push(args);
        return { ok: true };
      },
    },
    runner: {
      inFlight: () => 0,
      limits: { inFlight: 4 },
      run: async (tool, input) => {
        log.ran.push(input);
        return {
          status: 'ok',
          result: await tool({ get: async () => ({ ok: true }) }, input),
          fetches: 0,
        };
      },
    },
    ...over,
  };
  return { svc, log };
}

const appWith = (svc, { db = null, logger = silentLogger } = {}) =>
  request(createApp({ config, logger, db, tools: svc }));
const post = (app, path, body) => app.post(path).type('form').send(body);

describe('the tools that are listed', () => {
  test('the registry lists the hub and a page for every listed tool, and nothing else is public', async () => {
    const listed = toolDefinitions.map((d) => d.slug);
    assert.ok(listed.length > 0);
    assert.deepEqual(
      publicPages.filter((p) => p.own).map((p) => p.path),
      ['/tools', ...listed.map((s) => `/tools/${s}`)],
    );
    const app = request(createApp({ config, logger: silentLogger }));
    await app.get('/tools').expect(200);
    for (const slug of listed) await app.get(`/tools/${slug}`).expect(200);
    await app.get('/tools/a-tool-that-is-not-listed').expect(404);
    await app.post('/tools/a-tool-that-is-not-listed').type('form').send({}).expect(404);
  });

  test('every listed tool is a complete definition', () => {
    const kinds = new Set(['fetch', 'generate']);
    for (const d of toolDefinitions) {
      assert.ok(kinds.has(d.kind), d.slug);
      for (const key of ['name', 'crumb', 'title', 'description', 'lastmod', 'lead', 'cannotSee'])
        assert.ok(typeof d[key] === 'string' && d[key].length >= 10, `${d.slug}.${key}`);
      assert.ok(d.description.length <= 170, `${d.slug}: a description a search result can show`);
      assert.ok(d.title.length <= 70, `${d.slug}: a title a search result can show`);
      // Our own readiness check E2 (and so the dogfood scan) wants a direct answer of 5 to 60 words under every question
      // heading: the FAQ answers, and the paragraph under "What this tool cannot tell you".
      const words = (text) => text.trim().split(/\s+/).length;
      assert.ok(
        words(d.cannotSee) <= 60,
        `${d.slug}: cannotSee is ${words(d.cannotSee)} words; keep it to 60`,
      );
      for (const f of d.faq)
        assert.ok(
          words(f.a) >= 5 && words(f.a) <= 60,
          `${d.slug}: the answer to "${f.q}" is ${words(f.a)} words; keep it from 5 to 60`,
        );
      assert.ok(d.faq.length >= 3 && d.faq.every((f) => f.q.endsWith('?') && f.a.length > 20));
      assert.ok(d.fields.length > 0 && typeof d.schema.safeParse === 'function');
      assert.equal(typeof d.run, 'function');
      if (d.kind === 'fetch') assert.equal(typeof d.domain, 'function', `${d.slug} needs a domain`);
      assert.ok(/^[a-z0-9-]+$/.test(d.slug));
    }
    assert.equal(new Set(toolDefinitions.map((d) => d.slug)).size, toolDefinitions.length);
  });

  test('every tool page has the same structure as a marketing page: one h1, a cannot-see section, an FAQ, a way to the audit, valid structured data', async () => {
    const app = request(createApp({ config, logger: silentLogger }));
    for (const d of toolDefinitions) {
      const { text } = await app.get(`/tools/${d.slug}`).expect(200);
      assert.equal((text.match(/<h1[ >]/g) ?? []).length, 1, d.slug);
      assert.match(text, /What this tool cannot tell you/, d.slug);
      assert.ok(
        text.includes(`href="/?utm_source=tools&amp;utm_campaign=${d.slug}#audit"`),
        `${d.slug}: a way to the free audit, tagged as coming from the tools`,
      );
      assert.ok(
        text.includes(`<link rel="canonical" href="${config.baseUrl}/tools/${d.slug}"`),
        `${d.slug}: canonical`,
      );
      const types = [];
      for (const m of text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        const doc = JSON.parse(m[1]);
        const checked = validateJsonLd(doc);
        assert.equal(checked.ok, true, `${d.slug}: ${JSON.stringify(checked.errors)}`);
        types.push(...(doc['@graph'] ?? [doc]).map((n) => n['@type']));
      }
      for (const type of ['Organization', 'WebSite', 'WebApplication', 'BreadcrumbList', 'FAQPage'])
        assert.ok(types.includes(type), `${d.slug} has no ${type}`);
    }
  });

  test('the footer links to /tools once a tool is listed', async () => {
    const { text } = await request(createApp({ config, logger: silentLogger }))
      .get('/')
      .expect(200);
    assert.match(text, /href="\/tools"/);
  });
});

describe('the registry for a set of tools', () => {
  test('a hub and one page per tool, each served by its own router, with their own names', () => {
    const pages = toolPages(definitions);
    assert.deepEqual(
      pages.map((p) => p.path),
      ['/tools', '/tools/shout', '/tools/peek'],
    );
    assert.ok(pages.every((p) => p.own === true && p.crumb && p.title && p.description));
    assert.equal(new Set(pages.map((p) => p.name ?? p.view)).size, pages.length);
  });
});

describe('the hub and a tool page', () => {
  const { svc } = services();
  const app = appWith(svc);

  test('the hub lists every tool with a link, in the HTML', async () => {
    const { text } = await app.get('/tools').expect(200);
    assert.equal((text.match(/<h1/g) ?? []).length, 1);
    for (const t of definitions) {
      assert.match(text, new RegExp(`href="/tools/${t.slug}"`));
      assert.ok(text.includes(t.name) && text.includes(t.lead));
    }
    assert.match(text, /<link rel="canonical" href="https:\/\/aeocorner\.com\/tools"/);
    assert.match(text, /BreadcrumbList/);
  });

  test('a tool page is complete in the raw HTML: one h1, the form, what it cannot do, the FAQ', async () => {
    const { text } = await app.get('/tools/shout').expect(200);
    assert.equal((text.match(/<h1/g) ?? []).length, 1);
    assert.match(text, /<form method="post" action="\/tools\/shout#result"/);
    assert.match(text, /name="text"/);
    assert.match(text, /type="checkbox" id="tool-twice" name="twice"/);
    assert.ok(text.includes(shout.cannotSee));
    assert.ok(text.includes('Is it free?') && text.includes('Yes, and it needs no account.'));
    assert.match(text, /"@type":"FAQPage"/);
    assert.match(text, /<meta name="robots" content="index, follow/);
    assert.match(text, /posthog-config/, 'the explainer page is a normal marketing page');
    assert.doesNotMatch(text, /Couldn’t check/, 'no result yet');
  });

  test('only a fetch tool shows the bot check, and only when Turnstile is wired', async () => {
    assert.match((await app.get('/tools/peek')).text, /class="cf-turnstile"/);
    assert.doesNotMatch((await app.get('/tools/shout')).text, /class="cf-turnstile"/);
    const noTurnstile = appWith({ ...svc, turnstile: null });
    assert.doesNotMatch((await noTurnstile.get('/tools/peek')).text, /class="cf-turnstile"/);
  });

  test('Cloudflare’s script loads only on a page that has the widget: a fetch tool, not a generator or the hub', async () => {
    const script = /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/;
    assert.match((await app.get('/tools/peek')).text, script);
    assert.doesNotMatch((await app.get('/tools/shout')).text, script);
    assert.doesNotMatch((await app.get('/tools')).text, script);
  });

  test('an unknown tool is a plain 404', async () => {
    await app.get('/tools/nothing-here').expect(404);
    await post(app, '/tools/nothing-here', {}).expect(404);
  });
});

describe('running a tool', () => {
  test('an answer is private to the visitor: no cache, no index, no referrer, no analytics', async () => {
    const { svc } = services();
    const res = await post(appWith(svc), '/tools/shout', { text: 'hello' }).expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-robots-tag'], 'noindex');
    assert.match(res.text, /<meta name="robots" content="noindex, nofollow"/);
    assert.doesNotMatch(res.text, /posthog-config/);
    assert.doesNotMatch(res.text, /"@type":"FAQPage"/);
    assert.match(res.text, /id="result"/);
    assert.match(res.text, /Shouted 5 characters/);
    assert.match(res.text, /<textarea[^>]*id="tool-output"[^>]*readonly>HELLO<\/textarea>/);
    assert.match(res.text, /data-copy-from="tool-output"/);
  });

  test('what was typed is shown again in the form, escaped', async () => {
    const { svc } = services();
    const evil = '"><script>alert(1)</script>';
    const { text } = await post(appWith(svc), '/tools/shout', { text: evil, twice: '1' }).expect(
      200,
    );
    assert.doesNotMatch(text, /<script>alert\(1\)<\/script>/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(text, /name="twice" value="1" checked/);
  });

  test('text from a result is only text: markup in a finding comes out escaped', async () => {
    const hostile = {
      ...shout,
      run: async () => ({
        headline: '<img src=x onerror=alert(1)>',
        sections: [
          {
            heading: '<b>h</b>',
            rows: [{ label: '<script>x()</script>', state: 'bad', detail: '"><svg onload=1>' }],
          },
        ],
        lines: { heading: 'File', items: ['</code></pre><script>y()</script>'] },
        notes: ['<iframe src=//evil.test>'],
      }),
    };
    const { svc } = services({ definitions: [hostile] });
    const { text } = await post(appWith(svc), '/tools/shout', { text: 'a' }).expect(200);
    for (const bad of [
      '<img src=x',
      '<script>x()',
      '<svg onload',
      '</code></pre><script>',
      '<iframe',
    ]) {
      assert.ok(!text.includes(bad), bad);
    }
    assert.match(text, /&lt;script&gt;x\(\)&lt;\/script&gt;/);
  });

  test('a finding the gate does not accept is "couldn’t check", never the tool’s own words', async () => {
    const logged = [];
    const broken = {
      ...shout,
      run: async () => ({ headline: 'x', sections: [{ rows: [{ label: 'a', state: 'great' }] }] }),
    };
    const { svc } = services({ definitions: [broken] });
    const logger = pino({ level: 'silent' });
    logger.error = (...a) => logged.push(a);
    const res = await post(appWith(svc, { logger }), '/tools/shout', { text: 'a' }).expect(200);
    assert.match(res.text, /Couldn’t check/);
    assert.match(res.text, /Something went wrong on our side/);
    assert.doesNotMatch(res.text, /great/);
    assert.ok(logged.length > 0);
  });

  test('a tool that could not look says so in its own plain words', async () => {
    const { svc, log } = services();
    const real = createToolRunner({
      fetcher: {
        fetch: async () => {
          throw new Error('boom 10.0.0.1');
        },
      },
    });
    const res = await post(appWith({ ...svc, runner: real }), '/tools/peek', {
      url: 'acme-test.com',
      'cf-turnstile-response': 'ok',
    }).expect(200);
    assert.match(res.text, /Couldn’t check/);
    assert.match(res.text, /Something went wrong on our side|The site did not answer|could not/i);
    assert.doesNotMatch(res.text, /boom|10\.0\.0\.1/);
    assert.equal(log.admit.length, 1);
  });
});

describe('the order of the checks, and what each one costs a visitor', () => {
  test('without the services the tool says it opens soon, and nothing is run, counted or checked', async () => {
    // Only the tool list is given (the tests' way of listing stand-in tools): no limiter, no runner.
    const app = appWith({ definitions });
    const res = await post(app, '/tools/shout', { text: 'hello' }).expect(503);
    assert.match(res.text, /This tool opens soon/);
    assert.equal(res.headers['cache-control'], 'no-store');
    await app.get('/tools/shout').expect(200);
  });

  test('a fetch tool with no Turnstile is closed, a generator beside it still runs', async () => {
    const { svc, log } = services({ turnstile: null });
    const app = appWith(svc);
    await post(app, '/tools/peek', { url: 'acme-test.com' }).expect(503);
    assert.equal(log.ran.length, 0);
    await post(app, '/tools/shout', { text: 'a' }).expect(200);
  });

  test('a form that does not validate is a 422 with a message by the field, and costs nothing', async () => {
    const { svc, log } = services();
    const app = appWith(svc);
    const res = await post(app, '/tools/shout', { text: '' }).expect(422);
    assert.match(res.text, /Type something\./);
    assert.match(res.text, /aria-invalid="true"/);
    const bad = await post(app, '/tools/peek', {
      url: 'not a website',
      'cf-turnstile-response': 't',
    }).expect(422);
    assert.match(bad.text, /doesn’t look like a website address/);
    assert.deepEqual(log, { admit: [], turnstile: [], ran: [] });
  });

  test('a repeated or nested field is invalid, not a crash', async () => {
    const { svc } = services();
    const app = appWith(svc);
    await app.post('/tools/shout').type('form').send('text=a&text=b').expect(422);
    await app.post('/tools/shout').type('form').send('text[a]=b').expect(422);
    await app.post('/tools/peek').type('form').send('url=a.com&url=b.com').expect(422);
  });

  test('a body over 1 MB is refused before it is read into a tool', async () => {
    const { svc, log } = services();
    const res = await post(appWith(svc), '/tools/shout', { text: 'x'.repeat(1_100_000) });
    assert.equal(res.status, 413);
    assert.equal(log.ran.length, 0);
  });

  test('a fetch tool needs a person: a failed bot check is refused before the limiter or the run', async () => {
    const { svc, log } = services({
      turnstile: { verify: async () => ({ ok: false, reason: 'rejected' }) },
    });
    const res = await post(appWith(svc), '/tools/peek', { url: 'acme-test.com' }).expect(422);
    assert.match(res.text, /couldn’t confirm you’re a person/);
    assert.deepEqual([log.admit.length, log.ran.length], [0, 0]);
  });

  test('a bot check that cannot be reached is a 503, not a pass', async () => {
    const { svc } = services({
      turnstile: { verify: async () => ({ ok: false, reason: 'unavailable' }) },
    });
    await post(appWith(svc), '/tools/peek', { url: 'acme-test.com' }).expect(503);
  });

  test('the limiter is asked with the connection, the kind and the site; a generator has no site', async () => {
    const { svc, log } = services();
    const app = appWith(svc);
    await post(app, '/tools/peek', {
      url: 'https://www.Acme-Test.com/about',
      'cf-turnstile-response': 'tok',
    }).expect(200);
    await post(app, '/tools/shout', { text: 'a' }).expect(200);
    assert.equal(log.admit[0].kind, 'fetch');
    assert.equal(log.admit[0].domain, 'acme-test.com');
    assert.ok(log.admit[0].ip);
    assert.deepEqual([log.admit[1].kind, log.admit[1].domain], ['generate', undefined]);
    assert.equal(log.turnstile[0].token, 'tok');
    assert.equal(log.turnstile.length, 1, 'only the fetch tool asked for a bot check');
  });

  for (const [reason, status] of [
    ['ip_minute', 429],
    ['ip_day', 429],
    ['domain_hour', 429],
    ['blocked', 403],
  ]) {
    test(`a refusal "${reason}" is a ${status} in plain words, with a Retry-After when there is a wait, and nothing runs`, async () => {
      const { svc, log } = services({
        limiter: {
          admit: async () => ({
            allowed: false,
            reason,
            retryAfterMs: reason === 'blocked' ? undefined : 90_000,
          }),
        },
      });
      const res = await post(appWith(svc), '/tools/shout', { text: 'a' }).expect(status);
      assert.equal(log.ran.length, 0);
      if (reason === 'blocked') {
        assert.equal(res.headers['retry-after'], undefined);
        assert.doesNotMatch(res.text, /blocked|strike|abuse/i);
      } else {
        assert.equal(res.headers['retry-after'], '90');
        assert.match(res.text, /try again in about 2 minutes/);
      }
    });
  }

  test('Redis down closes the tool: a 503, and nothing runs', async () => {
    const { svc, log } = services({
      limiter: {
        admit: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    const res = await post(appWith(svc), '/tools/shout', { text: 'a' }).expect(503);
    assert.match(res.text, /unavailable right now/);
    assert.doesNotMatch(res.text, /ECONNREFUSED/);
    assert.equal(log.ran.length, 0);
  });

  test('a busy process says so before the limiter, so waiting costs the visitor no check', async () => {
    const { svc, log } = services({
      runner: { inFlight: () => 4, limits: { inFlight: 4 }, run: async () => ({ status: 'busy' }) },
    });
    const res = await post(appWith(svc), '/tools/shout', { text: 'a' }).expect(503);
    assert.equal(res.headers['retry-after'], '30');
    assert.match(res.text, /Lots of people/);
    assert.equal(log.admit.length, 0);
  });

  test('a run that finds itself busy at the last moment is the same answer', async () => {
    const { svc } = services({
      runner: { inFlight: () => 0, limits: { inFlight: 4 }, run: async () => ({ status: 'busy' }) },
    });
    const res = await post(appWith(svc), '/tools/shout', { text: 'a' }).expect(503);
    assert.equal(res.headers['retry-after'], '30');
  });
});

describe('the staff switch (free_tools)', () => {
  const dbWith = (isEnabled) => ({
    reference: { plans: { list: async () => [] } },
    system: { flags: { isEnabled } },
  });

  test('on: the tool runs. Off: every tool is closed. Unreadable: closed, never open', async () => {
    const asked = [];
    const on = services();
    await post(
      appWith(on.svc, { db: dbWith(async (k) => (asked.push(k), true)) }),
      '/tools/shout',
      { text: 'a' },
    ).expect(200);
    assert.deepEqual(asked, ['free_tools']);

    const off = services();
    const res = await post(appWith(off.svc, { db: dbWith(async () => false) }), '/tools/shout', {
      text: 'a',
    }).expect(503);
    assert.match(res.text, /paused/);
    assert.equal(off.log.ran.length, 0);

    const broken = services();
    await post(
      appWith(broken.svc, {
        db: dbWith(async () => {
          throw new Error('db down');
        }),
      }),
      '/tools/shout',
      { text: 'a' },
    ).expect(503);
    assert.equal(broken.log.ran.length, 0);
  });

  test('the flag is one the application reads, so the console lists it', async () => {
    const { KNOWN_FLAGS } = await import('../../src/core/flags.js');
    assert.ok(Object.hasOwn(KNOWN_FLAGS, 'free_tools'));
  });
});

describe('the funnel counts a run (17.13)', () => {
  const events = [];
  const funnel = { capture: async (event, props) => events.push({ event, props }) };
  const setup = (over = {}) => {
    events.length = 0;
    const { svc } = services({
      definitions: [{ ...shout, download: true }, peek],
      ...over,
    });
    return request(createApp({ config, logger: silentLogger, tools: svc, funnel }));
  };

  test('every listed tool is on the funnel’s list of names', async () => {
    const { TOOL_SLUGS } = await import('../../src/core/tool-slugs.js');
    assert.deepEqual([...TOOL_SLUGS].sort(), toolDefinitions.map((d) => d.slug).sort());
  });

  test('a run sends the tool and the outcome, never what was typed', async () => {
    const app = setup();
    await post(app, '/tools/shout', { text: 'secret words' }).expect(200);
    assert.deepEqual(events, [{ event: 'tool_used', props: { tool: 'shout', outcome: 'ok' } }]);
    assert.doesNotMatch(JSON.stringify(events), /secret words/);
  });

  test('a run that could not look says so, and a refusal or a mistake is not a use', async () => {
    const app = setup({
      runner: {
        inFlight: () => 0,
        limits: { inFlight: 4 },
        run: async () => ({ status: 'couldnt_check', reason: 'The site did not answer.' }),
      },
    });
    await post(app, '/tools/peek', { url: 'acme-test.com' }).expect(200);
    assert.deepEqual(events, [
      { event: 'tool_used', props: { tool: 'peek', outcome: 'couldnt_check' } },
    ]);
    events.length = 0;
    await post(app, '/tools/shout', { text: '' }).expect(422);
    assert.deepEqual(events, []);
  });

  test('the file button re-runs the same input and is not counted twice', async () => {
    const app = setup();
    await post(app, '/tools/shout', { text: 'a' }).expect(200);
    await post(app, '/tools/shout/download', { text: 'a' }).expect(200);
    assert.equal(events.length, 1);
  });
});

describe('a generator’s file as a download', () => {
  const maker = {
    ...shout,
    slug: 'maker',
    download: true,
    name: 'File maker',
    crumb: 'File maker',
    title: 'File maker: make a file | AEO Corner',
    description: 'Makes a file. A stand-in tool for the tests.',
  };
  const setup = (over = {}) => {
    const { svc, log } = services({ definitions: [maker, shout, peek], ...over });
    return { app: appWith(svc), log };
  };

  test('the answer has a Download button that posts the same choices, and nothing else', async () => {
    const { app } = setup();
    const res = await post(app, '/tools/maker', { text: 'hello "there"', twice: '1' }).expect(200);
    assert.match(res.text, /<form method="post" action="\/tools\/maker\/download">/);
    assert.match(res.text, /name="text" value="hello &#34;there&#34;"/);
    assert.match(res.text, /name="twice" value="1"/);
    assert.match(res.text, /Download shout\.txt/);
  });

  test('a tool that is not a download tool has no button and no download address', async () => {
    const { app } = setup();
    const res = await post(app, '/tools/shout', { text: 'hello' }).expect(200);
    assert.doesNotMatch(res.text, /\/download/);
    await post(app, '/tools/shout/download', { text: 'hello' }).expect(404);
    await post(app, '/tools/peek/download', { url: 'acme-test.com' }).expect(404);
  });

  test('the download is the file as plain text, private, and never sniffed as anything else', async () => {
    const { app } = setup();
    const res = await post(app, '/tools/maker/download', { text: 'hello <b>there</b>' }).expect(
      200,
    );
    assert.equal(res.text, 'HELLO <B>THERE</B>');
    assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.equal(res.headers['content-disposition'], 'attachment; filename="shout.txt"');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-robots-tag'], 'noindex');
  });

  test('a download is a run: a bad form is the page with its message, a refusal is the refusal, and nothing is sent as a file', async () => {
    const { app, log } = setup();
    const bad = await post(app, '/tools/maker/download', { text: '' }).expect(422);
    assert.match(bad.headers['content-type'], /html/);
    assert.match(bad.text, /Type something\./);
    assert.equal(log.ran.length, 0);

    const refused = setup({
      limiter: {
        admit: async () => ({ allowed: false, reason: 'ip_minute', retryAfterMs: 30_000 }),
      },
    });
    const res = await post(refused.app, '/tools/maker/download', { text: 'a' }).expect(429);
    assert.match(res.headers['content-type'], /html/);
    assert.equal(res.headers['retry-after'], '30');
    assert.equal(refused.log.ran.length, 0);
  });

  test('every download is counted by the limiter like the page is', async () => {
    const { app, log } = setup();
    await post(app, '/tools/maker', { text: 'a' }).expect(200);
    await post(app, '/tools/maker/download', { text: 'a' }).expect(200);
    assert.equal(log.admit.length, 2);
    assert.deepEqual(
      log.admit.map((a) => a.kind),
      ['generate', 'generate'],
    );
  });
});
