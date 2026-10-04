import { can } from '../../core/permissions.js';
import { CHANNEL_LABELS, trafficView } from '../../core/traffic.js';
import { DomainError } from '../../db/index.js';
import { GoogleError } from '../../integrations/google.js';
import { addDaysText, dayString } from '../../integrations/google-sync.js';
import { googleSyncJobId, slotOf } from '../../lib/job-ids.js';
import { csrfToken } from '../auth/csrf.js';
import { readGoogleState, signGoogleState } from '../auth/google-state.js';
import { notFound } from '../middleware/errors.js';
import { withNotice } from './project-helpers.js';

/**
 * AI traffic: connect Google, choose what to read, and see the visits that came from AI answers (Milestone 8, tasks 8.09
 * and 8.12; UI_DESIGN E1). Registers on the project router; the one address Google sends people back to
 * (`/app/google/callback`) is a signed-in route of its own, below.
 *
 *   GET  /projects/:pid/traffic                    the screen: connect, choose, or the charts
 *   POST …/integrations/google/connect             send the person to Google (integrations.manage)
 *   POST …/integrations/google/choose | sync | disconnect
 *   GET  /app/google/callback                      Google sends the person back here with a one-time code
 *
 * Reading is for anyone who can see the project. Connecting needs `integrations.manage` (owner, admin). The login's
 * long-lived token is encrypted here and opened only by the worker. Nothing about a visit is stored beyond its day, channel
 * and landing page.
 */

const GOOGLE_PAGE = '/integrations/google';
const redirectUriOf = (config) => `${config.baseUrl}/app/google/callback`;

