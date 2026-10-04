/**
 * Which emails I get (UI_DESIGN E4 "Notifications: digest on/off, alerts on/off"; Milestone 8, task 8.16). One page for
 * every member, about themselves only: the weekly digest and the alert emails, per organization. Messages about the
 * account itself (a trial ending, a cancelled account's closing date) are not optional and are said to be so.
 * Registered on the organization router; `req.user` and `req.orgDb` come from the sign-in and `loadOrg`.
 */
export function notificationRoutes(org, { appPage }) {
  const here = (res) => `${res.locals.orgBase}/notifications`;

  org.get('/notifications', async (req, res, next) => {
    try {
      const prefs = await req.orgDb.notifyPrefs.get(req.user.id);
      appPage(res, 'notifications', {
        prefs,
        canAlerts: await req.orgDb.billing.featureAllowed('alerts'),
        meta: {
          title: `Email · ${req.org.name} | AEO Corner`,
          description: 'Choose which emails you get.',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  org.post('/notifications', async (req, res, next) => {
    try {
      // An unchecked box is not sent at all, so absence means off.
      await req.orgDb.notifyPrefs.set(req.user.id, {
        digest: req.body.digest === 'on',
        alerts: req.body.alerts === 'on',
      });
      res.redirect(303, `${here(res)}?notice=notifications-saved`);
    } catch (err) {
      next(err);
    }
  });
}
