import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import request from 'supertest';
import { MONEY_BACK_DAYS, TRIAL_DAYS } from '../../src/core/entitlements.js';
import { validateJsonLd } from '../../src/core/jsonld.js';
import { TOOL_SLUGS } from '../../src/core/tool-slugs.js';
import { connectTestDb } from '../../src/db/testing.js';
import { loadConfig } from '../../src/lib/config.js';
import { createApp } from '../../src/web/app.js';
import { agency, stages } from '../../src/web/content/product.js';
import { publicPages } from '../../src/web/pages.js';
import { BASE, envs, silentLogger } from './helpers.js';

/**
 * The marketing site (Milestone 9): the four product pages, the agency page, pricing from the `plans` table, the
 * structured data on every page, and the sitemap's links. Pricing reads the real test database; the "change a row"
 * tests use a stand-in for the plans table, so no test edits shared reference data.
 */
const db = connectTestDb();
const config = loadConfig(envs.production);
const app = request(createApp({ config, logger: silentLogger, db }));
after(() => db.close());

const withPlans = (rows) =>
  request(
    createApp({
      config,
      logger: silentLogger,
      db: { reference: { plans: { list: async () => rows } } },
    }),
  );

const jsonLdOf = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1]),
  );
const decode = (s) =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

describe('product pages: Measure, Diagnose, Fix, Prove', () => {
  for (const stage of stages) {
    test(`/product/${stage.slug}: one h1, the audit form above the fold, the stages, the FAQ in the HTML`, async () => {
      const { text } = await app.get(`/product/${stage.slug}`).expect(200);
      assert.equal(text.match(/<h1[\s>]/g).length, 1);
      assert.ok(decode(text).includes(stage.h1));
      assert.equal(text.match(/<form method="post" action="\/audit"/g).length, 1, 'one audit form');
      assert.ok(
        text.indexOf('action="/audit"') < text.indexOf('id="section-0"'),
        'the form comes before the first section',
      );
      for (const s of stages) assert.match(text, new RegExp(`href="/product/${s.slug}"`));
      assert.match(text, new RegExp(`href="/product/${stage.slug}" aria-current="page"`));
      for (const item of stage.faq) assert.ok(decode(text).includes(item.q), item.q);
      for (const section of stage.sections) {
        assert.ok(decode(text).includes(section.heading), section.heading);
        for (const [title] of section.items) assert.ok(decode(text).includes(title), title);
      }
    });

    test(`/product/${stage.slug}: Service and FAQPage structured data match the visible FAQ`, async () => {
      const { text } = await app.get(`/product/${stage.slug}`).expect(200);
      const blocks = jsonLdOf(text);
      assert.ok(blocks.some((b) => b['@type'] === 'Service'));
      const faq = blocks.find((b) => b['@type'] === 'FAQPage');
      assert.deepEqual(
        faq.mainEntity.map((q) => q.name),
        stage.faq.map((i) => i.q),
      );
    });
  }

  test('the last stage links to pricing and the methodology; earlier ones to the next stage', async () => {
    const prove = (await app.get('/product/prove')).text;
    assert.match(prove, /href="\/pricing"/);
    assert.match(prove, /href="\/methodology"/);
    assert.doesNotMatch(prove, />Next: /);
    const measure = (await app.get('/product/measure')).text;
    assert.match(measure, /Next: Diagnose/);
  });

  test('the copy makes no promise the product cannot keep', async () => {
    const paths = [
      '/product/measure',
      '/product/diagnose',
      '/product/fix',
      '/product/prove',
      '/agencies',
    ];
    for (const path of paths) {
      const text = decode((await app.get(path)).text).toLowerCase();
      for (const bad of ['daily tracking', 'rank #1', 'increase your traffic by', 'guaranteed']) {
        assert.ok(!text.includes(bad), `${path}: "${bad}"`);
      }
    }
  });
});

