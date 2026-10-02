import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateRobots, namesAgent, parseRobots, ROBOTS_MAX_BYTES } from './robots.js';

const check = (robots, agent, path = '/') => evaluateRobots(parseRobots(robots), agent, path);
const allowed = (robots, agent, path) => check(robots, agent, path).allowed;

describe('which group applies', () => {
  const file = `
    User-agent: *
    Disallow: /private/

    User-agent: GPTBot
    Disallow: /

    User-agent: OAI-SearchBot
    User-agent: PerplexityBot
    Allow: /
  `;

  test('the group that names the crawler wins over the * group', () => {
    assert.equal(allowed(file, 'GPTBot', '/anything'), false);
    assert.equal(
      allowed(file, 'OAI-SearchBot', '/private/x'),
      true,
      '* rules do not apply once a group names us',
    );
  });

  test('two User-agent lines in a row share the rules that follow them', () => {
    assert.equal(allowed(file, 'PerplexityBot', '/private/x'), true);
    assert.equal(check(file, 'PerplexityBot').matchedAgent, 'perplexitybot');
  });

  test('a crawler no group names falls back to *', () => {
    const r = check(file, 'Bingbot', '/private/page');
    assert.equal(r.allowed, false);
    assert.equal(r.matchedAgent, '*');
    assert.equal(r.rule, 'Disallow: /private/');
    assert.equal(allowed(file, 'Bingbot', '/public'), true);
  });

  test('agent names are not case sensitive, and a version suffix is ignored', () => {
    assert.equal(allowed('User-agent: gptbot\nDisallow: /', 'GPTBot'), false);
    assert.equal(allowed('User-agent: GPTBot/1.2\nDisallow: /', 'gptbot'), false);
    assert.equal(allowed('USER-AGENT: GPTBot\nDISALLOW: /', 'GPTBot'), false);
  });

  test('a file with no group for us and no * group allows everything', () => {
    const r = check('User-agent: SomeoneElse\nDisallow: /', 'GPTBot');
    assert.equal(r.allowed, true);
    assert.equal(r.matchedAgent, null);
  });

  test('groups that repeat the same agent are combined', () => {
    const file2 = 'User-agent: GPTBot\nDisallow: /a/\n\nUser-agent: GPTBot\nDisallow: /b/';
    assert.equal(allowed(file2, 'GPTBot', '/a/x'), false);
    assert.equal(allowed(file2, 'GPTBot', '/b/x'), false);
    assert.equal(allowed(file2, 'GPTBot', '/c/x'), true);
  });

  test('rules that come before any User-agent line apply to nobody', () => {
    assert.equal(allowed('Disallow: /\nUser-agent: GPTBot\nAllow: /', 'GPTBot'), true);
    assert.equal(allowed('Disallow: /', 'GPTBot'), true);
  });
});

describe('which rule wins', () => {
  test('the longest matching pattern wins, not the first', () => {
    const file = 'User-agent: *\nDisallow: /docs/\nAllow: /docs/public/';
    assert.equal(allowed(file, 'X', '/docs/secret'), false);
    assert.equal(allowed(file, 'X', '/docs/public/guide'), true);
    // The same rules in the other order give the same answer.
    const swapped = 'User-agent: *\nAllow: /docs/public/\nDisallow: /docs/';
    assert.equal(allowed(swapped, 'X', '/docs/public/guide'), true);
  });

  test('when an Allow and a Disallow match equally, Allow wins', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /page\nAllow: /page', 'X', '/page'), true);
  });

  test('an empty Disallow allows everything', () => {
    assert.equal(allowed('User-agent: *\nDisallow:', 'X', '/anything'), true);
  });

  test('Disallow: / blocks everything, and Allow: / opens it again for a more specific group', () => {
    assert.equal(allowed('User-agent: *\nDisallow: /', 'X', '/'), false);
    assert.equal(
      allowed('User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /', 'Googlebot', '/'),
      true,
    );
  });

  test('the matching rule is reported so a report can quote it', () => {
    assert.equal(
      check('User-agent: *\nDisallow: /admin', 'X', '/admin/users').rule,
      'Disallow: /admin',
    );
  });
});

