import express, { Router } from 'express';
import { z } from 'zod';
import {
  can,
  canChangeRole,
  canInvite,
  canRemoveMember,
  invitableRoles,
  isRole,
  roleDescription,
  roleLabel,
} from '../../core/permissions.js';
import { DomainError } from '../../db/index.js';
import { renderEmail } from '../../lib/email.js';
import { hashToken, newToken } from '../../lib/tokens.js';
import { normalizeWebsite } from '../../lib/url.js';
import { csrfProtection } from '../auth/csrf.js';
import { projectRoutes } from './projects.js';
import { notFound } from '../middleware/errors.js';

const INVITE_TTL_DAYS = 7;
const MAX_PENDING_INVITATIONS = 50;

// Messages shown after a redirect, chosen by a short code in `?notice=`. The text is ours, never the URL's.
const NOTICES = {
  'org-created': ['success', 'Your organization is ready.'],
  joined: ['success', 'You’ve joined the organization.'],
  'role-changed': ['success', 'Role updated.'],
  'member-removed': ['success', 'Member removed.'],
  'invite-sent': ['success', 'Invitation sent.'],
  'invite-resent': ['success', 'Invitation sent again. The earlier link no longer works.'],
  'invite-canceled': ['success', 'Invitation canceled.'],
  'invite-email-failed': [
    'warning',
    'The invitation is saved, but the email could not be sent. Try “Send again” in a minute.',
  ],
  'last-owner': ['danger', 'An organization needs at least one owner, so that change wasn’t made.'],
  'not-allowed': ['danger', 'Your role doesn’t allow that.'],
  'project-created': [
    'success',
    'Your project is ready. We’re checking your site in the background.',
  ],
  verified: [
    'success',
    'Your website is verified. We now follow your own instructions, not its robots.txt, when we check it for you.',
  ],
  'competitor-added': ['success', 'Competitor added.'],
  'competitor-removed': ['success', 'Competitor removed.'],
  'competitor-exists': ['warning', 'That competitor is already on the list.'],
  'competitor-invalid': [
    'danger',
    'Enter the competitor’s name, and a website like rival.com if you add one.',
  ],
  'competitors-full': ['warning', 'You can track up to 10 competitors. Remove one to add another.'],
  'too-many-invites': ['danger', 'There are already 50 invitations waiting. Cancel some first.'],
};

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(320));

