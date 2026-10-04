import { Router } from 'express';
import { publicProof } from '../../core/proof-share.js';
import { isUlid } from '../../lib/ulid.js';

/**
 * A shared proof card (UI_DESIGN D4): `GET /p/:publicId`, a public, read-only page a customer sends to a boss or a client.
 *
 * The address is the secret (a ULID). An unknown, malformed or stopped address, a closed organization and an archived
 * project are the same plain 404, so the page says nothing about what exists. The page shows only what
 * `publicProof` builds (the brand, the recommendation's title, the counts and the test): no question, answer or
 * competitor. It is never cached (so stopping a share takes effect at once), never indexed, sends no referrer, and loads no
 * analytics.
 */
export function proofShareRoutes({ db }) {
  const router = Router();
  const quiet = { analytics: false, showAuditBand: false };
  const meta = (title, description) => ({ title, description, noindex: true, path: '/' });

  router.get('/p/:publicId', async (req, res, next) => {
    try {
      res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      const id = req.params.publicId;
      const found = isUlid(id) ? await db.system.proofShares.byPublicId(id) : null;
      const proof = found ? publicProof(found.outcome, found) : null;
      if (!proof) {
        return res.page(
          'not-found',
          { ...quiet, meta: meta('Page not found | AEO Corner', 'This page does not exist.') },
          { status: 404 },
        );
      }
      return res.page('proof-share', {
        ...quiet,
        proof,
        meta: meta(
          `${proof.brandName}: a result measured by AEO Corner`,
          `How often AI answer engines name ${proof.brandName}, before and after a change.`,
        ),
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
