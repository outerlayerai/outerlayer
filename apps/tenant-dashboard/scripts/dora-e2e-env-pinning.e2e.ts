/**
 * DORA environment-pinning e2e — full HTTP path against a REAL Next.js dev
 * server and REAL local Postgres, authenticated as a REAL platform-admin
 * user created through the local GoTrue API (no mocks anywhere).
 *
 * Validates the environment-driven contract: the server decides the
 * environment from DORA_ENVIRONMENT; the client cannot choose. A request
 * that explicitly asks for ?environment=production against a staging
 * deployment must still receive staging data.
 *
 * Usage:
 *   1. local Supabase running (this branch's migrations applied)
 *   2. dev server:  DORA_ENVIRONMENT=staging yarn dev -p 3010
 *   3. yarn vitest run --config vitest.e2e-local.config.ts scripts/dora-e2e-env-pinning.e2e.ts
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54421';
const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:3010';
// New-format local CLI keys (legacy HS256 demo JWTs are rejected by the
// GoTrue admin API on current Supabase CLI versions). Override via env if
// your local instance differs — values come from `npx supabase status`.
const SERVICE_ROLE =
  process.env.E2E_SUPABASE_SECRET_KEY ?? 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const ANON_KEY =
  process.env.E2E_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

// Must pass withPlatformAdminAuth's email-domain gate
const ADMIN_EMAIL = 'dora-e2e-admin@agentmark.co';
const ADMIN_PASSWORD = 'dora-e2e-password-123!';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

/** Create (or reuse) a platform-admin user and return a session cookie in
 *  the @supabase/ssr format the dashboard's middleware reads. */
async function makePlatformAdminCookie(): Promise<string> {
  // 1. Ensure the user exists (GoTrue admin API; trigger creates profile)
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      email_confirm: true,
    }),
  });
  let userId: string;
  if (createRes.ok) {
    userId = (await createRes.json()).id;
  } else {
    const createErr = await createRes.text();
    // Already exists from a prior run — look it up
    const listRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?per_page=100`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    const listBody = await listRes.json();
    const users: Array<{ id: string; email: string }> = listBody.users ?? [];
    const found = users.find((u) => u.email === ADMIN_EMAIL)?.id;
    if (!found) {
      throw new Error(
        `admin user create failed (${createRes.status}: ${createErr}) and lookup found nothing (${listRes.status}: ${JSON.stringify(listBody).slice(0, 300)})`,
      );
    }
    userId = found;
  }

  // 2. Ensure the profile row exists (platform_user_role FKs to profile;
  //    admin-created users don't go through the signup trigger), then grant
  //    the platform_admin role (idempotent).
  const { error: profileErr } = await supabase
    .from('profile')
    .upsert({ id: userId, email: ADMIN_EMAIL }, { onConflict: 'id' });
  expect(profileErr).toBeNull();

  const { error: roleErr } = await supabase
    .from('platform_user_role')
    .upsert({ user_id: userId, role: 'platform_admin' }, { onConflict: 'user_id' });
  expect(roleErr).toBeNull();

  // 3. Password sign-in → session
  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  expect(tokenRes.status).toBe(200);
  const session = await tokenRes.json();

  // 4. @supabase/ssr cookie: sb-<ref>-auth-token = 'base64-' + base64url(JSON)
  //    For http://127.0.0.1:54421 the ref is the first hostname label: '127'
  const encoded = Buffer.from(JSON.stringify(session))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `sb-127-auth-token=base64-${encoded}`;
}

it('serves ONLY its own environment over HTTP — even when the client asks for another', async () => {
  // -- Clean + seed both environments ---------------------------------------
  await supabase.from('platform_incident').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('platform_deployment').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  const { error: depErr } = await supabase.from('platform_deployment').insert([
    // 3 staging deploys, 1 production deploy — counts must not blend
    { service: 'gateway', environment: 'staging', status: 'success', external_id: 'pin-stg-1', started_at: minutesAgo(200), completed_at: minutesAgo(195) },
    { service: 'gateway', environment: 'staging', status: 'success', external_id: 'pin-stg-2', started_at: minutesAgo(150), completed_at: minutesAgo(145) },
    { service: 'gateway', environment: 'staging', status: 'failure', external_id: 'pin-stg-3', started_at: minutesAgo(100), completed_at: minutesAgo(95) },
    { service: 'gateway', environment: 'production', status: 'success', external_id: 'pin-prod-1', started_at: minutesAgo(90), completed_at: minutesAgo(85) },
  ]);
  expect(depErr).toBeNull();

  const cookie = await makePlatformAdminCookie();

  // -- 1. Unauthenticated API call gets JSON 401, not a redirect -------------
  const unauthed = await fetch(`${APP_URL}/api/platform-admin/dora-metrics?timeRange=7d`, {
    redirect: 'manual',
  });
  expect(unauthed.status).toBe(401);
  expect((await unauthed.json()).code).toBe('UNAUTHORIZED');

  // -- 2. Authenticated: response is pinned to the server's environment ------
  const res = await fetch(`${APP_URL}/api/platform-admin/dora-metrics?timeRange=7d`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.environment).toBe('staging');
  // 2 SUCCESSFUL staging deploys (the failure doesn't count toward DF, and
  // the production deploy is invisible to this environment)
  expect(body.metrics.deploymentFrequency.sampleSize).toBe(2);

  // -- 3. The money assertion: asking for production changes NOTHING ---------
  const forced = await fetch(
    `${APP_URL}/api/platform-admin/dora-metrics?timeRange=7d&environment=production`,
    { headers: { cookie } },
  );
  expect(forced.status).toBe(200);
  const forcedBody = await forced.json();
  expect(forcedBody.environment).toBe('staging');
  expect(forcedBody.metrics.deploymentFrequency.sampleSize).toBe(2);

  // -- Cleanup ----------------------------------------------------------------
  await supabase.from('platform_deployment').delete().neq('id', '00000000-0000-0000-0000-000000000000');
});