describe('Autopilot copy (Milestone 15)', () => {
  test('says what it does, prepares and a person approves, and never that it acts by itself', async () => {
    const text = decode((await app.get('/product/fix')).text).toLowerCase();
    assert.match(text, /autopilot/);
    assert.match(text, /it prepares; you approve/);
    assert.match(
      text,
      /nothing is sent to your site and nothing is published until a person approves/,
    );
    for (const bad of [
      'fixes itself',
      'fixes your site automatically',
      'publishes automatically',
      'automatically publish',
      'on autopilot',
      'hands-free',
      'without you',
      'agentic',
    ]) {
      assert.ok(!text.includes(bad), `"${bad}"`);
    }
  });

  test('no other public page promises Autopilot or an agent that acts on its own', async () => {
    for (const path of [
      '/',
      '/product/measure',
      '/product/diagnose',
      '/product/prove',
      '/agencies',
    ]) {
      const text = decode((await app.get(path)).text).toLowerCase();
      assert.ok(!text.includes('agentic'), `${path}: agentic`);
      assert.ok(!text.includes('on autopilot'), `${path}: on autopilot`);
    }
  });
});

describe('free tools copy (Milestone 17)', () => {
  test('every tool page says what it cannot tell you and that nothing is saved, and promises no result', async () => {
    for (const slug of TOOL_SLUGS) {
      const text = decode((await app.get(`/tools/${slug}`).expect(200)).text).toLowerCase();
      assert.ok(
        text.includes('what this tool cannot tell you'),
        `${slug}: what it cannot tell you`,
      );
      assert.ok(text.includes('we do not save what you enter'), `${slug}: nothing is saved`);
      for (const bad of [
        'guarantee',
        'rank #1',
        'boost your ranking',
        'get cited by chatgpt',
        'instantly',
        'agentic',
      ]) {
        assert.ok(!text.includes(bad), `${slug}: "${bad}"`);
      }
    }
  });

  test('the hub points to the free audit as the way to see what the engines say', async () => {
    const text = decode((await app.get('/tools').expect(200)).text);
    assert.match(text, /utm_source=tools&(amp;)?utm_campaign=hub#audit/);
    assert.match(
      text,
      /whether ChatGPT, Perplexity, Gemini and Google AI Overviews actually name your brand/,
    );
  });
});

describe('agency page', () => {
  test('has the audit form first, the sections and the FAQ in the HTML', async () => {
    const { text } = await app.get('/agencies').expect(200);
    assert.equal(text.match(/<h1[\s>]/g).length, 1);
    assert.equal(text.match(/<form method="post" action="\/audit"/g).length, 1);
    assert.ok(decode(text).includes(agency.h1));
    for (const item of agency.faq) assert.ok(decode(text).includes(item.q));
    for (const section of agency.sections) assert.ok(decode(text).includes(section.heading));
  });

  test('does not claim white-label reports that do not exist', async () => {
    const text = decode((await app.get('/agencies')).text);
    assert.match(text, /Is there white-label reporting\?/);
    assert.match(text, /Not yet\./);
  });
});

describe('pricing page', () => {
  const cardsOf = (html) => [
    ...html.matchAll(
      /<li class="card[^"]*" data-plan="([^"]+)">([\s\S]*?)<\/li>\s*(?=<li class="card[^"]*" data-plan=|<\/ul>)/g,
    ),
  ];

  test('every plan on the page equals the plans table: name, price and each limit', async () => {
    const rows = await db.reference.plans.list();
    assert.ok(rows.length >= 3, 'the test database has the seeded plans');
    const html = decode((await app.get('/pricing').expect(200)).text);

    const cards = cardsOf(html);
    assert.equal(cards.length, rows.length, 'one card per public plan');
    for (const row of rows) {
      const card = cards.find((c) => c[1] === row.code)?.[2];
      assert.ok(card, `a card for ${row.code}`);
      assert.ok(card.includes(row.name), row.name);
      assert.match(card, new RegExp(`data-price>\\$${Number(row.price_usd_month)}<`));
      if (row.max_projects != null)
        assert.match(card, new RegExp(`>${row.max_projects} projects?<`));
      if (row.max_prompts != null)
        assert.match(card, new RegExp(`>${row.max_prompts} tracked buyer questions<`));
      if (row.drafts_per_month != null)
        assert.match(card, new RegExp(`>${Number(row.drafts_per_month)} content drafts a month<`));
      assert.match(card, new RegExp(`asked ${row.samples_per_engine} times`));
    }

    // And no dollar figure appears that the table (or the add-on catalog) does not own.
    const allowed = new Set([...rows.map((r) => `$${Number(r.price_usd_month)}`), '$19', '$5']);
    const body = html.replace(/<script[\s\S]*?<\/script>/g, '');
    for (const [price] of body.matchAll(/\$\d+(?:\.\d\d)?/g)) {
      assert.ok(allowed.has(price), `unexpected figure ${price}`);
    }
  });

  test('change a plans row and the page changes (price, a limit, a new plan)', async () => {
    const base = await db.reference.plans.list();
    const changed = base.map((p) =>
      p.code === 'growth' ? { ...p, price_usd_month: '259.00', max_prompts: 175 } : p,
    );
    changed.push({
      ...base[0],
      code: 'scale',
      name: 'Scale',
      price_usd_month: '1299.00',
      sort_order: 40,
    });

    const before = decode((await app.get('/pricing')).text);
    const after_ = decode((await withPlans(changed).get('/pricing').expect(200)).text);
    assert.match(before, /data-price>\$249</);
    assert.doesNotMatch(after_, /data-price>\$249</);
    assert.match(after_, /data-price>\$259</);
    assert.match(after_, />175 tracked buyer questions</);
    assert.match(after_, /data-plan="scale"/);
    assert.match(after_, /data-price>\$1299</);
  });

  test('a NULL limit is left out; it is never shown as unlimited or zero', async () => {
    const rows = (await db.reference.plans.list()).map((p) => ({ ...p, max_prompts: null }));
    const text = decode((await withPlans(rows).get('/pricing').expect(200)).text);
    assert.doesNotMatch(text, /tracked buyer questions<\/span><\/li>/);
    assert.doesNotMatch(text, /unlimited/i);
  });

  test('the trial and refund terms are the billing constants', async () => {
    const text = decode((await app.get('/pricing')).text);
    assert.match(text, new RegExp(`try it free for ${TRIAL_DAYS} days`));
    assert.match(text, new RegExp(`within ${MONEY_BACK_DAYS} days`));
  });

  test('does not promise a feature that is not built (CSV export)', async () => {
    const text = decode((await app.get('/pricing')).text);
    assert.doesNotMatch(text, /csv/i);
  });

  test('Product structured data has one Offer per plan, at the plan’s price', async () => {
    const rows = await db.reference.plans.list();
    const { text } = await app.get('/pricing').expect(200);
    const blocks = jsonLdOf(text);
    const product = blocks.find((b) => b['@type'] === 'Product');
    assert.ok(product);
    assert.deepEqual(
      product.offers.map((o) => [o.name, Number(o.price)]),
      rows.map((r) => [r.name, Number(r.price_usd_month)]),
    );
    assert.ok(product.offers.every((o) => o.priceCurrency === 'USD'));
    const faq = blocks.find((b) => b['@type'] === 'FAQPage');
    assert.ok(faq.mainEntity.length >= 5);
  });

  test('if the plans cannot be read the page still renders: no prices, no Product, a way forward', async () => {
    const broken = request(
      createApp({
        config,
        logger: silentLogger,
        db: {
          reference: {
            plans: {
              list: async () => {
                throw new Error('database is down');
              },
            },
          },
        },
      }),
    );
    const { text } = await broken.get('/pricing').expect(200);
    assert.match(text, /We can.t show the plans right now/);
    assert.match(text, /href="\/#audit"/);
    assert.doesNotMatch(text, /data-price/);
    assert.ok(!jsonLdOf(text).some((b) => b['@type'] === 'Product'));
  });

  test('with no database at all it renders the same safe page', async () => {
    const bare = request(createApp({ config, logger: silentLogger }));
    const { text } = await bare.get('/pricing').expect(200);
    assert.match(text, /We can.t show the plans right now/);
  });
});

describe('pricing page when bKash is the way to pay (ADR-0018)', () => {
  const bkashConfig = loadConfig({
    ...envs.production,
    BKASH_APP_KEY: 'k',
    BKASH_APP_SECRET: 's',
    BKASH_USERNAME: 'u',
    BKASH_PASSWORD: 'p',
    BKASH_BASE_URL: 'https://tokenized.pay.bka.sh/v1.2.0-beta',
  });
  const rows = (priceFor) =>
    [
      { code: 'starter', name: 'Starter', price_usd_month: '79.00', max_projects: 1 },
      { code: 'growth', name: 'Growth', price_usd_month: '249.00', max_projects: 3 },
      { code: 'agency', name: 'Agency', price_usd_month: '599.00', max_projects: 10 },
    ].map((p) => ({
      samples_per_engine: 3,
      features: {},
      price_bdt_month: priceFor[p.code] ?? null,
      ...p,
    }));
  const page = async (priceFor) => {
    const bkashApp = request(
      createApp({
        config: bkashConfig,
        logger: silentLogger,
        db: { reference: { plans: { list: async () => rows(priceFor) } } },
      }),
    );
    return decode((await bkashApp.get('/pricing').expect(200)).text);
  };

  test('shows taka prices, no dollar prices, no add-ons, and nothing about cards or Stripe', async () => {
    const text = await page({ starter: '2500.00', growth: '7500.00' });
    assert.match(text, /data-price>৳2,500</);
    assert.match(text, /data-price>৳7,500</);
    assert.doesNotMatch(text, /data-price>\$/);
    assert.match(text, /Bangladeshi taka/);
    assert.doesNotMatch(text, /Stripe/);
    assert.doesNotMatch(text, /enter a card/);
    assert.doesNotMatch(text, /id="addons-heading"/);
    assert.match(text, /How do I pay with bKash\?/);
  });

  test('a plan with no taka price says it is not open yet, and shows no dollar price in its place', async () => {
    const text = await page({ starter: '2500.00' });
    assert.match(text, /data-price>Not open yet</);
    assert.doesNotMatch(text, /\$249|\$599/);
  });

  test('the Product markup offers only the priced plans, in BDT', async () => {
    const text = await page({ starter: '2500.00', growth: '7500.00' });
    const product = jsonLdOf(text).find((b) => b['@type'] === 'Product');
    assert.deepEqual(
      product.offers.map((o) => [o.name, o.price, o.priceCurrency]),
      [
        ['Starter', '2500', 'BDT'],
        ['Growth', '7500', 'BDT'],
      ],
    );
    assert.deepEqual(validateJsonLd(product).errors, []);
  });
});

describe('structured data on every public page', () => {
  for (const page of publicPages) {
    test(`${page.path}: every JSON-LD block validates, and Organization is present`, async () => {
      const { text } = await app.get(page.path).expect(200);
      const blocks = jsonLdOf(text);
      assert.ok(blocks.some((b) => b['@type'] === 'Organization'));
      for (const block of blocks) {
        const result = validateJsonLd(block);
        assert.deepEqual(result.errors, [], `${page.path} ${block['@type']}`);
      }
    });
  }

  test('FAQ structured data matches the FAQ a visitor can read, on every page that has it', async () => {
    let checked = 0;
    for (const page of publicPages) {
      const { text } = await app.get(page.path);
      const faq = jsonLdOf(text).find((b) => b['@type'] === 'FAQPage');
      if (!faq) continue;
      checked += 1;
      const visible = decode(text);
      for (const q of faq.mainEntity) {
        assert.ok(visible.includes(q.name), `${page.path}: "${q.name}" is not on the page`);
        assert.ok(
          visible.includes(q.acceptedAnswer.text),
          `${page.path}: an answer is not on the page`,
        );
      }
    }
    assert.ok(checked >= 6, 'home, four product pages, agencies and pricing carry one');
  });
});

describe('links and the sitemap', () => {
  const NOT_PUBLIC = [
    '/app',
    '/audit',
    '/r/',
    '/p/',
    '/_styleguide',
    '/invite',
    '/sign-',
    '/webhooks',
    '/unsubscribe',
    '/queues',
    '/staff',
  ];

  test('the sitemap lists every public page and no app, audit or admin address', async () => {
    const { text } = await app.get('/sitemap.xml').expect(200);
    const paths = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    assert.deepEqual(
      paths,
      publicPages.map((p) => p.path),
    );
    for (const path of paths) {
      assert.ok(!NOT_PUBLIC.some((p) => path.startsWith(p)), path);
      await app.get(path).expect(200);
    }
  });

  test('crawling from the sitemap: no broken internal link, and every #anchor exists', async () => {
    const { text: sitemap } = await app.get('/sitemap.xml');
    const queue = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    const pages = new Map(); // path -> html
    const links = []; // { from, href }
    while (queue.length) {
      const path = queue.shift();
      if (pages.has(path)) continue;
      const res = await app.get(path);
      assert.equal(res.status, 200, `${path} should load`);
      pages.set(path, res.text);
      for (const [, href] of res.text.matchAll(/\shref="([^"]+)"/g)) {
        const clean = decode(href);
        if (!clean.startsWith('/') || clean.startsWith('//')) continue;
        links.push({ from: path, href: clean });
      }
    }
    assert.ok(links.length > 60, `crawled ${links.length} internal links`);

    for (const { from, href } of links) {
      const [pathAndQuery, hash] = href.split('#');
      const target = pathAndQuery.split('?')[0] || from;
      if (/^\/(build|vendor|js|fonts|img)\//.test(target) || target === '/favicon.svg') {
        await app.get(pathAndQuery).expect(200);
        continue;
      }
      if (target === '/audit') continue; // a form endpoint: GET sends the visitor back to the form
      const html = pages.get(target) ?? (await app.get(target).expect(200)).text;
      if (hash) {
        assert.match(
          html,
          new RegExp(`\\sid="${hash}"`),
          `${from} links to ${href}, which has no #${hash}`,
        );
      }
    }
  });

  test('no public page links into the signed-in area or the staff console', async () => {
    for (const page of publicPages) {
      const { text } = await app.get(page.path);
      for (const [, href] of text.matchAll(/\shref="([^"]+)"/g)) {
        assert.ok(!/^\/(app|queues|staff)(\/|$)/.test(href), `${page.path} links to ${href}`);
      }
    }
  });

  test('the registry has a unique name for every page (the browser sweeps use it)', () => {
    const names = publicPages.map((p) => p.name ?? p.view);
    assert.equal(new Set(names).size, names.length);
  });
});

