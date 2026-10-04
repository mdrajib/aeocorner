import express, { Router } from 'express';
import { PREF_LABELS, readUnsubscribeToken } from '../../core/notify.js';

/**
 * One-click unsubscribe (Milestone 8, task 8.16; RFC 8058). The link in every digest and alert email works with no
 * sign-in: its token names the person and what to switch off, and a keyed hash proves we made it.
 *
 *   GET   shows what the link does and a button. It changes nothing: mail scanners open links, and an unsubscribe must be
 *         the person's own act.
 *   POST  does it. A mail client's one-click unsubscribe is also a POST (body `List-Unsubscribe=One-Click`), with no
 *         page to come back to, so it gets a plain answer.
 *
 * Doing it twice changes nothing. A token we did not make is the same plain "this link doesn't work" page as one for a person
 * who no longer exists, so the link says nothing about who has an account. No analytics, no caching.
 */
export function unsubscribeRoutes({ config, db }) {
  const router = Router();
  const meta = {
    title: 'Email preferences | AEO Corner',
    description: 'Choose which emails you get from AEO Corner.',
    noindex: true,
    path: '/',
  };
  const quiet = { analytics: false, showAuditBand: false };

  router.use('/unsubscribe', (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    next();
  });

  router.get('/unsubscribe/:token', (req, res) => {
    const read = readUnsubscribeToken(req.params.token, config.appSecret);
    if (!read)
      return res.page('unsubscribe', { ...quiet, state: 'invalid', meta }, { status: 404 });
    return res.page('unsubscribe', {
      ...quiet,
      state: 'confirm',
      what: PREF_LABELS[read.pref],
      token: req.params.token,
      meta,
    });
  });

  router.post(
    '/unsubscribe/:token',
    express.urlencoded({ extended: false, limit: '2kb' }),
    async (req, res, next) => {
      try {
        const read = readUnsubscribeToken(req.params.token, config.appSecret);
        const oneClick = req.body?.['List-Unsubscribe'] === 'One-Click';
        if (!read) {
          return oneClick
            ? res.status(400).type('text/plain').send('This link does not work.')
            : res.page('unsubscribe', { ...quiet, state: 'invalid', meta }, { status: 404 });
        }
        await db.notifications.preferences.unsubscribe({
          userId: BigInt(read.userId),
          pref: read.pref,
        });
        if (oneClick) return res.status(200).type('text/plain').send('Unsubscribed.');
        return res.page('unsubscribe', {
          ...quiet,
          state: 'done',
          what: PREF_LABELS[read.pref],
          meta,
        });
      } catch (err) {
        return next(err);
      }
    },
  );

  return router;
}
