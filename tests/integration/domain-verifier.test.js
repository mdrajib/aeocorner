import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { newVerificationToken } from '../../src/core/domain-verification.js';
import { createDomainVerifier } from '../../src/crawler/verify-domain.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';

/** Checking a customer's proof of ownership over real sockets (Milestone 3, task 3.04). */
const servers = [];
const serve = async (handler, options) => {
  const server = await startServer(handler, options);
  servers.push(server);
  return server;
};
after(() => Promise.all(servers.map((s) => s.close())));

const token = newVerificationToken();
const noDns = async () => {
  throw Object.assign(new Error('nothing'), { code: 'ENODATA' });
};

async function verifierFor(handler, { resolveTxt = noDns } = {}) {
  const site = await serve(handler, { secure: true });
  const fetcher = testFetcher({ ports: [site.port] });
  return {
    site,
    verifier: createDomainVerifier({ fetcher, resolveTxt }),
    host: `fixture.test:${site.port}`,
  };
}

const text = (res, body, status = 200, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
};

describe('the file', () => {
  test('is accepted when it holds the token', async () => {
    const { verifier, host, site } = await verifierFor((req, res) => text(res, `${token}\n`));
    const result = await verifier.verify({ domain: host, token });
    assert.deepEqual([result.verified, result.method], [true, 'file']);
    assert.equal(site.requests[0].url, '/.well-known/aeocorner-verification.txt');
  });

  test('is refused when missing, when it holds another code, or when it is a web page', async () => {
    for (const [handler, expected] of [
      [(req, res) => text(res, 'nope', 404), /status 404/],
      [(req, res) => text(res, newVerificationToken()), /doesn’t contain our code/],
      [
        (req, res) => text(res, `<html>${token}</html>`, 200, 'text/html'),
        /doesn’t contain our code/,
      ],
    ]) {
      const { verifier, host } = await verifierFor(handler);
      const r = await verifier.verify({ domain: host, token, method: 'file' });
      assert.equal(r.verified, false);
      assert.match(r.reasons.file, expected);
    }
  });

  test('an unreachable site is “not yet”, never an exception', async () => {
    const verifier = createDomainVerifier({
      fetcher: testFetcher({ ports: [] }),
      resolveTxt: noDns,
    });
    const r = await verifier.verify({ domain: 'nobody-home.test:9', token, method: 'file' });
    assert.equal(r.verified, false);
    assert.match(r.reasons.file, /couldn’t open the file/);
  });

  test('a redirect to a private address is refused by the guard, not followed', async () => {
    const { verifier, host, site } = await verifierFor((req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const r = await verifier.verify({ domain: host, token, method: 'file' });
    assert.equal(r.verified, false);
    assert.equal(site.requests.length, 1);
  });

  test('a huge file is cut off, not read whole', async () => {
    const { verifier, host } = await verifierFor((req, res) => text(res, 'x'.repeat(1_000_000)));
    const r = await verifier.verify({ domain: host, token, method: 'file' });
    assert.equal(r.verified, false);
  });
});

describe('DNS', () => {
  test('is accepted when the TXT record carries the token, without touching the site', async () => {
    const asked = [];
    const { verifier, site } = await verifierFor((req, res) => text(res, 'unused'), {
      resolveTxt: async (name) => {
        asked.push(name);
        return [['v=spf1 -all'], [`aeocorner-verification=${token}`]];
      },
    });
    const r = await verifier.verify({ domain: 'acme.example.test', token });
    assert.deepEqual([r.verified, r.method], [true, 'dns']);
    assert.deepEqual(asked, ['_aeocorner.acme.example.test']);
    assert.equal(site.requests.length, 0);
  });

  test('says what is wrong: no record yet, a record with another value, a lookup that failed', async () => {
    const quiet = testFetcher({ ports: [] });
    const wrong = createDomainVerifier({
      fetcher: quiet,
      resolveTxt: async () => [[`aeocorner-verification=${newVerificationToken()}`]],
    });
    assert.match((await wrong.checkDns('a.test', token)).reason, /isn’t ours/);

    const missing = createDomainVerifier({ fetcher: quiet, resolveTxt: noDns });
    assert.match(
      (await missing.checkDns('a.test', token)).reason,
      /couldn’t find the TXT record yet/,
    );

    const broken = createDomainVerifier({
      fetcher: quiet,
      resolveTxt: async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      },
    });
    assert.match((await broken.checkDns('a.test', token)).reason, /Try again in a minute/);
  });

  test('method "dns" never fetches the file, and "file" never looks up DNS', async () => {
    let lookups = 0;
    const { verifier, site } = await verifierFor((req, res) => text(res, 'x'), {
      resolveTxt: async () => {
        lookups += 1;
        return [];
      },
    });
    await verifier.verify({ domain: 'acme.example.test', token, method: 'dns' });
    assert.equal(site.requests.length, 0);
    await verifier.verify({ domain: `fixture.test:${site.port}`, token, method: 'file' });
    assert.equal(lookups, 1);
  });
});