describe('crawler policy by environment', () => {
  test('production allows the AI crawlers; staging blocks everything and has no sitemap', async () => {
    const prod = (await app.get('/robots.txt').expect(200)).text;
    const bots = [
      'GPTBot',
      'OAI-SearchBot',
      'ChatGPT-User',
      'PerplexityBot',
      'ClaudeBot',
      'Claude-SearchBot',
      'Google-Extended',
      'Googlebot',
    ];
    for (const bot of bots) assert.match(prod, new RegExp(`^User-agent: ${bot}$`, 'm'), bot);
    assert.doesNotMatch(prod, /^Disallow: \/$/m);
    assert.match(prod, new RegExp(`Sitemap: ${BASE}/sitemap.xml`));

    const staging = request(
      createApp({ config: loadConfig(envs.staging), logger: silentLogger, db }),
    );
    assert.equal(
      (await staging.get('/robots.txt').expect(200)).text,
      'User-agent: *\nDisallow: /\n',
    );
    await staging.get('/sitemap.xml').expect(404);
    for (const page of publicPages) {
      const res = await staging.get(page.path).expect(200);
      assert.match(res.headers['x-robots-tag'], /noindex/);
      assert.match(res.text, /<meta name="robots" content="noindex, nofollow"/);
    }
  });
});

