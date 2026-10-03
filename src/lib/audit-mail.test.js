import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createAuditMail, reportUrl } from './audit-mail.js';
import { memoryMailer } from './mailer.js';

const PUBLIC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const setup = () => {
  const mailer = memoryMailer();
  return { mailer, mail: createAuditMail({ mailer, baseUrl: 'https://aeocorner.com/' }) };
};

describe('the free audit’s emails', () => {
  test('the code email carries the code and says when it expires', async () => {
    const { mailer, mail } = setup();
    await mail.sendVerificationCode({
      to: 'jo@acme.test',
      code: '048213',
      auditPublicId: PUBLIC_ID,
    });
    const [sent] = mailer.sent;
    assert.equal(sent.to, 'jo@acme.test');
    assert.equal(sent.email.subject, 'Your AEO Corner code: 048213');
    assert.match(sent.email.text, /048213/);
    assert.match(sent.email.text, /10 minutes/);
    assert.doesNotMatch(sent.email.text, /Unsubscribe/, 'a code email is not marketing');
  });

  test('a code email’s key is never derived from the code', async () => {
    const { mailer, mail } = setup();
    const send = (code) =>
      mail.sendVerificationCode({ to: 'a@b.test', code, auditPublicId: PUBLIC_ID });
    await send('111111');
    await send('111111');
    const [one, two] = mailer.sent.map((m) => m.idempotencyKey);
    assert.notEqual(one, two, 'each send is its own message');
    assert.ok(!one.includes('111111') && one.startsWith(`audit-code.${PUBLIC_ID}.`));
  });

  test('the report email links to the report and is keyed by the audit, so a retried job sends it once', async () => {
    const { mailer, mail } = setup();
    await mail.sendReportReady({
      to: 'jo@acme.test',
      domain: 'acme.example',
      aeoScore: 59,
      auditPublicId: PUBLIC_ID,
    });
    await mail.sendReportReady({
      to: 'jo@acme.test',
      domain: 'acme.example',
      aeoScore: 59,
      auditPublicId: PUBLIC_ID,
    });
    assert.equal(mailer.sent[0].idempotencyKey, `audit-report.${PUBLIC_ID}`);
    assert.equal(mailer.sent[0].idempotencyKey, mailer.sent[1].idempotencyKey);
    assert.match(mailer.sent[0].email.text, new RegExp(`https://aeocorner.com/r/${PUBLIC_ID}`));
    assert.match(mailer.sent[0].email.text, /59 out of 100/);
  });

  test('an unknown score is never sent as 0', async () => {
    const { mailer, mail } = setup();
    for (const aeoScore of [null, undefined, Number.NaN]) {
      await mail.sendReportReady({
        to: 'a@b.test',
        domain: 'acme.example',
        aeoScore,
        auditPublicId: PUBLIC_ID,
      });
    }
    for (const { email } of mailer.sent) {
      assert.doesNotMatch(email.text, /out of 100/);
      assert.doesNotMatch(email.html, /out of 100/);
    }
  });

  test('a failed send is the caller’s to handle: the mailer’s error comes through', async () => {
    const boom = new Error('provider down');
    const mail = createAuditMail({
      mailer: { send: async () => Promise.reject(boom) },
      baseUrl: 'https://aeocorner.com',
    });
    await assert.rejects(
      mail.sendVerificationCode({ to: 'a@b.test', code: '123456', auditPublicId: PUBLIC_ID }),
      boom,
    );
  });

  test('the report address has one slash however the base is written', () => {
    assert.equal(
      reportUrl('https://aeocorner.com/', PUBLIC_ID),
      `https://aeocorner.com/r/${PUBLIC_ID}`,
    );
    assert.equal(
      reportUrl('https://aeocorner.com', PUBLIC_ID),
      `https://aeocorner.com/r/${PUBLIC_ID}`,
    );
  });
});