const idFrom = (value) => (/^\d{1,18}$/.test(String(value)) ? BigInt(value) : null);
const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Name suggestion for the "create organization" form: "www.acme-dental.com" -> "Acme Dental". */
export function suggestOrgName(domainInput) {
  const site = normalizeWebsite(domainInput);
  if (!site.ok) return '';
  const label = site.domain.replace(/^www\./, '').split('.')[0];
  return label
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export function appRoutes({ config, db, auth, mailer, logger, jobs = null, verifier = null }) {
  const router = Router();

  // Everything under /app: signed-in only, never cached, never indexed.
  router.use(auth.identify, auth.requireUser, (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    next();
  });

  // Page chrome: the organization switcher and any notice carried by `?notice=`.
  router.use(async (req, res, next) => {
    try {
      const memberships = await db.organizations.listForUser(req.user.id);
      req.memberships = memberships;
      res.locals.orgs = memberships.map(({ org }) => ({ publicId: org.public_id, name: org.name }));
      const notice = typeof req.query.notice === 'string' ? req.query.notice : '';
      res.locals.flash = Object.hasOwn(NOTICES, notice)
        ? [{ tone: NOTICES[notice][0], text: NOTICES[notice][1] }]
        : [];
      res.locals.nav = [];
      next();
    } catch (err) {
      next(err);
    }
  });

  router.use(
    express.urlencoded({ extended: false, limit: '20kb' }),
    csrfProtection({ secret: config.appSecret }),
  );

  const appPage = (res, view, locals = {}, options = {}) =>
    res.page(
      view,
      { showAuditBand: false, meta: { noindex: true, ...locals.meta }, ...locals },
      { layout: 'app', ...options },
    );

  // /app -> the organization to open: the last one used, else the first, else the create form.
  router.get('/', (req, res) => {
    if (req.memberships.length === 0) return res.redirect(302, '/app/new-org');
    const last = req.memberships.find(({ org }) => org.id === req.user.last_org_id);
    return res.redirect(302, `/app/o/${(last ?? req.memberships[0]).org.public_id}`);
  });

  // --- Create an organization -------------------------------------------------------------------------
  router.get('/new-org', (req, res) => {
    const suggestion = suggestOrgName(typeof req.query.domain === 'string' ? req.query.domain : '');
    appPage(res, 'new-org', {
      values: { name: suggestion },
      errors: {},
      first: res.locals.orgs.length === 0,
      meta: {
        title: 'Create your organization | AEO Corner',
        description: 'Create your organization.',
      },
    });
  });

  router.post('/new-org', async (req, res, next) => {
    try {
      const name = text(req.body.name, 200);
      const shown = (errors, status = 422) =>
        appPage(
          res,
          'new-org',
          {
            values: { name },
            errors,
            first: res.locals.orgs.length === 0,
            meta: {
              title: 'Create your organization | AEO Corner',
              description: 'Create your organization.',
            },
          },
          { status },
        );

      if (typeof req.body.name !== 'string')
        return shown({ name: 'Enter a name for your organization.' });
      try {
        const { org } = await db.organizations.createWithOwner({ user: req.user, name });
        return res.redirect(303, `/app/o/${org.public_id}?notice=org-created`);
      } catch (err) {
        if (err instanceof DomainError && err.code === 'INVALID_NAME') {
          return shown({ name: 'Use between 2 and 128 characters.' });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  // --- One organization -------------------------------------------------------------------------------
  const org = Router({ mergeParams: true });
  const projectsApi = projectRoutes({ db, jobs, auth, logger, appPage, verifier });

  org.use((req, res, next) => {
    const base = `/app/o/${req.org.public_id}`;
    res.locals.orgBase = base;
    res.locals.nav = [
      {
        href: base,
        label: 'Overview',
        icon: 'chart',
        current: req.path === '/' || req.path.startsWith('/projects'),
      },
      ...(res.locals.can('members.manage')
        ? [
            {
              href: `${base}/settings`,
              label: 'Team',
              icon: 'shield',
              current: req.path.startsWith('/settings'),
            },
          ]
        : []),
    ];
    next();
  });

  org.get('/', async (req, res, next) => {
    try {
      const only = await projectsApi.visibleIds(req);
      const projects = await req.orgDb.projects.list(only ? { onlyIds: only } : {});
      appPage(res, 'org-home', {
        projects: projects.map((p) => ({
          publicId: p.public_id,
          name: p.name,
          domain: p.domain,
          status: p.status,
        })),
        meta: { title: `${req.org.name} | AEO Corner`, description: 'Your AEO Corner overview.' },
      });
    } catch (err) {
      next(err);
    }
  });

  org.use(projectsApi.router);

  const teamMeta = (req) => ({
    title: `Team · ${req.org.name} | AEO Corner`,
    description: 'Manage who has access to this organization.',
  });

  async function renderSettings(req, res, { values = {}, errors = {}, status } = {}) {
    const [members, invitations] = await Promise.all([
      req.orgDb.memberships.list(),
      req.orgDb.invitations.listPending(),
    ]);
    const actorRole = req.membership.role;
    appPage(
      res,
      'settings',
      {
        members: members.map((m) => ({
          id: String(m.id),
          name: m.user.name || m.user.email,
          email: m.user.email,
          role: m.role,
          isYou: m.user_id === req.user.id,
          canRemove: canRemoveMember(actorRole, m.role),
          roleChoices: roleChoicesFor(actorRole, m.role),
        })),
        invitations: invitations.map((i) => ({
          id: String(i.id),
          email: i.email,
          role: i.role,
          expires: i.expires_at,
        })),
        inviteRoles: invitableRoles(actorRole).map((r) => ({
          value: r,
          label: `${roleLabel(r)} — ${roleDescription(r)}`,
        })),
        values,
        errors,
        meta: teamMeta(req),
      },
      status ? { status } : {},
    );
  }

  /** Roles this actor may move a member to (including their current one, so the select can show it). */
  function roleChoicesFor(actorRole, targetRole) {
    return ['owner', 'admin', 'editor', 'viewer']
      .filter((r) => r === targetRole || canChangeRole(actorRole, targetRole, r))
      .map((r) => ({ value: r, label: roleLabel(r) }));
  }

  const manage = auth.requirePermission('members.manage');

  org.get('/settings', manage, async (req, res, next) => {
    try {
      await renderSettings(req, res);
    } catch (err) {
      next(err);
    }
  });

  org.post('/members/:id/role', manage, async (req, res, next) => {
    try {
      const membershipId = idFrom(req.params.id);
      const target = membershipId && (await req.orgDb.memberships.get(membershipId));
      if (!target) return notFound(req, res);

      const role = req.body.role;
      if (!isRole(role) || !canChangeRole(req.membership.role, target.role, role)) {
        return res.redirect(303, `${res.locals.orgBase}/settings?notice=not-allowed`);
      }
      try {
        await req.orgDb.memberships.changeRole({
          membershipId: target.id,
          role,
          actorUserId: req.user.id,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'LAST_OWNER') {
          return res.redirect(303, `${res.locals.orgBase}/settings?notice=last-owner`);
        }
        throw err;
      }
      // Someone who lowered their own role may no longer be allowed on the team page.
      const stillManages = target.id !== req.membership.id || can(role, 'members.manage');
      const next_ = stillManages ? `${res.locals.orgBase}/settings` : res.locals.orgBase;
      return res.redirect(303, `${next_}?notice=role-changed`);
    } catch (err) {
      next(err);
    }
  });

  org.post('/members/:id/remove', manage, async (req, res, next) => {
    try {
      const membershipId = idFrom(req.params.id);
      const target = membershipId && (await req.orgDb.memberships.get(membershipId));
      if (!target) return notFound(req, res);
      if (!canRemoveMember(req.membership.role, target.role)) {
        return res.redirect(303, `${res.locals.orgBase}/settings?notice=not-allowed`);
      }
      try {
        await req.orgDb.memberships.remove({ membershipId: target.id, actorUserId: req.user.id });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'LAST_OWNER') {
          return res.redirect(303, `${res.locals.orgBase}/settings?notice=last-owner`);
        }
        throw err;
      }
      if (target.id === req.membership.id) return res.redirect(303, '/app');
      return res.redirect(303, `${res.locals.orgBase}/settings?notice=member-removed`);
    } catch (err) {
      next(err);
    }
  });

  // --- Invitations ------------------------------------------------------------------------------------
  async function sendInvitation(req, invitation, token) {
    const email = renderEmail(
      'invitation',
      {
        inviterName: req.user.name || req.user.email,
        orgName: req.org.name,
        roleLabel: roleLabel(invitation.role),
        roleDescription: roleDescription(invitation.role),
        email: invitation.email,
        acceptUrl: `${config.baseUrl}/invite/${token}`,
        expiresDays: INVITE_TTL_DAYS,
      },
      { baseUrl: config.baseUrl },
    );
    // The key makes a retry of this exact send harmless; a new token (resend) is a new send.
    await mailer.send({
      to: invitation.email,
      email,
      idempotencyKey: `invite-${invitation.id}-${token.slice(0, 12)}`,
    });
  }

  const expiry = () => new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  org.post('/invitations', manage, async (req, res, next) => {
    try {
      const values = { email: text(req.body.email, 320), role: text(req.body.role, 20) };
      const parsed = emailSchema.safeParse(values.email);
      const errors = {};
      if (!parsed.success) errors.email = 'Enter a valid email address.';
      if (!isRole(values.role) || !canInvite(req.membership.role, values.role)) {
        errors.role = 'Choose a role you’re allowed to give.';
      }
      if (Object.keys(errors).length)
        return renderSettings(req, res, { values, errors, status: 422 });

      if ((await req.orgDb.invitations.listPending()).length >= MAX_PENDING_INVITATIONS) {
        return res.redirect(303, `${res.locals.orgBase}/settings?notice=too-many-invites`);
      }

      const token = newToken();
      let invitation;
      try {
        invitation = await req.orgDb.invitations.create({
          email: parsed.data,
          role: values.role,
          inviterUserId: req.user.id,
          tokenHash: hashToken(token),
          expiresAt: expiry(),
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'ALREADY_MEMBER') {
          return renderSettings(req, res, {
            values,
            errors: { email: 'That person is already a member of this organization.' },
            status: 422,
          });
        }
        throw err;
      }

      let notice = 'invite-sent';
      try {
        await sendInvitation(req, invitation, token);
      } catch (err) {
        logger.error({ err, invitationId: String(invitation.id) }, 'Invitation email failed');
        notice = 'invite-email-failed';
      }
      return res.redirect(303, `${res.locals.orgBase}/settings?notice=${notice}`);
    } catch (err) {
      next(err);
    }
  });

  org.post('/invitations/:id/cancel', manage, async (req, res, next) => {
    try {
      const invitationId = idFrom(req.params.id);
      if (!invitationId) return notFound(req, res);
      try {
        await req.orgDb.invitations.cancel({ invitationId, actorUserId: req.user.id });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'NOT_FOUND') return notFound(req, res);
        throw err;
      }
      return res.redirect(303, `${res.locals.orgBase}/settings?notice=invite-canceled`);
    } catch (err) {
      next(err);
    }
  });

  org.post('/invitations/:id/resend', manage, async (req, res, next) => {
    try {
      const invitationId = idFrom(req.params.id);
      if (!invitationId) return notFound(req, res);
      const token = newToken();
      let invitation;
      try {
        invitation = await req.orgDb.invitations.reissue({
          invitationId,
          tokenHash: hashToken(token),
          expiresAt: expiry(),
          actorUserId: req.user.id,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'NOT_FOUND') return notFound(req, res);
        throw err;
      }
      let notice = 'invite-resent';
      try {
        await sendInvitation(req, invitation, token);
      } catch (err) {
        logger.error({ err, invitationId: String(invitation.id) }, 'Invitation email failed');
        notice = 'invite-email-failed';
      }
      return res.redirect(303, `${res.locals.orgBase}/settings?notice=${notice}`);
    } catch (err) {
      next(err);
    }
  });

  router.use('/o/:org', auth.loadOrg, org);
  return router;
}
