/**
 * Clerk describes a user in two slightly different shapes: the webhook payload (snake_case JSON) and the
 * Backend API object (camelCase). Both are turned into the one shape the rest of the app uses:
 * { id, email, name, imageUrl, updatedAt, emails: [{ address, verified, primary }] }.
 */

function pickEmail(emails) {
  const best =
    emails.find((e) => e.primary && e.verified) ??
    emails.find((e) => e.verified) ??
    emails.find((e) => e.primary) ??
    emails[0];
  return best?.address ?? '';
}

function build({ id, emails, firstName, lastName, username, imageUrl, updatedAt }) {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || username || '';
  return { id, email: pickEmail(emails), name, imageUrl: imageUrl || null, updatedAt, emails };
}

/** From a `user.created` / `user.updated` webhook `data` object. */
export function fromWebhookData(data) {
  const emails = (data.email_addresses ?? []).map((e) => ({
    address: String(e.email_address ?? '').toLowerCase(),
    verified: e.verification?.status === 'verified',
    primary: e.id === data.primary_email_address_id,
  }));
  return build({
    id: data.id,
    emails,
    firstName: data.first_name,
    lastName: data.last_name,
    username: data.username,
    imageUrl: data.image_url,
    updatedAt: data.updated_at,
  });
}

/** From the object returned by `clerkClient.users.getUser()`. */
export function fromApiUser(user) {
  const emails = (user.emailAddresses ?? []).map((e) => ({
    address: String(e.emailAddress ?? '').toLowerCase(),
    verified: e.verification?.status === 'verified',
    primary: e.id === user.primaryEmailAddressId,
  }));
  return build({
    id: user.id,
    emails,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    imageUrl: user.imageUrl,
    updatedAt: user.updatedAt,
  });
}

/** Addresses Clerk has verified for this user. Only these may be used to accept an invitation. */
export const verifiedAddresses = (clerkUser) =>
  clerkUser.emails.filter((e) => e.verified).map((e) => e.address);
