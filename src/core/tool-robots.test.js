import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseRobots } from '../crawler/robots.js';
import { AI_CRAWLERS } from './ai-crawlers.js';
import { normalizeFindings } from './tool-findings.js';
import { disallowedPatterns, judgeCrawler, robotsFindings } from './tool-robots.js';

const ok = (text) => ({ status: 'ok', parsed: parseRobots(text), httpStatus: 200 });
const rows = (f) => f.sections.flatMap((s) => s.rows);
const row = (f, agent) => rows(f).find((r) => r.label === agent);

describe('judging one crawler', () => {
  test('the group that names a crawler wins over the rules for every crawler', () => {
    const parsed = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n');
    assert.equal(judgeCrawler(parsed, 'GPTBot').verdict, 'allowed');
    assert.equal(judgeCrawler(parsed, 'ClaudeBot').verdict, 'blocked');
    assert.equal(judgeCrawler(parsed, 'ClaudeBot').group, '*');
  });

  test('a Disallow for part of the site is "allowed, with some pages off limits", not a block', () => {
    const parsed = parseRobots('User-agent: *\nDisallow: /private\nDisallow: /admin/\nDisallow:\n');
    const r = judgeCrawler(parsed, 'PerplexityBot');
    assert.equal(r.verdict, 'allowed');
    assert.deepEqual(r.partial, ['/private', '/admin/']);
    assert.deepEqual(disallowedPatterns(parsed, 'PerplexityBot'), ['/private', '/admin/']);
  });

  test('no file: allowed, no group', () => {
    assert.deepEqual(judgeCrawler(null, 'GPTBot'), {
      verdict: 'allowed',
      rule: null,
      group: null,
      partial: [],
    });
  });
});

describe('the findings', () => {
  test('a file that blocks one answer crawler says which, and quotes the rule', () => {
    const f = robotsFindings(ok('User-agent: OAI-SearchBot\nDisallow: /\n'));
    assert.match(f.headline, /blocks 1 of \d+ answer and search crawlers: OAI-SearchBot/);
    assert.equal(row(f, 'OAI-SearchBot').state, 'bad');
    assert.equal(row(f, 'OAI-SearchBot').value, 'Blocked');
    assert.match(row(f, 'OAI-SearchBot').detail, /Disallow: \//);
    assert.equal(row(f, 'PerplexityBot').state, 'good');
    assert.match(f.lines.items[0], /User-agent: OAI-SearchBot.*Disallow: \//);
  });

  test('blocking everything blocks every answer crawler, and a blocked training crawler is not a fault', () => {
    const f = robotsFindings(ok('User-agent: *\nDisallow: /\n'));
    const answer = AI_CRAWLERS.filter((c) => c.guidance === 'allow');
    assert.match(f.headline, new RegExp(`all ${answer.length} answer and search crawlers`));
    for (const c of answer) assert.equal(row(f, c.agent).state, 'bad');
    for (const c of AI_CRAWLERS.filter((c) => c.guidance === 'business_choice'))
      assert.equal(row(f, c.agent).state, 'neutral', c.agent);
    assert.equal(f.lines.items.length, 1, 'one deciding rule, however many crawlers it blocks');
  });

  test('a clean file allows all, and a partial block warns', () => {
    const clean = robotsFindings(ok('User-agent: *\nAllow: /\nSitemap: https://acme.test/s.xml\n'));
    assert.match(clean.headline, /^All \d+ answer and search crawlers are allowed$/);
    assert.equal(clean.lines, undefined);
    assert.equal(rows(clean).find((r) => r.label === 'Sitemap lines').value, '1');
    const partial = robotsFindings(ok('User-agent: *\nDisallow: /members/\n'));
    assert.equal(row(partial, 'GPTBot').state, 'neutral');
    assert.equal(row(partial, 'Googlebot').state, 'warn');
    assert.match(row(partial, 'Googlebot').detail, /\/members\//);
    assert.match(partial.notes[0], /only part of your site/);
  });

  test('no robots.txt is a neutral finding, not an error, and everyone is allowed', () => {
    const f = robotsFindings({ status: 'missing', parsed: null, httpStatus: 404 });
    assert.match(f.headline, /no robots\.txt, so every AI crawler is allowed/);
    assert.equal(row(f, 'robots.txt').state, 'neutral');
    assert.match(row(f, 'robots.txt').detail, /not doing anything wrong/);
    assert.ok(AI_CRAWLERS.every((c) => row(f, c.agent).value === 'Allowed'));
  });

  test('every crawler in the list is in the findings exactly once', () => {
    const f = robotsFindings(ok('User-agent: *\nAllow: /\n'));
    for (const c of AI_CRAWLERS) assert.equal(rows(f).filter((r) => r.label === c.agent).length, 1);
  });

  test('the findings pass the gate, and always say what robots.txt cannot do', () => {
    const f = normalizeFindings(robotsFindings(ok('User-agent: *\nDisallow: /\n')));
    assert.ok(f.notes.some((n) => /not a lock/.test(n)));
    assert.ok(f.notes.some((n) => /firewall/.test(n)));
  });

  test('a hostile file cannot widen the findings: huge rules and a million lines stay inside the caps', () => {
    // The blocking group comes first: a robots.txt is read only up to 500 KB, so a block after that is never seen.
    const lines = [
      'User-agent: GPTBot',
      `Disallow: /<script>alert(1)</script>${'b'.repeat(5000)}`,
      'Disallow: /',
      'User-agent: *',
    ];
    for (let i = 0; i < 200_000; i += 1) lines.push(`Disallow: /${'a'.repeat(400)}${i}`);
    const started = Date.now();
    const f = normalizeFindings(robotsFindings(ok(lines.join('\n'))));
    assert.ok(Date.now() - started < 20_000, 'linear in the size of the file (a loose bound)');
    assert.ok(JSON.stringify(f).length < 100_000);
    assert.ok(f.lines.items.every((l) => l.length <= 300));
  });
});