describe('patterns', () => {
  test('* matches any run of characters', () => {
    const file = 'User-agent: *\nDisallow: /*.pdf\nDisallow: /search*?q=';
    assert.equal(allowed(file, 'X', '/files/report.pdf'), false);
    assert.equal(allowed(file, 'X', '/files/report.pdf?download=1'), false);
    assert.equal(allowed(file, 'X', '/search/results?q=shoes'), false);
    assert.equal(allowed(file, 'X', '/files/report.html'), true);
  });

  test('$ anchors the end of the path', () => {
    const file = 'User-agent: *\nDisallow: /*.php$';
    assert.equal(allowed(file, 'X', '/index.php'), false);
    assert.equal(allowed(file, 'X', '/index.php?x=1'), true);
    assert.equal(allowed(file, 'X', '/index.phps'), true);
  });

  test('patterns match from the start of the path, case sensitively', () => {
    const file = 'User-agent: *\nDisallow: /Private';
    assert.equal(allowed(file, 'X', '/Private/a'), false);
    assert.equal(allowed(file, 'X', '/private/a'), true);
    assert.equal(allowed(file, 'X', '/x/Private'), true);
  });

  test('regular-expression characters in a pattern mean themselves', () => {
    const file = 'User-agent: *\nDisallow: /a.b(c)+[d]';
    assert.equal(allowed(file, 'X', '/a.b(c)+[d]'), false);
    assert.equal(allowed(file, 'X', '/aXb(c)+[d]'), true);
  });

  test('a pattern that does not start at the root is ignored', () => {
    assert.equal(allowed('User-agent: *\nDisallow: private', 'X', '/private'), true);
  });
});

describe('reading the file', () => {
  test('comments, blank lines, odd spacing, a BOM and mixed line endings', () => {
    const file =
      '\uFEFF# our rules\r\nUser-agent : GPTBot   # the trainer\r\n\r\nDisallow :  /no   \rAllow: /yes\n';
    assert.equal(allowed(file, 'GPTBot', '/no'), false);
    assert.equal(allowed(file, 'GPTBot', '/yes'), true);
  });

  test('sitemap lines are collected wherever they are, and only real URLs', () => {
    const parsed = parseRobots(
      'Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow:\nsitemap: http://example.com/news.xml\nSitemap: /relative.xml\nSitemap: ftp://x/y',
    );
    assert.deepEqual(parsed.sitemaps, [
      'https://example.com/sitemap.xml',
      'http://example.com/news.xml',
    ]);
  });

  test('a sitemap line does not end the User-agent group above it', () => {
    const file = 'User-agent: GPTBot\nSitemap: https://example.com/s.xml\nDisallow: /';
    assert.equal(allowed(file, 'GPTBot'), false);
  });

  test('crawl-delay is read', () => {
    assert.equal(parseRobots('User-agent: *\nCrawl-delay: 10').groups[0].crawlDelay, 10);
  });

  test('unknown lines and garbage are ignored', () => {
    const file =
      'Host: example.com\nclean-param: ref\nthis line is nonsense\nUser-agent: *\nDisallow: /x';
    assert.equal(allowed(file, 'Y', '/x'), false);
    assert.equal(allowed('', 'Y', '/x'), true);
    assert.equal(allowed('<html><body>Not found</body></html>', 'Y', '/x'), true);
  });

  test('only the first 500 KiB are read', () => {
    const filler = '# padding\n'.repeat(Math.ceil(ROBOTS_MAX_BYTES / 10) + 10);
    const file = `User-agent: *\nDisallow: /early\n${filler}Disallow: /late\n`;
    assert.equal(allowed(file, 'X', '/early'), false);
    assert.equal(allowed(file, 'X', '/late'), true, 'a rule past the limit is not read');
  });

  test('a huge number of rules still evaluates quickly', () => {
    const rules = Array.from({ length: 20000 }, (_, i) => `Disallow: /section-${i}/*/x`).join('\n');
    const parsed = parseRobots(`User-agent: *\n${rules}`);
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) evaluateRobots(parsed, 'X', `/other/${i}`);
    assert.ok(Date.now() - started < 10_000);
  });
});

describe('whether the site named a crawler on purpose', () => {
  test('names, not the * fallback', () => {
    const parsed = parseRobots('User-agent: *\nDisallow:\n\nUser-agent: CCBot\nDisallow: /');
    assert.equal(namesAgent(parsed, 'CCBot'), true);
    assert.equal(namesAgent(parsed, 'GPTBot'), false);
  });
});
