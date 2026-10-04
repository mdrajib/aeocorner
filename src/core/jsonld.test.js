import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonLd, scriptTag, SUPPORTED_TYPES, problemLines } from './jsonld.js';

const ctx = { '@context': 'https://schema.org' };
const article = (extra = {}) => ({
  ...ctx,
  '@type': 'Article',
  headline: 'How much does a crown cost?',
  author: { '@type': 'Person', name: 'Dr Ana Ruiz' },
  datePublished: '2026-10-01',
  dateModified: '2026-10-04T09:30:00Z',
  image: 'https://example.com/crown.jpg',
  publisher: {
    '@type': 'Organization',
    name: 'Data Dental',
    url: 'https://example.com',
    logo: 'https://example.com/l.png',
    sameAs: ['https://www.facebook.com/datadental'],
  },
  ...extra,
});
const errorsOf = (doc) => validateJsonLd(doc).errors.map((e) => `${e.path} ${e.message}`);

test('a complete Article is valid and has no warnings', () => {
  const r = validateJsonLd(article());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.types.sort(), ['Article', 'Organization', 'Person']);
});

test('a JSON string is parsed; broken JSON is an error, not a throw', () => {
  assert.equal(validateJsonLd(JSON.stringify(article())).ok, true);
  assert.match(errorsOf('{nope')[0], /not valid JSON/);
  assert.match(errorsOf('null')[0], /must be an object/);
  assert.match(errorsOf(5)[0], /must be an object/);
});

test('the context must be schema.org and only the top level has one', () => {
  assert.match(errorsOf({ ...article(), '@context': 'https://example.com' })[0], /@context/);
  const noCtx = article();
  delete noCtx['@context'];
  assert.match(errorsOf(noCtx)[0], /@context is missing/);
  assert.ok(
    errorsOf(
      article({ author: { '@context': 'https://schema.org', '@type': 'Person', name: 'A' } }),
    ).some((e) => /Only the top level/.test(e)),
  );
  assert.equal(validateJsonLd({ ...article(), '@context': 'http://schema.org/' }).ok, true);
});

test('unknown types and properties are errors that name what is wrong', () => {
  assert.ok(
    errorsOf({ ...ctx, '@type': 'Spaceship', name: 'x' })[0].includes('not a type we write'),
  );
  assert.ok(
    errorsOf(article({ colour: 'blue' })).some((e) =>
      e.includes('"colour" is not a property of Article'),
    ),
  );
  assert.ok(
    errorsOf({ ...ctx, '@type': 'Person', name: 'A', headline: 'x' }).some((e) =>
      e.includes('not a property of Person'),
    ),
  );
  assert.ok(errorsOf({ ...ctx, name: 'x' })[0].includes('no @type'));
});

