import { dailyCapMicros, evaluateSpend, fromMicros, utcDayStart } from '../core/spend.js';

/**
 * The per-organization daily spend cap in action (MVP §7.8): hitting it pauses collection and tells the
 * organization and the team.
 *
 * `check(orgId)` is one function used two ways: right after a ledger row is written (so a runaway loop is
 * stopped within a call or two, not 15 minutes later) and by the `guard.spend` job every 15 minutes (which also
 * lifts pauses when the day rolls over or someone raises the cap). The decision itself is
 * src/core/spend.js; this applies it.
 */
export function createSpendGuard({ db, alerts, logger, now = () => new Date() }) {
  const dayKey = (date) => date.toISOString().slice(0, 10);

  /** Tell the organization's owners and admins, once per person per day. */
  async function notifyOrganization(scoped, orgId, at) {
    const members = await scoped.memberships.list();
    for (const m of members.filter((x) => x.role === 'owner' || x.role === 'admin')) {
      await scoped.notifications.createOnce({
        userId: m.user_id,
        kind: 'spend_cap_reached',
        dedupeKey: `spend_cap:${orgId}:${dayKey(at)}:${m.user_id}`,
        subject: 'This week’s update is delayed',
        payload: { reason: 'spend_cap' },
      });
    }
  }

  return {
    /** Is collection allowed right now? Returns the moment it may resume if not. */
    async pausedUntil(orgId) {
      const { pausedUntil } = await db.forOrg(orgId).spend.state();
      return pausedUntil && pausedUntil.getTime() > now().getTime() ? pausedUntil : null;
    },

    /** Compare today's spend with the cap and pause or resume collection to match. */
    async check(orgId) {
      const scoped = db.forOrg(orgId);
      const at = now();
      const [state, spentMicros] = await Promise.all([
        scoped.spend.state(),
        scoped.usage.spentSinceMicros(utcDayStart(at)),
      ]);
      const capMicros = dailyCapMicros(state);
      const decision = evaluateSpend({
        spentMicros,
        capMicros,
        pausedUntil: state.pausedUntil,
        now: at,
      });
      const result = { ...decision, spentMicros, capMicros };

      if (decision.action === 'pause') {
        const paused = await scoped.spend.pause({
          until: decision.until,
          now: at,
          spentUsd: fromMicros(spentMicros),
          capUsd: fromMicros(capMicros),
        });
        if (paused) {
          await notifyOrganization(scoped, orgId, at);
          await alerts.alert({
            key: `spend_cap:${orgId}:${dayKey(at)}`,
            severity: 'critical',
            title: 'An organization hit its daily spend cap and collection is paused',
            details: {
              orgId: String(orgId),
              spentUsd: fromMicros(spentMicros),
              capUsd: fromMicros(capMicros),
              resumesAt: decision.until.toISOString(),
            },
          });
          logger.warn({ orgId: String(orgId) }, 'Collection paused: daily spend cap reached');
        }
        return { ...result, changed: paused };
      }

      if (decision.action === 'resume') {
        const resumed = await scoped.spend.resume({
          reason: spentMicros >= capMicros ? 'unknown' : 'new day or higher cap',
        });
        if (resumed) logger.info({ orgId: String(orgId) }, 'Collection resumed');
        return { ...result, changed: resumed };
      }

      return { ...result, changed: false };
    },
  };
}
