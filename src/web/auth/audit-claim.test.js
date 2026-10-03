import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUDIT_CLAIM_COOKIE,
  clearAuditClaim,
  readAuditClaim,
  setAuditClaim,
} from './audit-claim.js';

const ID = '01M411CQ0RYET3GKCPB5TN6ZMN';

describe('the audit claim cookie', () => {
  test('reads a well-formed audit ID among other cookies', () => {
    assert.equal(
      readAuditClaim({ headers: { cookie: `a=1; ${AUDIT_CLAIM_COOKIE}=${ID}; b=2` } }),
      ID,
    );
  });

  test('ignores a missing cookie and anything that is not an audit ID', () => {
    assert.equal(readAuditClaim({ headers: {} }), null);
    assert.equal(readAuditClaim({ headers: { cookie: 'a=1' } }), null);
    for (const bad of ['', 'nope', `${ID}x`, `${ID.slice(1)}`, '../../etc/passwd']) {
      assert.equal(
        readAuditClaim({ headers: { cookie: `${AUDIT_CLAIM_COOKIE}=${bad}` } }),
        null,
        bad,
      );
    }
    // A cookie whose name merely ends the same way is not ours.
    assert.equal(readAuditClaim({ headers: { cookie: `x${AUDIT_CLAIM_COOKIE}=${ID}` } }), null);
  });

  test('sets an HttpOnly cookie scoped to the app, and clears it the same way', () => {
    const calls = [];
    const res = {
      cookie: (...args) => calls.push(['set', ...args]),
      clearCookie: (...args) => calls.push(['clear', ...args]),
    };
    setAuditClaim({ secure: true }, res, ID);
    clearAuditClaim(res);
    const [set, clear] = calls;
    assert.deepEqual(set.slice(0, 3), ['set', AUDIT_CLAIM_COOKIE, ID]);
    assert.equal(set[3].httpOnly, true);
    assert.equal(set[3].secure, true);
    assert.equal(set[3].path, '/app');
    assert.equal(set[3].sameSite, 'lax');
    assert.ok(set[3].maxAge <= 2 * 60 * 60 * 1000);
    assert.equal(clear[2].path, '/app');
  });
});
