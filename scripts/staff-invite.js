// Invite a staff member: creates the staff_users row and gives them roles. Staff are invite-only
// (ADMIN_OPERATIONS §1), and the first super_admin has to come from somewhere, so this is how.
//
//   npm run staff:invite -- you@aeocorner.com "Your Name" super_admin
//   npm run staff:invite -- ops@aeocorner.com "On Call" ops support
//
// They then sign in to the STAFF Clerk app with that email address (verified) and a second factor; the
// row is bound to their Clerk user on first sign-in. Roles: super_admin, ops, support, reviewer, finance.
import { createDb, DomainError } from '../src/db/index.js';
import { loadConfig } from '../src/lib/config.js';

const ROLES = ['super_admin', 'ops', 'support', 'reviewer', 'finance'];
const [email, name, ...roles] = process.argv.slice(2);

if (!email || !name || roles.length === 0 || roles.some((r) => !ROLES.includes(r))) {
  console.error('Usage: npm run staff:invite -- <email> "<Full Name>" <role> [<role> ...]');
  console.error(`Roles: ${ROLES.join(', ')}`);
  process.exit(2);
}

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const db = createDb({ databaseUrl: config.databaseUrl, caCertPath: process.env.DATABASE_CA_CERT });
try {
  const staff = await db.staff.invite({ email, name, roles });
  console.log(`Invited ${staff.email} as ${roles.join(', ')}.`);
  console.log('They can now sign in to the staff app with that email address and a second factor.');
} catch (err) {
  if (err instanceof DomainError && err.code === 'ALREADY_INVITED') {
    console.error(`${email} is already a staff member.`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await db.close();
}
