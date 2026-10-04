import { createHash } from 'node:crypto';
import { DomainError, isUniqueViolation } from '../errors.js';

/**
 * One organization's Google connection and the traffic it brings (Milestone 8, tasks 8.09–8.12). Merged into
 * `forOrg(orgId)` as `google` and `traffic`; the organization is bound once and no function takes an `org_id` argument.
 *
 * The Google refresh token is envelope-encrypted by the web process (it can only encrypt) and opened by the worker,
 * the same as a WordPress password (src/lib/secrets.js). The properties and sites a login can see are listed once, while
 * the access token from the sign-in is still in memory, and stored as plain choices, so the web process never needs to open
 * the token again to show the picker.
 */

const toJson = (v) => JSON.parse(JSON.stringify(v));
const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest();
const dayDate = (text) => new Date(`${String(text).slice(0, 10)}T00:00:00Z`);
const dayText = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

const toConnection = (i) => ({
  id: i.id,
  status: i.status,
  config: i.config ?? {},
  lastSuccessAt: i.last_success_at,
  lastErrorAt: i.last_error_at,
  lastError: i.last_error,
  connectedAt: i.connected_at,
  hasSecret: Boolean(i.secret_ciphertext),
});

export function trafficRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const found = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId },
      select: { id: true },
    });
    if (!found) throw new DomainError('PROJECT_NOT_IN_ORG');
  }
  const where = (projectId) => ({ org_id: orgId, project_id: projectId, type: 'google' });

  const google = {
    /** The connection of a project, with no secret in it. */
    async status(projectId) {
      await ownProject(projectId);
      const row = await prisma.integrations.findFirst({ where: where(projectId) });
      return row ? toConnection(row) : null;
    },

    /**
     * Save a grant just made: the encrypted refresh token, and the properties and sites the login can see. The connection
     * stays `pending` until the person has chosen which property and site to read. Saving again (a reconnect) replaces
     * the grant and keeps nothing of the old choice that is no longer on offer.
     */
    async saveGrant(projectId, { secret, scopes, properties, sites, userId, now = new Date() }) {
      await ownProject(projectId);
      const existing = await prisma.integrations.findFirst({ where: where(projectId) });
      const previous = existing?.config ?? {};
      const keep = (chosen, list, key) =>
        chosen && list.some((x) => x[key] === chosen) ? chosen : null;
      const ga4 = keep(previous.ga4_property_id, properties, 'id');
      const gsc = keep(previous.gsc_site_url, sites, 'siteUrl');
      const config = toJson({
        scopes,
        ga4_candidates: properties,
        gsc_candidates: sites,
        ga4_property_id: ga4,
        gsc_site_url: gsc,
        synced_from: previous.synced_from ?? null,
        synced_to: previous.synced_to ?? null,
      });
      const data = {
        status: ga4 || gsc ? 'connected' : 'pending',
        config,
        secret_ciphertext: secret.ciphertext,
        secret_wrapped_dek: secret.wrappedDek,
        secret_key_version: secret.keyVersion,
        connected_by_user_id: userId,
        connected_at: now,
        disconnected_at: null,
        last_error: null,
        last_error_at: null,
      };
      if (existing) {
        return toConnection(
          await prisma.integrations.update({ where: { id: existing.id, org_id: orgId }, data }),
        );
      }
      try {
        return toConnection(
          await prisma.integrations.create({
            data: { org_id: orgId, project_id: projectId, type: 'google', ...data },
          }),
        );
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const row = await prisma.integrations.findFirst({ where: where(projectId) });
        return toConnection(
          await prisma.integrations.update({ where: { id: row.id, org_id: orgId }, data }),
        );
      }
    },

    /**
     * Choose what to read: a GA4 property and/or a Search Console site, each from the lists stored with the grant (a value
     * that was not on offer is refused). At least one is needed. Choosing something new starts the history again.
     */
    async choose(projectId, { ga4PropertyId = null, gscSiteUrl = null }) {
      await ownProject(projectId);
      const row = await prisma.integrations.findFirst({ where: where(projectId) });
      if (!row || row.status === 'disconnected' || !row.secret_ciphertext)
        throw new DomainError('NOT_CONNECTED');
      const config = row.config ?? {};
      if (ga4PropertyId && !(config.ga4_candidates ?? []).some((p) => p.id === ga4PropertyId)) {
        throw new DomainError('NOT_OFFERED');
      }
      if (gscSiteUrl && !(config.gsc_candidates ?? []).some((s) => s.siteUrl === gscSiteUrl)) {
        throw new DomainError('NOT_OFFERED');
      }
      if (!ga4PropertyId && !gscSiteUrl) throw new DomainError('NOTHING_CHOSEN');
      const changed =
        ga4PropertyId !== config.ga4_property_id || gscSiteUrl !== config.gsc_site_url;
      const next = {
        ...config,
        ga4_property_id: ga4PropertyId,
        gsc_site_url: gscSiteUrl,
        ...(changed ? { synced_from: null, synced_to: null } : {}),
      };
      return toConnection(
        await prisma.integrations.update({
          where: { id: row.id, org_id: orgId },
          data: {
            status: 'connected',
            config: toJson(next),
            last_error: null,
            last_error_at: null,
          },
        }),
      );
    },

    /** The encrypted token and the choices: for the worker, which opens the token with the master key. */
    async secret(projectId) {
      await ownProject(projectId);
      const row = await prisma.integrations.findFirst({ where: where(projectId) });
      if (!row || row.status === 'disconnected' || !row.secret_ciphertext) return null;
      return {
        id: row.id,
        status: row.status,
        config: row.config ?? {},
        secret: {
          ciphertext: Buffer.from(row.secret_ciphertext),
          wrappedDek: Buffer.from(row.secret_wrapped_dek),
          keyVersion: row.secret_key_version,
        },
      };
    },

    /**
     * Record what a sync did. A success widens the range of days that have been read (so a day never read is not shown
     * as zero); a failure marks the connection broken, with a reason in plain words and never a response body.
     */
    async syncResult(projectId, { ok, error = null, from = null, to = null, now = new Date() }) {
      await ownProject(projectId);
      const row = await prisma.integrations.findFirst({ where: where(projectId) });
      if (!row || row.status === 'disconnected') return false;
      if (!ok) {
        await prisma.integrations.update({
          where: { id: row.id, org_id: orgId },
          data: {
            status: 'broken',
            last_error_at: now,
            last_error: String(error ?? 'Failed').slice(0, 500),
          },
        });
        return true;
      }
      const config = row.config ?? {};
      const widened = {
        ...config,
        synced_from: config.synced_from && config.synced_from < from ? config.synced_from : from,
        synced_to: config.synced_to && config.synced_to > to ? config.synced_to : to,
      };
      await prisma.integrations.update({
        where: { id: row.id, org_id: orgId },
        data: {
          status: 'connected',
          config: toJson(widened),
          last_success_at: now,
          last_error: null,
          last_error_at: null,
        },
      });
      return true;
    },

    /** Disconnect: the token is erased, not hidden. The traffic already stored stays. */
    async disconnect(projectId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const done = await prisma.integrations.updateMany({
        where: where(projectId),
        data: {
          status: 'disconnected',
          secret_ciphertext: null,
          secret_wrapped_dek: null,
          secret_key_version: null,
          disconnected_at: now,
        },
      });
      return done.count === 1;
    },
  };

  const traffic = {
    /** Store GA4 rows (`parseGa4Response`), replacing any already stored for the same day, channel and page. */
    async saveGa4(projectId, rows, { now = new Date() } = {}) {
      await ownProject(projectId);
      for (const r of rows) {
        const hash = sha256(r.landingPage);
        await prisma.$executeRaw`
          INSERT INTO traffic_daily
            (org_id, project_id, metric_date, channel, landing_page, landing_page_hash,
             sessions, engaged_sessions, key_events, revenue, currency, synced_at)
          VALUES
            (${orgId}, ${projectId}, ${dayDate(r.metricDate)}, ${r.channel}, ${r.landingPage}, ${hash},
             ${r.sessions}, ${r.engagedSessions}, ${r.keyEvents}, ${r.revenue}, ${r.currency}, ${now})
          ON DUPLICATE KEY UPDATE
            sessions = VALUES(sessions), engaged_sessions = VALUES(engaged_sessions),
            key_events = VALUES(key_events), revenue = VALUES(revenue), currency = VALUES(currency),
            synced_at = VALUES(synced_at)`;
      }
      return rows.length;
    },

    /** Store Search Console rows (`parseGscResponse`), replacing any already stored for the same day and value. */
    async saveSearch(projectId, rows, { now = new Date() } = {}) {
      await ownProject(projectId);
      for (const r of rows) {
        const hash = sha256(r.value);
        await prisma.$executeRaw`
          INSERT INTO search_console_daily
            (org_id, project_id, metric_date, dimension, dim_value, dim_hash, is_branded,
             clicks, impressions, avg_position, synced_at)
          VALUES
            (${orgId}, ${projectId}, ${dayDate(r.metricDate)}, ${r.dimension}, ${r.value}, ${hash}, ${r.isBranded},
             ${r.clicks}, ${r.impressions}, ${r.avgPosition}, ${now})
          ON DUPLICATE KEY UPDATE
            is_branded = VALUES(is_branded), clicks = VALUES(clicks), impressions = VALUES(impressions),
            avg_position = VALUES(avg_position), synced_at = VALUES(synced_at)`;
      }
      return rows.length;
    },

    /** A project's daily traffic between two dates (inclusive), oldest first. */
    async range(projectId, { from, to }) {
      await ownProject(projectId);
      const rows = await prisma.traffic_daily.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          metric_date: { gte: dayDate(from), lte: dayDate(to) },
        },
        orderBy: [{ metric_date: 'asc' }, { channel: 'asc' }, { landing_page: 'asc' }],
      });
      return rows.map((r) => ({
        metricDate: dayText(r.metric_date),
        channel: r.channel,
        landingPage: r.landing_page,
        sessions: r.sessions,
        engagedSessions: r.engaged_sessions,
        keyEvents: r.key_events,
        revenue: Number(r.revenue),
        currency: r.currency,
      }));
    },

    /** A project's Search Console rows between two dates (inclusive), oldest first. */
    async searchRange(projectId, { from, to }) {
      await ownProject(projectId);
      const rows = await prisma.search_console_daily.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          metric_date: { gte: dayDate(from), lte: dayDate(to) },
        },
        orderBy: [{ metric_date: 'asc' }, { dimension: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => ({
        metricDate: dayText(r.metric_date),
        dimension: r.dimension,
        value: r.dim_value,
        isBranded: r.is_branded,
        clicks: r.clicks,
        impressions: r.impressions,
        avgPosition: r.avg_position === null ? null : Number(r.avg_position),
      }));
    },
  };

  return { google, traffic };
}
