/** 404 for anything no route handled. */
export function notFound(req, res) {
  res.set('X-Robots-Tag', 'noindex');
  res.page(
    'not-found',
    {
      meta: {
        title: 'Page not found | AEO Corner',
        description: 'The page you were looking for does not exist.',
        noindex: true,
        path: '/',
      },
    },
    { status: 404 },
  );
}

const MESSAGES = {
  400: {
    heading: 'We couldn’t read that request',
    message: 'Something in the request didn’t look right. Please go back and try again.',
  },
  403: {
    heading: 'That request isn’t allowed',
    message: 'We couldn’t accept the request from this page.',
  },
  413: { heading: 'That request is too large', message: 'Please send less data and try again.' },
};

const FALLBACK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Something went wrong | AEO Corner</title></head><body><h1>Something went wrong</h1><p>We’re looking into it. Please try again in a few minutes.</p></body></html>`;

/**
 * Last-resort error handler. Logs the real error with the request id, then shows a generic page:
 * never a stack trace, never the error message (it can contain paths, SQL or user input).
 * If rendering the error page itself fails, it falls back to a hard-coded HTML string.
 */
export function errorHandler(logger) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const status =
      Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    const requestId = String(req.id ?? '');
    if (status >= 500) logger.error({ err, requestId, url: req.originalUrl }, 'Unhandled error');

    res.set('X-Robots-Tag', 'noindex');
    const known = MESSAGES[status];
    const view = {
      status,
      heading: known?.heading ?? 'Something went wrong on our side',
      message: known?.message ?? 'We’re looking into it. Please try again in a few minutes.',
      requestId: status >= 500 ? requestId : '',
      showAuditBand: false,
      meta: {
        title: 'Something went wrong | AEO Corner',
        description: 'An error occurred while loading this page.',
        noindex: true,
        path: '/',
      },
    };

    if (typeof res.page !== 'function') {
      return res.status(status).type('html').send(FALLBACK_HTML);
    }
    res.page('error', view, {
      status,
      onError: (renderErr) => {
        logger.error({ err: renderErr, requestId }, 'Error page failed to render');
        res.status(status).type('html').send(FALLBACK_HTML);
      },
    });
  };
}

/** MAINTENANCE_MODE=true: every page answers 503 + Retry-After. /healthz and static files stay up. */
export function maintenanceMode(config) {
  return (req, res, next) => {
    if (!config.maintenance) return next();
    res.set('Retry-After', '3600');
    res.set('X-Robots-Tag', 'noindex');
    res.page(
      'maintenance',
      {
        showAuditBand: false,
        meta: {
          title: 'Back soon | AEO Corner',
          description: 'AEO Corner is being updated and will be back shortly.',
          noindex: true,
          path: '/',
        },
      },
      { status: 503 },
    );
  };
}
