import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createRenderer } from '../../src/crawler/render.js';
import { runSiteScan } from '../../src/crawler/scan.js';
import { connectTestDb } from '../../src/db/testing.js';
import { loadConfig } from '../../src/lib/config.js';
import { createApp } from '../../src/web/app.js';
import { publicPages } from '../../src/web/pages.js';
import { envs, silentLogger } from '../routes/helpers.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';
import { startS3Stub } from '../helpers/s3-stub.js';
import { createSpacesStore } from '../../src/integrations/spaces.js';

/**
 * We eat our own cooking (Milestone 9, task 9.11): our readiness checks, run against our own public site served with
 * the PRODUCTION configuration (staging's deliberate noindex would trip the indexability check). The site is the real
 * app on a local socket under TLS, with the real plans table behind the pricing page; the crawler is the real one,
 * with the headless browser, reading it as AEOCornerBot would.
 *
 * "Critical" is a check whose failure keeps an AI engine from finding, reading or trusting the site at all: crawler
 * access (A1, A3), a sitemap (A4), main content in the raw HTML (B1), organization markup (C1), valid markup (C3),
 * indexability (F1), HTTPS (F2) and titles (F3). The rest are listed in the failure message, not required: some of
 * them are the founder's to fill: an About page (D2) and profile links for sameAs (C1, D3) need real facts about the company.
 */
const CRITICAL = ['A1', 'A3', 'A4', 'B1', 'C1', 'C3', 'F1', 'F2', 'F3'];

let db;
let server;
let stub;
let store;
let renderer;
let result;

before(async () => {
  db = connectTestDb();
  stub = await startS3Stub();
  store = createSpacesStore({
    endpoint: stub.endpoint,
    region: stub.region,
    bucket: stub.bucket,
    accessKeyId: stub.accessKeyId,
    secretAccessKey: stub.secretAccessKey,
    prefix: 'dogfood/',
  });

  const holder = { app: null };
  server = await startServer((req, res) => holder.app(req, res), { secure: true });
  const origin = server.origin('aeocorner.fixture.test'); // the test certificate covers *.fixture.test
  const config = loadConfig({ ...envs.production, APP_BASE_URL: origin });
  holder.app = createApp({ config, logger: silentLogger, db });

  const fetcher = testFetcher({ ports: [server.port] });
  renderer = createRenderer({ fetcher });
  result = await runSiteScan(origin, { fetcher, renderer, store });
});

after(async () => {
  await renderer?.close();
  await server?.close();
  await stub?.close();
  await db?.close();
});

const check = (code) => result.checks.find((c) => c.code === code);

describe('our own site, production configuration, read by our own crawler', () => {
  test('the scan reads the site completely', () => {
    if (process.env.DOGFOOD_DUMP)
      console.log(
        JSON.stringify(
          {
            status: result.status,
            score: result.readinessScore,
            coverage: result.coverage,
            notes: result.notes,
            checks: result.checks.map((c) => ({
              code: c.code,
              status: c.status,
              points: c.points,
              max: c.maxPoints,
              detail: c.detail ?? c.summary,
            })),
          },
          null,
          1,
        ),
      );
    assert.equal(result.status, 'complete', JSON.stringify(result.notes));
    assert.ok(result.readinessScore !== null, 'a score, not "couldn’t check"');
    assert.ok(result.coverage >= 0.9, `rubric coverage ${result.coverage}`);
  });

  test('no critical check fails', () => {
    const report = result.checks
      .filter((c) => c.status !== 'pass')
      .map(
        (c) =>
          `${c.code} ${c.status}: ${JSON.stringify(c.detail ?? c.summary ?? c.evidence ?? '')}`,
      )
      .join('\n');
    for (const code of CRITICAL) {
      const c = check(code);
      assert.ok(c, `check ${code} ran`);
      assert.notEqual(
        c.status,
        'fail',
        `${code} (${c.title ?? ''}) failed.\nEvery check that is not a pass:\n${report}`,
      );
    }
  });

  test('every AI crawler is allowed in robots.txt, and the sitemap is found', () => {
    assert.equal(check('A1').status, 'pass');
    assert.equal(check('A4').status, 'pass');
    assert.ok(
      result.sitemaps.urlCount >= publicPages.length,
      `sitemap lists ${result.sitemaps.urlCount} URLs`,
    );
  });

  test('the main content is in the raw HTML, with valid structured data', () => {
    assert.equal(check('B1').status, 'pass');
    // C1 is partial, not pass, until the founder gives us profile URLs for Organization.sameAs (task 9.11 note).
    assert.notEqual(check('C1').status, 'fail');
    assert.equal(check('C3').status, 'pass');
    assert.equal(check('C4').status, 'pass', 'breadcrumbs on the inner pages');
  });

  test('answer-shaped content: question headings with the answer right under them', () => {
    assert.equal(check('E1').status, 'pass');
    assert.equal(check('E2').status, 'pass', check('E2').detail);
    assert.equal(check('E4').status, 'pass');
  });

  test('the score does not slip: 85 or more (it was 90 on 2026-10-04)', () => {
    assert.ok(result.readinessScore >= 85, `readiness ${result.readinessScore}`);
  });

  test('the key pages are indexable', () => {
    assert.equal(check('F1').status, 'pass');
  });
});
