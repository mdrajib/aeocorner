/**
 * Alerts to the team (ADMIN_OPERATIONS §7): a breaker tripped, a spend cap was hit.
 *
 * Every alert is logged (Sentry and the log search pick it up), and if ALERT_WEBHOOK_URL is set it is also
 * posted to Slack as a plain message. A failing webhook never breaks the job that raised the alert.
 * Callers decide when an alert is worth sending once (a day's cap hit, a breaker opening); this just delivers.
 */
export function createAlerter({
  logger,
  webhookUrl = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
}) {
  return {
    async alert({ key, severity = 'warning', title, details = {} }) {
      logger[severity === 'critical' ? 'error' : 'warn']({ alert: key, ...details }, title);
      if (!webhookUrl) return { delivered: false };
      try {
        const response = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `*[${severity}] ${title}*\n${Object.entries(details)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}`,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          logger.warn({ alert: key, status: response.status }, 'Alert webhook refused the message');
          return { delivered: false };
        }
        return { delivered: true };
      } catch (err) {
        logger.warn({ alert: key, err: err.message }, 'Alert webhook could not be reached');
        return { delivered: false };
      }
    },
  };
}

/** Collects alerts in memory, for tests. */
export function memoryAlerter() {
  const sent = [];
  return {
    sent,
    async alert(alert) {
      sent.push(alert);
      return { delivered: false };
    },
  };
}
