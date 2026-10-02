import { clerkMiddleware, createClerkClient, getAuth } from '@clerk/express';
import { fromApiUser } from './clerk-user.js';

/**
 * The seam between the app and Clerk. Everything that talks to Clerk lives here, so tests (and a
 * laptop with no Clerk keys) can swap in a fake with the same four methods:
 *   middleware()          Express middleware that checks the Clerk session on the request
 *   authenticate(req)     -> { clerkUserId, sessionId, claims } | null
 *   fetchUser(id)         -> the Clerk user in our shape (see clerk-user.js)
 *   endSession(sessionId) revoke the session at Clerk (sign out)
 */
export function createClerkProvider({ publishableKey, secretKey, signInUrl, signUpUrl, baseUrl }) {
  const clerkClient = createClerkClient({ publishableKey, secretKey });
  const origin = new URL(baseUrl).origin;

  return {
    configured: true,
    signInUrl,
    signUpUrl,

    middleware: () =>
      clerkMiddleware({
        clerkClient,
        publishableKey,
        secretKey,
        signInUrl,
        signUpUrl,
        // Reject session tokens minted for any other site (Clerk's `azp` claim).
        authorizedParties: [origin],
      }),

    async authenticate(req) {
      const auth = getAuth(req);
      if (!auth.userId || !auth.sessionId) return null;
      return {
        clerkUserId: auth.userId,
        sessionId: auth.sessionId,
        claims: auth.sessionClaims ?? {},
      };
    },

    async fetchUser(clerkUserId) {
      try {
        return fromApiUser(await clerkClient.users.getUser(clerkUserId));
      } catch (err) {
        if (err?.status === 404) return null;
        throw err;
      }
    },

    async endSession(sessionId) {
      await clerkClient.sessions.revokeSession(sessionId);
    },
  };
}

/** No Clerk keys: nobody can sign in. Public pages work; app pages say sign-in isn't set up. */
export function createUnconfiguredProvider() {
  return {
    configured: false,
    signInUrl: null,
    signUpUrl: null,
    middleware: () => (req, res, next) => next(),
    authenticate: async () => null,
    fetchUser: async () => null,
    endSession: async () => {},
  };
}

export function createProvider(config) {
  if (!config.auth) return createUnconfiguredProvider();
  return createClerkProvider({
    publishableKey: config.auth.publishableKey,
    secretKey: config.auth.secretKey,
    signInUrl: config.auth.signInUrl,
    signUpUrl: config.auth.signUpUrl,
    baseUrl: config.baseUrl,
  });
}