export function trafficRoutes(router, { appPage, manage, jobs, logger, google, config, content }) {
  const secrets = content?.secrets ?? null;
  const base = (res) => res.locals.projectBase;
  const back = (res, notice) => res.redirect(303, withNotice(`${base(res)}/traffic`, notice));

  router.get('/projects/:pid/traffic', async (req, res, next) => {
    try {
      const conn = await req.orgDb.google.status(req.project.id);
      const today = dayString(new Date());
      const connected = conn && conn.status !== 'disconnected' ? conn : null;
      const chosen =
        connected && (connected.config.ga4_property_id || connected.config.gsc_site_url);
      let view = null;
      if (chosen) {
        const range = { from: addDaysText(today, -75), to: today };
        const [rows, search] = await Promise.all([
          req.orgDb.traffic.range(req.project.id, range),
          req.orgDb.traffic.searchRange(req.project.id, range),
        ]);
        const { synced_from: from, synced_to: to } = connected.config;
        view = trafficView({
          rows,
          search,
          coverage: from && to ? { from, to } : null,
          today,
        });
        if (view.state !== 'data' && connected.status === 'connected')
          res.locals.refreshSeconds = 15;
      }
      const config_ = connected?.config ?? {};
      appPage(res, 'traffic', {
        domain: req.project.domain ?? '',
        charts: view?.state === 'data',
        configured: Boolean(google && secrets),
        canManage: can(req.membership.role, 'integrations.manage'),
        gaOn: Boolean(config_.ga4_property_id),
        gscOn: Boolean(config_.gsc_site_url),
        connection: connected && {
          status: connected.status,
          lastSuccessAt: connected.lastSuccessAt,
          lastError: connected.lastError,
          pending: connected.status === 'pending',
          properties: config_.ga4_candidates ?? [],
          sites: config_.gsc_candidates ?? [],
          ga4PropertyId: config_.ga4_property_id ?? null,
          gscSiteUrl: config_.gsc_site_url ?? null,
        },
        view,
        channelLabels: CHANNEL_LABELS,
        csrf: csrfToken(config.appSecret, req.session.sessionId),
        meta: {
          title: `AI traffic · ${req.project.name} | AEO Corner`,
          description: `Visits to ${req.project.name} that came from AI answers.`,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(`/projects/:pid${GOOGLE_PAGE}/connect`, manage, (req, res, next) => {
    try {
      if (!google || !secrets) return back(res, 'google-not-configured');
      const state = signGoogleState(
        {
          orgPublicId: req.org.public_id,
          projectPublicId: req.project.public_id,
          userId: req.user.id,
        },
        { secret: config.appSecret, binding: csrfToken(config.appSecret, req.session.sessionId) },
      );
      return res.redirect(303, google.authUrl({ redirectUri: redirectUriOf(config), state }));
    } catch (err) {
      return next(err);
    }
  });

  router.post(`/projects/:pid${GOOGLE_PAGE}/choose`, manage, async (req, res, next) => {
    try {
      const ga4 = typeof req.body.ga4 === 'string' && req.body.ga4 ? req.body.ga4 : null;
      const gsc = typeof req.body.gsc === 'string' && req.body.gsc ? req.body.gsc : null;
      try {
        await req.orgDb.google.choose(req.project.id, { ga4PropertyId: ga4, gscSiteUrl: gsc });
      } catch (err) {
        if (err instanceof DomainError) return back(res, 'google-bad-choice');
        throw err;
      }
      await queueSync(req, 'first');
      return back(res, 'google-chosen');
    } catch (err) {
      return next(err);
    }
  });

  router.post(`/projects/:pid${GOOGLE_PAGE}/sync`, manage, async (req, res, next) => {
    try {
      const conn = await req.orgDb.google.status(req.project.id);
      if (!conn || conn.status === 'disconnected' || conn.status === 'pending') {
        return back(res, 'google-bad-choice');
      }
      await queueSync(req, 'now');
      return back(res, 'google-syncing');
    } catch (err) {
      return next(err);
    }
  });

  router.post(`/projects/:pid${GOOGLE_PAGE}/disconnect`, manage, async (req, res, next) => {
    try {
      await req.orgDb.google.disconnect(req.project.id);
      return back(res, 'google-disconnected');
    } catch (err) {
      return next(err);
    }
  });

  async function queueSync(req, tag) {
    if (!jobs) return false;
    try {
      await jobs.add(
        'sync.google',
        { orgId: String(req.org.id), projectId: String(req.project.id) },
        { jobId: googleSyncJobId(req.project.id, `${tag}-${slotOf(new Date())}`) },
      );
      return true;
    } catch (err) {
      logger.warn({ err: err.message }, 'Could not queue a Google sync');
      return false;
    }
  }
}

/**
 * Where Google sends the person back (registered with Google as the redirect address). Signed in, like everything under
 * /app. The state proves who started the connection and for which project; the person must still be allowed to manage
 * integrations there. The one-time code becomes tokens, the refresh token is encrypted at once, and the properties and
 * sites the login can see are listed now, while the short-lived access token is still in memory.
 */
export function googleCallbackRoute(router, { config, db, google, content, logger }) {
  router.get('/google/callback', async (req, res, next) => {
    try {
      const secrets = content?.secrets ?? null;
      const binding = csrfToken(config.appSecret, req.session.sessionId);
      const state = readGoogleState(req.query.state, { secret: config.appSecret, binding });
      if (!state || state.userId !== String(req.user.id)) return notFound(req, res);

      const found = await db.organizations.findForUser({
        publicId: state.orgPublicId,
        userId: req.user.id,
      });
      if (!found) return notFound(req, res);
      const scoped = db.forOrg(found.org.id);
      const project = await scoped.projects.getByPublicId(state.projectPublicId);
      if (!project) return notFound(req, res);
      const here = `/app/o/${found.org.public_id}/projects/${project.public_id}/traffic`;
      const go = (notice) => res.redirect(303, withNotice(here, notice));
      if (!can(found.membership.role, 'integrations.manage')) return go('not-allowed');
      if (!google || !secrets) return go('google-not-configured');
      if (req.query.error || typeof req.query.code !== 'string') return go('google-denied');

      try {
        const tokens = await google.exchangeCode({
          code: req.query.code,
          redirectUri: redirectUriOf(config),
        });
        if (tokens.missingScopes.length === 2) return go('google-denied');
        const [properties, sites] = await Promise.all([
          tokens.scopes.some((s) => s.endsWith('/analytics.readonly'))
            ? google.ga4Properties(tokens.accessToken).catch(() => [])
            : [],
          tokens.scopes.some((s) => s.endsWith('/webmasters.readonly'))
            ? google.searchConsoleSites(tokens.accessToken).catch(() => [])
            : [],
        ]);
        await scoped.google.saveGrant(project.id, {
          secret: secrets.encrypt(tokens.refreshToken, `google:${found.org.id}:${project.id}`),
          scopes: tokens.scopes,
          properties,
          sites,
          userId: req.user.id,
        });
        return go(tokens.missingScopes.length ? 'google-partial' : 'google-connected');
      } catch (err) {
        if (!(err instanceof GoogleError)) throw err;
        logger.warn({ code: err.code }, 'Google sign-in could not be finished');
        return go('google-failed');
      }
    } catch (err) {
      return next(err);
    }
  });
}
