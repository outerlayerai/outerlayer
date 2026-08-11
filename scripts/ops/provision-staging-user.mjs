#!/usr/bin/env node
/**
 * Provision (or update) a dashboard user without the public signup flow.
 *
 * Invites the address through the GoTrue admin API — which bypasses the
 * signups-disabled toggle, though NOT the before-user-created domain gate:
 * while a signup_domain_allowlist is seeded, invitees must be on an
 * allowlisted domain (for exceptions, use the Supabase dashboard's ungated
 * "Create new user" instead). Then creates the profile row the app's
 * registration path would have created, and optionally grants the
 * platform_admin role. GoTrue emails the invite link directly; the invitee
 * sets a password via that link (or via the login page's "forgot password"
 * flow, which works for any existing account).
 *
 * Safe to re-run: an existing auth user is reused, and the profile/role
 * inserts ignore duplicates.
 *
 * Output discipline: this runs in a PUBLIC repo's Actions logs. Nothing
 * printed may be a credential or a clickable auth link — the invite link
 * never passes through this process.
 *
 * Env:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Usage: node scripts/ops/provision-staging-user.mjs \
 *          --email person@example.com --name "Full Name" [--platform-admin]
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function parseArgs(argv) {
  const args = { email: '', name: '', platformAdmin: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email') args.email = argv[++i] ?? '';
    else if (argv[i] === '--name') args.name = argv[++i] ?? '';
    else if (argv[i] === '--platform-admin') args.platformAdmin = true;
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

async function api(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  return response;
}

/**
 * GoTrue's admin list has no reliable server-side email filter across
 * versions, so page through and match locally. Emails are compared
 * lowercased — GoTrue stores them lowercased.
 */
async function findUserByEmail(email) {
  const perPage = 100;
  for (let page = 1; page <= 50; page++) {
    const response = await api(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`);
    if (!response.ok) {
      fail(`Listing users failed: HTTP ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    const users = body.users ?? [];
    const match = users.find((user) => (user.email ?? '').toLowerCase() === email);
    if (match) return match;
    if (users.length < perPage) return null;
  }
  fail('User listing exceeded 50 pages; refusing to continue.');
}

async function inviteUser(email, name) {
  const response = await api('/auth/v1/invite', {
    method: 'POST',
    body: JSON.stringify({ email, data: { display_name: name } }),
  });
  if (response.ok) {
    const user = await response.json();
    console.log(`✓ Invite email sent to ${email}`);
    return user;
  }
  // 422 = already registered (e.g. created between our lookup and now, or a
  // previous partial run) — fall back to reusing the existing account.
  if (response.status === 422) {
    const existing = await findUserByEmail(email);
    if (existing) return existing;
  }
  fail(`Invite failed: HTTP ${response.status} ${await response.text()}`);
}

async function insertIgnoringDuplicate(table, onConflict, row, label) {
  const response = await api(`/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });
  if (!response.ok) {
    fail(`${label} insert failed: HTTP ${response.status} ${await response.text()}`);
  }
  console.log(`✓ ${label} ensured`);
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }

  const { email: rawEmail, name, platformAdmin } = parseArgs(process.argv.slice(2));
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Not a valid email address: ${rawEmail}`);
  if (!name.trim()) fail('--name is required.');

  const existing = await findUserByEmail(email);
  const user = existing ?? (await inviteUser(email, name.trim()));
  if (existing) console.log(`✓ Auth user already exists — reusing it`);

  await insertIgnoringDuplicate(
    'profile',
    'id',
    { id: user.id, email, name: name.trim() },
    'Profile row'
  );

  if (platformAdmin) {
    await insertIgnoringDuplicate(
      'platform_user_role',
      'user_id',
      { user_id: user.id, role: 'platform_admin' },
      'platform_admin role'
    );
    console.log(
      '  Note: the platform-admin UI also requires the email domain to be in ' +
        "the deployment's NEXT_PUBLIC_PLATFORM_ADMIN_EMAIL_DOMAIN."
    );
  }

  console.log('Done.');
}

await main();