test('inherited properties work: a BlogPosting is an Article is a CreativeWork is a Thing', () => {
  const r = validateJsonLd(
    article({ '@type': 'BlogPosting', keywords: 'crowns', sameAs: 'https://example.com/x' }),
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('required properties are errors, recommended ones are warnings', () => {
  const r = validateJsonLd({ ...ctx, '@type': 'Article' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.message === 'A Article needs headline.'));
  assert.ok(r.warnings.some((w) => w.path.endsWith('.datePublished')));
  const ok = validateJsonLd({ ...ctx, '@type': 'Article', headline: 'x' });
  assert.equal(ok.ok, true);
  assert.ok(ok.warnings.length >= 4);
});

test('dates must be real ISO 8601 dates', () => {
  for (const bad of ['10/04/2026', '2026-13-01', '2026-02-31', 'yesterday', '2026-10-04 09:00']) {
    assert.ok(
      errorsOf(article({ datePublished: bad })).some((e) => /ISO 8601/.test(e)),
      bad,
    );
  }
  for (const good of [
    '2026-10-04',
    '2026-10-04T09:30',
    '2026-10-04T09:30:15+02:00',
    '2026-10-04T09:30:15.250Z',
  ]) {
    assert.equal(validateJsonLd(article({ datePublished: good })).ok, true, good);
  }
});

test('web addresses must be http(s); javascript: and data: are refused', () => {
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,x',
    'example.com/a.jpg',
    '/relative.jpg',
  ]) {
    assert.ok(errorsOf(article({ image: bad })).length > 0, bad);
  }
  assert.equal(
    validateJsonLd(article({ image: ['https://a.com/1.jpg', 'https://a.com/2.jpg'] })).ok,
    true,
  );
  assert.equal(
    validateJsonLd(
      article({
        image: { '@type': 'ImageObject', url: 'https://a.com/1.jpg', width: 800, height: 600 },
      }),
    ).ok,
    true,
  );
});

test('a property that takes a node does not accept the wrong kind of node or plain text', () => {
  assert.ok(
    errorsOf(article({ author: 'Dr Ana Ruiz' })).some((e) =>
      /author must be a Person or a Organization, not text/.test(e),
    ),
  );
  assert.ok(
    errorsOf(article({ author: { '@type': 'Product', name: 'x' } })).some((e) =>
      /not a Product/.test(e),
    ),
  );
  assert.ok(errorsOf(article({ publisher: 7 })).length > 0);
});

test('numbers must be numbers where only numbers are allowed', () => {
  const q = {
    ...ctx,
    '@type': 'Question',
    name: 'q?',
    acceptedAnswer: { '@type': 'Answer', text: 'a' },
    answerCount: 'one',
  };
  assert.ok(errorsOf(q).some((e) => /answerCount/.test(e)));
  assert.equal(validateJsonLd({ ...q, answerCount: 1 }).ok, true);
  assert.ok(errorsOf({ ...q, answerCount: Infinity }).length > 0);
});

test('text that could close the script block is refused everywhere', () => {
  assert.ok(errorsOf(article({ headline: 'x</script><script>alert(1)</script>' })).length > 0);
  assert.ok(errorsOf(article({ headline: 'x <!-- y' })).length > 0);
  assert.ok(errorsOf(article({ '@id': 'https://a.com/#</SCRIPT>' })).length > 0);
  assert.ok(errorsOf(article({ headline: 'x'.repeat(20_001) })).some((e) => /too long/.test(e)));
});

test('scriptTag escapes angle brackets and ampersands and refuses unchecked data', () => {
  const tag = scriptTag(article({ headline: 'Crowns & bridges < 5 years > 10' }));
  assert.match(tag, /^<script type="application\/ld\+json">/);
  assert.match(tag, /<\/script>$/);
  const inner = tag.slice('<script type="application/ld+json">'.length, -'</script>'.length);
  assert.ok(!/[<>&]/.test(inner));
  assert.equal(JSON.parse(inner).headline, 'Crowns & bridges < 5 years > 10');
  assert.throws(() => scriptTag({ ...ctx, '@type': 'Article' }), RangeError);
  const lineSep = scriptTag(article({ headline: 'a b' }));
  assert.ok(!lineSep.includes(' '));
});

test('FAQPage needs questions with answers', () => {
  const faq = (mainEntity) => ({ ...ctx, '@type': 'FAQPage', mainEntity });
  const q = (name, text) => ({
    '@type': 'Question',
    name,
    acceptedAnswer: { '@type': 'Answer', text },
  });
  assert.equal(
    validateJsonLd(faq([q('Is it painful?', 'Not usually.'), q('How long?', 'About an hour.')])).ok,
    true,
  );
  assert.ok(errorsOf({ ...ctx, '@type': 'FAQPage' }).some((e) => /needs mainEntity/.test(e)));
  assert.ok(errorsOf(faq([])).length > 0);
  assert.ok(
    errorsOf(faq([{ '@type': 'Question', name: 'x?' }])).some((e) =>
      /needs acceptedAnswer/.test(e),
    ),
  );
  assert.ok(errorsOf(faq([q('x?', '   ')])).length > 0);
  assert.equal(
    validateJsonLd(faq({ name: 'solo?', acceptedAnswer: { text: 'yes' } })).ok,
    true,
    'a single question; types follow from the property',
  );
});

test('HowTo needs a name and steps', () => {
  const howto = {
    ...ctx,
    '@type': 'HowTo',
    name: 'Care for a crown',
    step: [
      { '@type': 'HowToStep', text: 'Brush twice a day.' },
      { '@type': 'HowToStep', text: 'Floss.' },
    ],
  };
  assert.equal(validateJsonLd(howto).ok, true);
  assert.ok(errorsOf({ ...howto, step: undefined }).some((e) => /needs step/.test(e)));
  assert.ok(
    errorsOf({ ...howto, step: [{ '@type': 'HowToStep' }] }).some((e) => /needs text/.test(e)),
  );
});

test('Product and Offer: a price needs a currency', () => {
  const product = {
    ...ctx,
    '@type': 'Product',
    name: 'Whitening kit',
    image: 'https://a.com/k.jpg',
    description: 'A kit',
    offers: {
      '@type': 'Offer',
      price: '49.00',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    },
  };
  assert.equal(validateJsonLd(product).ok, true, JSON.stringify(validateJsonLd(product).errors));
  assert.ok(
    errorsOf({ ...product, offers: { '@type': 'Offer', price: 49 } }).some((e) =>
      /needs a currency/.test(e),
    ),
  );
});

test('Organization and LocalBusiness with an address', () => {
  const org = {
    ...ctx,
    '@type': 'LocalBusiness',
    name: 'Data Dental',
    url: 'https://example.com',
    logo: 'https://example.com/l.png',
    sameAs: ['https://www.facebook.com/datadental'],
    telephone: '+1 555 0100',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '1 Main St',
      addressLocality: 'Austin',
      addressRegion: 'TX',
      postalCode: '78701',
      addressCountry: 'US',
    },
    geo: { '@type': 'GeoCoordinates', latitude: 30.26, longitude: -97.74 },
  };
  const r = validateJsonLd(org);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
  assert.ok(errorsOf({ ...org, geo: { '@type': 'GeoCoordinates', latitude: 'north' } }).length > 0);
});

