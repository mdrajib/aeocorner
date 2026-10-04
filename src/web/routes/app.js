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
import { readAuditClaim } from '../auth/audit-claim.js';
import { csrfProtection } from '../auth/csrf.js';
import { accessText } from '../../core/billing.js';
import { chosenProjects, memberAccessRoutes } from './member-access.js';
import { billingRoutes } from './org-billing.js';
import { notificationRoutes } from './org-notifications.js';
import { googleCallbackRoute } from './project-traffic.js';
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
  'engines-saved': ['success', 'Engines saved. The next check uses them.'],
  'engines-none': ['warning', 'At least one engine has to stay on, so nothing was changed.'],
  'engines-invalid': ['danger', 'That engine isn’t available, so nothing was changed.'],
  'access-saved': ['success', 'Access updated.'],
  'competitor-tracked': ['success', 'We’ll track that competitor.'],
  'brand-saved': ['success', 'Brand Kit saved. The earlier version is kept in the history.'],
  'brand-restored': [
    'success',
    'That version is now the current Brand Kit, saved as a new version.',
  ],
  'reading-site': [
    'success',
    'We’re reading your website again. A new version appears here in a minute or two.',
  ],
  'queue-down': [
    'warning',
    'We couldn’t start that just now. Nothing was lost: try again in a minute.',
  ],
  'question-added': ['success', 'Question added.'],
  'question-added-similar': [
    'warning',
    'Question added, but it looks like one you already have. Check the warning in the list.',
  ],
  'question-saved': ['success', 'Question saved.'],
  'question-status': ['success', 'Question updated.'],
  'question-limit': [
    'warning',
    'All the questions your plan allows are in use. Archive one to make room.',
  ],
  'question-invalid': ['danger', 'That change wasn’t understood, so nothing was changed.'],
  'questions-queued': [
    'success',
    'We’re writing your questions. They appear here in a minute or two.',
  ],
  'competitor-added': ['success', 'Competitor added.'],
  'competitor-removed': ['success', 'Competitor removed.'],
  'competitor-exists': ['warning', 'That competitor is already on the list.'],
  'competitor-invalid': [
    'danger',
    'Enter the competitor’s name, and a website like rival.com if you add one.',
  ],
  'competitors-full': ['warning', 'You can track up to 10 competitors. Remove one to add another.'],
  'tracking-started': [
    'success',
    'Tracking is on. Your first check is running and takes a few minutes.',
  ],
  'tracking-not-ready': [
    'warning',
    'Add at least one question and keep one AI engine switched on, then start tracking.',
  ],
  'tracking-unavailable': ['danger', 'This project can’t be tracked right now.'],
  'tracking-on-no-first-run': [
    'warning',
    'Tracking is on, but we couldn’t start the first check just now. It runs at its weekly time, or press “Run a check now” in a minute.',
  ],
  'run-started': [
    'success',
    'The check has started. It takes a few minutes, and this page shows when it finishes.',
  ],
  'run-in-progress': ['warning', 'A check is already running, so another wasn’t started.'],
  'run-now-limit': [
    'warning',
    'This month’s extra checks are used up. The weekly check still runs by itself.',
  ],
  'run-now-inactive': ['warning', 'Switch tracking on first, then you can check on demand.'],
  'report-sent': [
    'success',
    'Thanks. A person will check that answer. Your numbers do not change until they have.',
  ],
  'report-repeat': ['info', 'You have already reported that answer. We have it.'],
  'report-invalid': ['danger', 'That report could not be sent. Reload the page and try again.'],
  'action-started': ['success', 'Marked as in progress.'],
  'action-stopped': ['info', 'Moved back to your to-do list.'],
  'action-done-checking': [
    'success',
    'Marked as done. We are checking your site now: the first check runs straight away, then again after an hour and after a day.',
  ],
  'action-done-measuring': [
    'success',
    'Marked as done. We cannot check this kind of fix automatically, so we have started measuring: we compare your answers before and after.',
  ],
  'action-confirmed': ['success', 'Thanks. We have started measuring the effect.'],
  'action-redo': ['info', 'Back in progress. Mark it done again when the change is live.'],
  'action-dismissed': ['info', 'Dismissed. We will not suggest it again for a while.'],
  'action-reason': ['danger', 'Choose why you are dismissing it.'],
  'action-stale': [
    'warning',
    'That recommendation has changed since you opened the page, so nothing was done. It is shown as it is now.',
  ],
  'content-started': [
    'success',
    'We have started. We read what the AI engines answer today, research the topic, plan the page and write it. This usually takes a few minutes, and this page updates as it goes.',
  ],
  'content-queue-failed': [
    'danger',
    'We could not start that just now. Nothing was changed. Try again in a minute.',
  ],
  'content-quota': [
    'warning',
    'This month’s drafts are used up. Drafts are counted when they start; one that fails before it is written is given back.',
  ],
  'content-needs-topic': ['warning', 'Choose a question, or type what the page should be about.'],
  'content-saved': ['success', 'Saved as a new version. We are checking it again.'],
  'content-unchanged': ['info', 'Nothing was different, so nothing was saved.'],
  'content-empty': [
    'danger',
    'The page has no text. Write something, or go back to the earlier version.',
  ],
  'content-stale-text': [
    'warning',
    'The text changed since you opened the page, so nothing was saved. It is shown as it is now: check it, then try again.',
  ],
  'content-stale': [
    'warning',
    'This page has changed since you opened it, so nothing was done. It is shown as it is now.',
  ],
  'content-brief-saved': [
    'success',
    'The plan is saved. Write a new draft from it whenever you like.',
  ],
  'content-redrafting': [
    'success',
    'Writing a new draft from the plan. Your earlier versions are kept.',
  ],
  'content-approved': ['success', 'Approved. Nothing is on your site until you publish it.'],
  'content-blocked': [
    'warning',
    'This draft cannot be approved yet. The reasons are listed under “Approve and publish”.',
  ],
  'content-unapproved': ['info', 'Approval taken back. You can edit the text again.'],
  'content-publishing': [
    'success',
    'Publishing to WordPress. This page shows the result in a moment.',
  ],
  'content-publishing-draft': [
    'success',
    'Saving a draft in WordPress. Nothing goes live: you publish it from WordPress, or here.',
  ],
  'content-retried': ['success', 'Trying again.'],
  'content-archived': [
    'info',
    'Put away. It is not counted any more and is not shown on the board.',
  ],
  'content-no-wordpress': [
    'warning',
    'WordPress is not connected for this project, so nothing was sent. Connect it first.',
  ],
  'wp-connected': [
    'success',
    'Connected. The plugin is set up, so structured data is added on your server and new pages are announced to search engines.',
  ],
  'wp-connected-no-plugin': [
    'success',
    'Connected. You can publish pages. For structured data that crawlers reliably see, install the AEO Corner plugin and press “Check again”.',
  ],
  'wp-testing': ['info', 'Checking your site. This page shows the result in a few seconds.'],
  'wp-disconnected': [
    'info',
    'Disconnected. We deleted the saved password. If you installed the plugin, you can also disconnect it in WordPress under Settings.',
  ],
  'wp-not-configured': [
    'danger',
    'Connecting WordPress is not switched on yet on our side. We have been told.',
  ],
  'too-many-invites': ['danger', 'There are already 50 invitations waiting. Cancel some first.'],
  'google-connected': ['success', 'Connected. Choose what to read below.'],
  'google-partial': [
    'warning',
    'Connected, but you did not allow everything we asked for. We can only read what you allowed.',
  ],
  'google-denied': ['info', 'Nothing was connected: Google access was not given.'],
  'google-failed': [
    'danger',
    'We couldn’t finish connecting to Google. Nothing was saved. Try again in a minute.',
  ],
  'google-not-configured': [
    'danger',
    'Connecting Google is not switched on yet on our side. We have been told.',
  ],
  'google-chosen': [
    'success',
    'Saved. We are reading your first weeks from Google now: this page fills in by itself.',
  ],
  'google-bad-choice': [
    'danger',
    'That choice wasn’t available, so nothing was changed. Choose from the lists.',
  ],
  'google-syncing': [
    'success',
    'Reading from Google now. New numbers appear here in a few minutes.',
  ],
  'google-disconnected': [
    'info',
    'Disconnected. We erased the saved login; the traffic we already read stays.',
  ],
  'notifications-saved': ['success', 'Saved. Your email choices are updated.'],
  'billing-started': ['success', 'Thank you. Your free trial is starting.'],
  'billing-canceled': ['info', 'No problem. Nothing was charged and no plan was started.'],
  'billing-unavailable': [
    'danger',
    'Billing is not switched on yet on our side. We have been told.',
  ],
  'billing-bad-plan': ['danger', 'That plan isn’t available.'],
  'billing-not-ready': ['warning', 'That plan isn’t open for sign-up yet. We have been told.'],
  'billing-has-plan': ['info', 'You already have a plan. Use “Change plan” below.'],
  'billing-no-plan': ['warning', 'Start a plan first.'],
  'billing-no-customer': ['warning', 'There is no billing account yet. Start a plan first.'],
  'billing-same-plan': ['info', 'That is already your plan.'],
  'billing-plan-changed': [
    'success',
    'Your plan was changed. Stripe prorates the difference on your next invoice.',
  ],
  'billing-downgrade-blocked': [
    'warning',
    'You use more projects or questions than that plan allows. Archive some first, then switch. Nothing is deleted.',
  ],
  'billing-addon-added': ['success', 'Added to your plan.'],
  'billing-addon-removed': ['info', 'Removed from your plan.'],
  'billing-stripe-error': [
    'danger',
    'We couldn’t reach our payment provider just now. Nothing was changed. Try again in a minute.',
  ],
  'plan-limit-projects': [
    'warning',
    'Your plan’s projects are all in use. Upgrade to add another.',
  ],
  'plan-limit-seats': [
    'warning',
    'Your plan’s team seats are all in use. Upgrade to invite more people.',
  ],
  'plan-no-client-seats': [
    'warning',
    'Client seats are part of the Agency plan. Upgrade to limit someone to selected projects.',
  ],
  'plan-paused': [
    'warning',
    'Nothing was started: tracking is off for your account right now. See Plan and billing.',
  ],
  'plan-readonly': [
    'warning',
    'This account is read-only right now, so nothing was changed. See Plan and billing.',
  ],
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

