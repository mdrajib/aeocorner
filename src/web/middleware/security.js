import helmet from 'helmet';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const GOOGLE_AUTH_ORIGIN = 'https://accounts.google.com';

/**
 * Content-Security-Policy for the web app. Strict on purpose (docs/adr/0003-strict-csp.md):
 * no 'unsafe-inline', no 'unsafe-eval'. That is why views have no inline scripts, handlers or
 * style="" attributes, Alpine.js is the CSP build, and htmx runs with allowEval off.
 * Third-party origins are added only when the feature that needs them is configured.
 */
export function buildCspDirectives(config) {
  const script = ["'self'"];
  const connect = ["'self'"];
  const frame = [];
  const formAction = ["'self'"];
  let worker = null;

  if (config.turnstileSiteKey) {
    script.push(TURNSTILE_ORIGIN);
    frame.push(TURNSTILE_ORIGIN);
  }
  // Clerk's browser script keeps the short-lived session cookie fresh in the signed-in app (ADR-0004 addendum).
  // Only the customer instance's own frontend API host; the staff console does not load it.
  if (config.auth?.frontendApi) {
    script.push(`https://${config.auth.frontendApi}`);
    connect.push(`https://${config.auth.frontendApi}`);
    // Its token-renewal timer runs in a worker made from a blob: URL. Without this, worker-src falls back to
    // script-src, the worker is blocked, the session cookie is not renewed and a form post after a minute is a 401.
    worker = ["'self'", 'blob:'];
  }
  // "Connect Google" is a form post answered by a redirect to Google's consent page, and Chrome applies form-action to
  // that redirect. Only the one host, and only when Google OAuth is configured.
  if (config.google) formAction.push(GOOGLE_AUTH_ORIGIN);
  if (config.posthog) {
    script.push(config.posthog.assetsHost);
    connect.push(config.posthog.host, config.posthog.assetsHost);
  }

  const directives = {
    'default-src': ["'self'"],
    'script-src': script,
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': connect,
    'frame-src': frame.length ? frame : ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': formAction,
    'object-src': ["'none'"],
  };
  if (worker) directives['worker-src'] = worker;
  if (config.isProduction) directives['upgrade-insecure-requests'] = [];
  return directives;
}

export function securityHeaders(config) {
  const helmetMiddleware = helmet({
    contentSecurityPolicy: { useDefaults: false, directives: buildCspDirectives(config) },
    // HSTS only where TLS is real. Browsers ignore it on http, but localhost shouldn't advertise it.
    strictTransportSecurity: config.isProduction
      ? { maxAge: 15552000, includeSubDomains: true }
      : false,
    crossOriginEmbedderPolicy: false, // would block the Turnstile iframe
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  return (req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Staging and dev must never be indexed, whatever the page says (static files included).
    if (!config.indexable) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    helmetMiddleware(req, res, next);
  };
}
