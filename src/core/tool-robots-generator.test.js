import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateRobots, parseRobots } from '../crawler/robots.js';
import { AI_CRAWLERS } from './ai-crawlers.js';
import { normalizeFindings } from './tool-findings.js';
import {
  CRAWLER_GROUPS,
  generateRobots,
  MAX_DISALLOW_PATHS,
  parseDisallowPaths,
  robotsGeneratorFindings,
  SEARCH_ENGINES,
} from './tool-robots-generator.js';

const allow = { answer: 'allow', training: 'allow', other: 'allow' };
const verdict = (text, agent, path = '/') => evaluateRobots(parseRobots(text), agent, path).allowed;

describe('the crawler groups', () => {
  test('every crawler in the list is in exactly one group, or is a search engine we never block', () => {
    const grouped = CRAWLER_GROUPS.flatMap((g) => g.agents);
    for (const c of AI_CRAWLERS) {
      const places =
        grouped.filter((a) => a === c.agent).length + (SEARCH_ENGINES.includes(c.agent) ? 1 : 0);
      assert.equal(places, 1, `${c.agent} must be in exactly one place`);
    }
    assert.equal(new Set(grouped).size, grouped.length);
  });

  test('the answer group is the AI search and user bots, and never a search engine', () => {
    const answer = CRAWLER_GROUPS.find((g) => g.key === 'answer').agents;
    for (const a of ['OAI-SearchBot', 'ChatGPT-User', 'Claude-SearchBot', 'PerplexityBot'])
      assert.ok(answer.includes(a));
    for (const s of SEARCH_ENGINES) assert.ok(!answer.includes(s));
  });
});