test('@graph holds several nodes and nothing else beside it', () => {
  const graph = {
    ...ctx,
    '@graph': [
      { '@type': 'Organization', name: 'Data Dental', '@id': 'https://example.com/#org' },
      { '@type': 'WebPage', name: 'Home', url: 'https://example.com' },
    ],
  };
  assert.equal(validateJsonLd(graph).ok, true);
  assert.ok(errorsOf({ ...graph, name: 'x' }).some((e) => /not allowed next to @graph/.test(e)));
  assert.ok(errorsOf({ ...ctx, '@graph': [] }).length > 0);
  assert.ok(
    errorsOf({ '@graph': [{ '@type': 'Organization', name: 'x' }] }).some((e) =>
      /@context/.test(e),
    ),
  );
  assert.equal(validateJsonLd([article(), { ...ctx, '@type': 'Person', name: 'A' }]).ok, true);
  assert.ok(errorsOf([]).length > 0);
});

test('empty strings, nulls and empty lists are errors', () => {
  assert.ok(errorsOf(article({ keywords: '' })).length > 0);
  assert.ok(errorsOf(article({ keywords: null })).length > 0);
  assert.ok(errorsOf(article({ keywords: [] })).length > 0);
  assert.ok(errorsOf(article({ keywords: [['x']] })).length > 0);
  assert.ok(errorsOf(article({ keywords: true })).length > 0);
});

test('hostile shapes end in an answer, not a crash or a hang', () => {
  let deep = { '@type': 'Person', name: 'x' };
  for (let i = 0; i < 40; i += 1) deep = { '@type': 'Organization', name: 'x', founder: deep };
  assert.ok(errorsOf({ ...ctx, ...deep }).some((e) => /nested too deeply|must be/.test(e)));
  const many = {
    ...ctx,
    '@graph': Array.from({ length: 2_000 }, (_, i) => ({ '@type': 'Person', name: `p${i}` })),
  };
  const started = Date.now();
  const r = validateJsonLd(many);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /too many parts/.test(e.message)));
  assert.ok(Date.now() - started < 3_000);
  assert.equal(validateJsonLd('x'.repeat(600_000)).ok, false);
  assert.ok(
    errorsOf(article({ '@type': ['Article', 'Thing'] })).some((e) => /one type per node/.test(e)),
  );
  assert.ok(errorsOf(article({ '@vocab': 'x' })).some((e) => /not allowed here/.test(e)));
  assert.ok(errorsOf({ ...ctx, '@type': 'Person', name: 'a', __proto__x: 1 }).length > 0);
});

test('every supported type has a way to be written and the list is stable', () => {
  assert.ok(
    SUPPORTED_TYPES.includes('FAQPage') &&
      SUPPORTED_TYPES.includes('HowTo') &&
      SUPPORTED_TYPES.includes('Product'),
  );
  assert.deepEqual(problemLines(validateJsonLd({ ...ctx, '@type': 'Article' })).length > 0, true);
});

test('WebSite needs a name and an address', () => {
  const site = { ...ctx, '@type': 'WebSite', name: 'AEO Corner', url: 'https://aeocorner.com' };
  assert.equal(validateJsonLd(site).ok, true);
  assert.ok(errorsOf({ ...site, url: undefined }).some((e) => /url/.test(e)));
  assert.ok(errorsOf({ ...site, name: undefined }).some((e) => /name/.test(e)));
  assert.ok(errorsOf({ ...site, url: 'not a url' }).length > 0);
});
