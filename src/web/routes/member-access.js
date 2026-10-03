import { DomainError } from '../../db/index.js';
import { notFound } from '../middleware/errors.js';
import { idFrom, toArray, withNotice } from './project-helpers.js';

/**
 * Client seats (E4, Milestone 3: 3.15): which projects a member can see. An agency invites a client with the Viewer
 * role and limits them to that client's project; everyone else sees every project. Owners and admins always see all.
 * Registered on the organization router under `members.manage` (see app.js).
 *
 * The projects a form names are looked up in this organization by their public IDs, so a project of another
 * organization is "not found", exactly like a project that doesn't exist.
 */

/** Roles that always see every project (the repository enforces the same rule). */
const SEES_ALL = ['owner', 'admin'];

export const ACCESS_ERRORS = Object.freeze({
  ACCESS_NEEDS_ALL: 'Owners and admins always see every project.',
  NONE_SELECTED: 'Choose at least one project, or give access to every project.',
  PROJECT_NOT_IN_ORG: 'Choose at least one project in this organization.',
});

/**
 * The internal IDs of the projects a form chose, or `{ error }`. `access` is what the form asked for ("all" or "selected").
 */
export async function chosenProjects(orgDb, { access, publicIds }) {
  if (access !== 'selected') return { access: 'all', projectIds: [] };
  const wanted = new Set(toArray(publicIds).filter((v) => typeof v === 'string'));
  const live = await orgDb.projects.list();
  const projectIds = live.filter((p) => wanted.has(p.public_id)).map((p) => p.id);
  if (projectIds.length === 0 || projectIds.length !== wanted.size) {
    return { error: ACCESS_ERRORS.NONE_SELECTED };
  }
  return { access: 'selected', projectIds };
}

export function memberAccessRoutes(org, { auth, appPage }) {
  const manage = auth.requirePermission('members.manage');

  async function renderAccess(req, res, target, { error = '', status } = {}) {
    const projects = await req.orgDb.projects.list();
    return appPage(
      res,
      'member-access',
      {
        target: {
          id: String(target.id),
          name: target.user.name || target.user.email,
          email: target.user.email,
          role: target.role,
          access: target.project_access,
          projectIds: target.projectIds.map(String),
          alwaysAll: SEES_ALL.includes(target.role),
        },
        projects: projects.map((p) => ({ id: String(p.id), publicId: p.public_id, name: p.name })),
        error,
        meta: {
          title: `Access · ${req.org.name} | AEO Corner`,
          description: 'Choose which projects this person can see.',
        },
      },
      status ? { status } : {},
    );
  }

  async function findMember(req) {
    const id = idFrom(req.params.id);
    if (!id) return null;
    return (await req.orgDb.memberships.list()).find((m) => m.id === id) ?? null;
  }

  org.get('/members/:id/access', manage, async (req, res, next) => {
    try {
      const target = await findMember(req);
      if (!target) return notFound(req, res);
      return await renderAccess(req, res, target);
    } catch (err) {
      return next(err);
    }
  });

  org.post('/members/:id/access', manage, async (req, res, next) => {
    try {
      const target = await findMember(req);
      if (!target) return notFound(req, res);
      const chosen = await chosenProjects(req.orgDb, {
        access: req.body.access,
        publicIds: req.body.project,
      });
      if (chosen.error) return renderAccess(req, res, target, { error: chosen.error, status: 422 });
      try {
        await req.orgDb.memberships.setProjectAccess({
          membershipId: target.id,
          access: chosen.access,
          projectIds: chosen.projectIds,
          actorUserId: req.user.id,
        });
      } catch (err) {
        if (err instanceof DomainError && ACCESS_ERRORS[err.code]) {
          return renderAccess(req, res, target, { error: ACCESS_ERRORS[err.code], status: 422 });
        }
        throw err;
      }
      return res.redirect(303, withNotice(`${res.locals.orgBase}/settings`, 'access-saved'));
    } catch (err) {
      return next(err);
    }
  });
}
