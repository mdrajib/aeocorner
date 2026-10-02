const BACKSLASH = String.fromCharCode(92);

const hasControlCharacter = (text) =>
  [...text].some((ch) => ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127);

/**
 * Where to send someone after sign-in. The value comes from a query string, so it is untrusted:
 * only paths inside the app are allowed, which stops an attacker using our sign-in link to bounce a
 * victim to another site (an open redirect).
 */
export function safeNext(value, fallback = '/app') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1000) return fallback;
  // A leading "//" or a backslash is read by browsers as another host; control characters split headers.
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes(BACKSLASH) ||
    hasControlCharacter(value)
  ) {
    return fallback;
  }

  let url;
  try {
    url = new URL(value, 'http://local.invalid');
  } catch {
    return fallback;
  }
  if (url.origin !== 'http://local.invalid') return fallback;

  const path = url.pathname;
  const inApp = path === '/app' || path.startsWith('/app/') || path.startsWith('/invite/');
  return inApp ? `${path}${url.search}` : fallback;
}