describe('the file', () => {
  test('everything allowed is one short group', () => {
    const { text, blocked } = generateRobots(allow);
    assert.match(text, /^# robots\.txt[^\n]*\n# Save it[^\n]*\n\nUser-agent: \*\nAllow: \/\n$/);
    assert.deepEqual(blocked, []);
  });

  test('each blocked group becomes one group of User-agent lines with Disallow: /', () => {
    const { text, blocked } = generateRobots({ ...allow, training: 'block' });
    assert.match(text, /# AI training crawlers: blocked\nUser-agent: GPTBot\n/);
    assert.match(text, /User-agent: CCBot\nDisallow: \/\n/);
    assert.doesNotMatch(text, /AI answer crawlers/);
    assert.ok(blocked.includes('GPTBot') && !blocked.includes('OAI-SearchBot'));
  });

  test('paths go in the group for every crawler, and an allowed crawler has no group of its own to bypass them', () => {
    const { text } = generateRobots({ ...allow, answer: 'block', paths: ['/admin/', '/cart'] });
    assert.match(text, /User-agent: \*\nDisallow: \/admin\/\nDisallow: \/cart\n/);
    assert.doesNotMatch(text, /Allow: \//, 'with paths there is no blanket Allow');
    // Googlebot is allowed and falls under `*`, so it is still kept out of the paths.
    assert.equal(verdict(text, 'Googlebot', '/'), true);
    assert.equal(verdict(text, 'Googlebot', '/admin/users'), false);
    assert.equal(verdict(text, 'GPTBot', '/admin/users'), false);
  });

  test('the sitemap line is last', () => {
    const { text } = generateRobots({ ...allow, sitemap: 'https://acme.test/sitemap.xml' });
    assert.ok(text.trimEnd().endsWith('Sitemap: https://acme.test/sitemap.xml'));
  });

  test('the file parses, and every crawler is decided exactly as chosen: all 16 combinations', () => {
    const choices = ['allow', 'block'];
    let n = 0;
    for (const answer of choices)
      for (const training of choices)
        for (const other of choices)
          for (const paths of [[], ['/private/']]) {
            const { text } = generateRobots({
              answer,
              training,
              other,
              paths,
              sitemap: 'https://acme.test/s.xml',
            });
            const parsed = parseRobots(text);
            assert.deepEqual(parsed.sitemaps, ['https://acme.test/s.xml']);
            for (const g of CRAWLER_GROUPS)
              for (const agent of g.agents) {
                assert.equal(
                  verdict(text, agent, '/'),
                  { answer, training, other }[g.key] === 'allow',
                  `${agent} ${answer}/${training}/${other}`,
                );
                n += 1;
              }
            // The search engines are allowed whatever was chosen.
            for (const s of SEARCH_ENGINES) assert.equal(verdict(text, s, '/'), true, s);
            // An unlisted crawler follows `*`.
            assert.equal(verdict(text, 'SomeOtherBot', '/'), true);
            assert.equal(verdict(text, 'SomeOtherBot', '/private/x'), paths.length === 0);
          }
    assert.ok(n > 100);
  });
});

describe('the paths', () => {
  test('one per line, blanks skipped, duplicates dropped', () => {
    assert.deepEqual(parseDisallowPaths('/admin/\n\n  /cart  \n/admin/\r\n/search*'), {
      paths: ['/admin/', '/cart', '/search*'],
    });
    assert.deepEqual(parseDisallowPaths(''), { paths: [] });
    assert.deepEqual(parseDisallowPaths(undefined), { paths: [] });
  });

  test('a path of just / is refused with a reason, because it would block search engines too', () => {
    assert.match(parseDisallowPaths('/admin/\n/').error, /Line 2: a path of just \//);
  });

  test('a path must start with / and have no spaces, # or over-long text, and the line is named', () => {
    for (const bad of ['admin', '/a b', '/a#b', `/${'x'.repeat(200)}`, 'https://acme.test/x'])
      assert.match(
        parseDisallowPaths(`/ok\n${bad}`).error,
        /^Line 2: start each path with \//,
        bad.slice(0, 20),
      );
  });

  test('more than 30 paths is refused', () => {
    const many = Array.from({ length: MAX_DISALLOW_PATHS + 1 }, (_, i) => `/p${i}`).join('\n');
    assert.match(parseDisallowPaths(many).error, /at most 30 paths/);
  });
});

describe('the findings', () => {
  const build = (choices, extra = {}) => {
    const made = generateRobots({ ...choices, ...extra });
    return normalizeFindings(
      robotsGeneratorFindings({
        choices,
        paths: extra.paths ?? [],
        sitemap: extra.sitemap ?? null,
        ...made,
      }),
    );
  };
  const row = (f, label) => f.sections[0].rows.find((r) => r.label === label);

  test('blocking answer crawlers is a warning that says why, blocking training is a neutral choice', () => {
    const f = build({ ...allow, answer: 'block', training: 'block' });
    assert.equal(row(f, 'AI answer crawlers').state, 'warn');
    assert.match(row(f, 'AI answer crawlers').detail, /keep your pages out of those answers/);
    assert.equal(row(f, 'AI training crawlers').state, 'neutral');
    assert.equal(row(f, 'Other AI crawlers').state, 'good');
  });

  test('search engines are always allowed, and the file is the output', () => {
    const f = build({ answer: 'block', training: 'block', other: 'block' });
    assert.equal(row(f, 'Search engines').state, 'good');
    assert.match(row(f, 'Search engines').detail, /never blocks them/);
    assert.equal(f.output.filename, 'robots.txt');
    assert.match(f.output.text, /User-agent: \*\nAllow: \//);
    for (const s of ['Googlebot', 'Bingbot', 'Applebot']) {
      assert.doesNotMatch(f.output.text, new RegExp(`User-agent: ${s}(?![\\w-])`));
    }
  });

  test('the headline says what the file does, and the notes say it replaces the whole file and is not a lock', () => {
    assert.match(build(allow).headline, /allows every crawler$/);
    assert.match(
      build({ ...allow, other: 'block' }).headline,
      /blocks 4 AI crawlers and allows everything else/,
    );
    assert.match(
      build(allow, { paths: ['/a'] }).headline,
      /keeps them out of the paths you listed/,
    );
    const notes = build(allow).notes.join(' ');
    assert.match(notes, /replaces your whole file/);
    assert.match(notes, /not a lock/);
  });
});