export function appRoutes({
  config,
  db,
  auth,
  mailer,
  logger,
  jobs = null,
  verifier = null,
  content = null,
  billing = null,
  google = null,
  funnel = null,
}) {
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
    express.urlencoded({ extended: false, limit: '120kb' }),
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
    // Someone who already has an organization and came from a report ("Track this every week") goes straight to a
    // new project in the one they used last, prefilled from that report.
    if (readAuditClaim(req) && req.memberships.length > 0) {
      const last = req.memberships.find(({ org }) => org.id === req.user.last_org_id);
      return res.redirect(302, `/app/o/${(last ?? req.memberships[0]).org.public_id}/projects/new`);
    }
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
        const first = res.locals.orgs.length === 0;
        const { org } = await db.organizations.createWithOwner({ user: req.user, name });
        // The last step of the public funnel: a new account that made its first organization. Anonymous: no ids.
        if (first)
          funnel?.capture('signup_completed', { from_audit: Boolean(readAuditClaim(req)) });
        // Coming from a report: the next thing is the project for the site that was audited.
        if (readAuditClaim(req)) return res.redirect(303, `/app/o/${org.public_id}/projects/new`);
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
  const projectsApi = projectRoutes({
    db,
    jobs,
    auth,
    logger,
    appPage,
    verifier,
    content,
    google,
    config,
  });
  googleCallbackRoute(router, { config, db, google, content, logger });

  org.use(async (req, res, next) => {
    const base = `/app/o/${req.org.public_id}`;
    // When billing is enforced, a plan problem (no plan yet, payment lapsed, cancelled) is said on every page.
    try {
      if (config.billingEnforced) {
        const access = await req.orgDb.billing.access({ enforced: true });
        const message = accessText(access);
        if (message) {
          const isOwner = res.locals.can('billing.manage');
          res.locals.billingBanner = {
            tone: access.level === 'setup' ? 'info' : 'warning',
            text: isOwner
              ? message
              : `${message} Ask an owner of this organization to open Plan and billing.`,
            href: isOwner ? `${base}/billing` : null,
            linkText: access.level === 'setup' ? 'Choose a plan' : 'Open plan and billing',
          };
        }
        res.locals.access = access;
        // A cancelled, read-only account can look at everything and change nothing (except to subscribe again).
        if (!access.edit && req.method === 'POST' && !req.path.startsWith('/billing')) {
          return res.redirect(303, `${base}/billing?notice=plan-readonly`);
        }
      }
    } catch (err) {
      return next(err);
    }
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
      ...(res.locals.can('billing.manage')
        ? [
            {
              href: `${base}/billing`,
              label: 'Billing',
              icon: 'card',
              current: req.path.startsWith('/billing'),
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
    const [members, invitations, projects] = await Promise.all([
      req.orgDb.memberships.list(),
      req.orgDb.invitations.listPending(),
      req.orgDb.projects.list(),
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
          access:
            m.project_access === 'selected'
              ? `${m.projectIds.length} project${m.projectIds.length === 1 ? '' : 's'}`
              : 'Every project',
          canLimit: !['owner', 'admin'].includes(m.role),
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
        projects: projects.map((p) => ({ publicId: p.public_id, name: p.name })),
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

  memberAccessRoutes(org, { auth, appPage });
  billingRoutes(org, { auth, appPage, billing, config, db, logger });
  notificationRoutes(org, { appPage });

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
      const values = {
        email: text(req.body.email, 320),
        role: text(req.body.role, 20),
        access: req.body.access === 'selected' ? 'selected' : 'all',
        projects: Array.isArray(req.body.project)
          ? req.body.project
          : [req.body.project].filter(Boolean),
      };
      const parsed = emailSchema.safeParse(values.email);
      const errors = {};
      if (!parsed.success) errors.email = 'Enter a valid email address.';
      if (!isRole(values.role) || !canInvite(req.membership.role, values.role)) {
        errors.role = 'Choose a role you’re allowed to give.';
      }
      // A client seat: limited to the projects chosen. Owners and admins always see everything.
      const chosen = await chosenProjects(req.orgDb, {
        access: values.access,
        publicIds: req.body.project,
      });
      if (chosen.error) errors.access = chosen.error;
      else if (chosen.access === 'selected' && ['owner', 'admin'].includes(values.role)) {
        errors.access = 'Owners and admins always see every project.';
      }
      if (Object.keys(errors).length)
        return renderSettings(req, res, { values, errors, status: 422 });

      if ((await req.orgDb.invitations.listPending()).length >= MAX_PENDING_INVITATIONS) {
        return res.redirect(303, `${res.locals.orgBase}/settings?notice=too-many-invites`);
      }
      // The plan's team seats (members and invitations still waiting count), and client seats are a plan feature.
      if (!(await req.orgDb.billing.canAdd('seats')).allowed) {
        return res.redirect(303, `${res.locals.orgBase}/settings?notice=plan-limit-seats`);
      }
      if (
        chosen.access === 'selected' &&
        !(await req.orgDb.billing.featureAllowed('client_seats'))
      ) {
        return res.redirect(303, `${res.locals.orgBase}/settings?notice=plan-no-client-seats`);
      }

      const token = newToken();
      let invitation;
      try {
        invitation = await req.orgDb.invitations.create({
          email: parsed.data,
          role: values.role,
          projectAccess: chosen.access,
          projectIds: chosen.projectIds,
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
