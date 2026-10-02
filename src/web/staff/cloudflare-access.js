import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Cloudflare Access sits in front of the staff host and signs a JWT for every request it lets through
 * (header `Cf-Access-Jwt-Assertion`). We verify it ourselves so the staff app is not reachable by going
 * around Cloudflare to the server's own address. Checks follow Cloudflare's guidance (read 2026-10-02):
 * RS256 signature against the team's published keys, issuer = the team domain, audience = this application's AUD tag.
 *
 * `keys` lets tests pass a local key set instead of fetching Cloudflare's.
 */
export function cloudflareAccess({ teamDomain, aud, keys }) {
  const issuer = `https://${teamDomain}`;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async function requireCloudflareAccess(req, res, next) {
    const token = req.get('cf-access-jwt-assertion');
    if (!token) return deny(res);
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: aud,
        algorithms: ['RS256'],
      });
      req.cloudflareAccess = { email: payload.email ?? null, subject: payload.sub ?? null };
      next();
    } catch {
      deny(res);
    }
  };
}

function deny(res) {
  res.status(403).type('text/plain').set('Cache-Control', 'no-store').send('Access denied.');
}
