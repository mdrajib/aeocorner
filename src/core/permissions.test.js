import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ACTIONS,
  ROLES,
  can,
  canChangeRole,
  canInvite,
  canRemoveMember,
  invitableRoles,
} from './permissions.js';

// The expected matrix is written out by hand from CUSTOMER_JOURNEY §3.3 on purpose. If someone edits the
// rules, this table must change too, and a reviewer sees the change in plain sight.
const O = 'owner';
const A = 'admin';
const E = 'editor';
const V = 'viewer';
const MATRIX = {
  'data.view': { owner: true, admin: true, editor: true, viewer: true },
  'strategy.edit': { owner: true, admin: true, editor: true, viewer: false },
  'content.create': { owner: true, admin: true, editor: true, viewer: false },
  'site.approve': { owner: true, admin: true, editor: true, viewer: false },
  'integrations.manage': { owner: true, admin: true, editor: false, viewer: false },
  'members.manage': { owner: true, admin: true, editor: false, viewer: false },
  'billing.manage': { owner: true, admin: false, editor: false, viewer: false },
  'plan.manage': { owner: true, admin: false, editor: false, viewer: false },
  'project.create': { owner: true, admin: true, editor: true, viewer: false },
  'project.delete': { owner: true, admin: false, editor: false, viewer: false },
};

describe('role-permission matrix', () => {
  test('lists exactly the actions the test pins', () => {
    assert.deepEqual([...ACTIONS].sort(), Object.keys(MATRIX).sort());
  });

  for (const [action, expected] of Object.entries(MATRIX)) {
    for (const role of ROLES) {
      test(`${role} ${expected[role] ? 'can' : 'cannot'} ${action}`, () => {
        assert.equal(can(role, action), expected[role]);
      });
    }
  }

  test('unknown roles and actions are denied', () => {
    assert.equal(can('superuser', 'data.view'), false);
    assert.equal(can(undefined, 'data.view'), false);
    assert.equal(can('owner', 'launch.rockets'), false);
  });
});

describe('team management rules', () => {
  test('owners can invite any role; admins any role except owner; others nothing', () => {
    assert.deepEqual(invitableRoles(O), [O, A, E, V]);
    assert.deepEqual(invitableRoles(A), [A, E, V]);
    assert.deepEqual(invitableRoles(E), []);
    assert.deepEqual(invitableRoles(V), []);
    assert.equal(canInvite(A, O), false);
    assert.equal(canInvite(A, E), true);
  });

  test('an owner can change anyone to anything', () => {
    for (const target of ROLES)
      for (const next of ROLES) assert.equal(canChangeRole(O, target, next), true);
  });

  test('an admin cannot touch owners or create them', () => {
    assert.equal(canChangeRole(A, O, E), false, 'demote an owner');
    assert.equal(canChangeRole(A, E, O), false, 'promote to owner');
    assert.equal(canChangeRole(A, A, O), false, 'promote self to owner');
    assert.equal(canChangeRole(A, E, V), true);
    assert.equal(canChangeRole(A, V, A), true);
  });

  test('editors and viewers cannot change roles at all', () => {
    for (const actor of [E, V])
      for (const target of ROLES)
        for (const next of ROLES) assert.equal(canChangeRole(actor, target, next), false);
  });

  test('removal: owners remove anyone, admins everyone but owners, others nobody', () => {
    for (const target of ROLES) assert.equal(canRemoveMember(O, target), true);
    assert.equal(canRemoveMember(A, O), false);
    for (const target of [A, E, V]) assert.equal(canRemoveMember(A, target), true);
    for (const actor of [E, V])
      for (const target of ROLES) assert.equal(canRemoveMember(actor, target), false);
  });

  test('a role that does not exist is refused', () => {
    assert.equal(canChangeRole(O, 'owner', 'god'), false);
    assert.equal(canRemoveMember(O, 'god'), false);
  });
});