describe('campaign tags', () => {
  test('a tag on the way in is carried by the audit form as a hidden field, and nothing else is', async () => {
    const query =
      'utm_source=Newsletter&utm_medium=email&utm_campaign=launch&utm_content=jane@example.com&x=1';
    const { text } = await app.get(`/?${query}`).expect(200);
    assert.match(text, /<input type="hidden" name="utm_source" value="newsletter">/);
    assert.match(text, /<input type="hidden" name="utm_medium" value="email">/);
    assert.match(text, /<input type="hidden" name="utm_campaign" value="launch">/);
    assert.doesNotMatch(text, /jane@example|utm_content/);
  });

  test('the product and agency pages carry them too; a page without tags has none', async () => {
    for (const path of ['/product/measure', '/agencies', '/methodology']) {
      const tagged = (await app.get(`${path}?utm_source=partner`)).text;
      assert.match(tagged, /name="utm_source" value="partner"/, path);
      const plain = (await app.get(path)).text;
      assert.doesNotMatch(plain, /name="utm_/, path);
    }
  });

  test('a value that is not a plain label is dropped', async () => {
    const { text } = await app
      .get(`/?utm_source=${encodeURIComponent('<script>alert(1)</script>')}`)
      .expect(200);
    assert.doesNotMatch(text, /name="utm_source"/);
    assert.doesNotMatch(text, /<script>alert/);
  });
});
