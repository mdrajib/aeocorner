/**
 * Who can do what inside an organization. The table is CUSTOMER_JOURNEY §3.3 "Roles" turned into data;
 * the team rules below it come from ADMIN_OPERATIONS §3 ("admins can't remove owners").
 * Pure functions: no database, no request. Routes ask here, and the unit test pins every cell.
 */

export const ROLES = ['owner', 'admin', 'editor', 'viewer'];

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };

const ROLE_DESCRIPTIONS = {
  owner: 'Everything, including billing, the plan and deleting projects.',
  admin: 'Manages the team and integrations. No billing or plan changes.',
  editor: 'Edits the Brand Kit, questions and content, and approves changes to the site.',
  viewer: 'Read-only: dashboards, answers and reports.',
};

/** Action -> the roles that may do it. */
const ALLOWED = {
  'data.view': ['owner', 'admin', 'editor', 'viewer'],
  'strategy.edit': ['owner', 'admin', 'editor'], // Brand Kit, competitors, questions
  'content.create': ['owner', 'admin', 'editor'], // also: mark a fix as done
  'site.approve': ['owner', 'admin', 'editor'], // auto-fix, publish
  'integrations.manage': ['owner', 'admin'], // WordPress, Google
  'members.manage': ['owner', 'admin'], // invite, change roles, remove (limits below)
  'billing.manage': ['owner'],
  'plan.manage': ['owner'],
  'project.create': ['owner', 'admin', 'editor'], // a new project (until plan limits arrive in Milestone 8)
  'project.delete': ['owner'],
};

export const ACTIONS = Object.keys(ALLOWED);

export const isRole = (value) => ROLES.includes(value);
export const roleLabel = (role) => ROLE_LABELS[role] ?? role;
export const roleDescription = (role) => ROLE_DESCRIPTIONS[role] ?? '';

/** Can `role` do `action`? An unknown role or action is always "no". */
export function can(role, action) {
  return ALLOWED[action]?.includes(role) ?? false;
}

// --- Team management -------------------------------------------------------------------------------
// Owners manage everyone. Admins manage everyone except owners, and can't make anyone an owner.
// The database adds one more rule no role can break: an organization keeps at least one owner.

/** Roles `actorRole` may give when inviting. */
export function invitableRoles(actorRole) {
  if (!can(actorRole, 'members.manage')) return [];
  return actorRole === 'owner' ? [...ROLES] : ROLES.filter((r) => r !== 'owner');
}

export function canInvite(actorRole, role) {
  return invitableRoles(actorRole).includes(role);
}

/** Can `actorRole` change someone currently `targetRole` to `newRole`? */
export function canChangeRole(actorRole, targetRole, newRole) {
  if (!can(actorRole, 'members.manage') || !isRole(targetRole) || !isRole(newRole)) return false;
  if (actorRole === 'owner') return true;
  return targetRole !== 'owner' && newRole !== 'owner';
}

export function canRemoveMember(actorRole, targetRole) {
  if (!can(actorRole, 'members.manage') || !isRole(targetRole)) return false;
  return actorRole === 'owner' || targetRole !== 'owner';
}
