/**
 * Playwright Global Setup
 *
 * Verifies Supabase is running before E2E tests start.
 * Auto-resolves the service role key from `supabase status` if not set.
 * Fails fast with clear instructions if not.
 *
 * Note: We intentionally don't auto-start Supabase because:
 * - Multiple dev instances may be running different Supabase containers
 * - Auto-starting could conflict with existing containers
 * - User should explicitly start the instance they want to test against
 */

import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54421';
const DASHBOARD_DIR = resolve(__dirname, '../tenant-dashboard');

function resolveServiceRoleKey(): string {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const output = execSync('npx supabase status -o json', {
      cwd: DASHBOARD_DIR,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    // supabase CLI may print warnings/info before the JSON object — extract it
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      const status = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
      if (status.SERVICE_ROLE_KEY) {
        process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
        return status.SERVICE_ROLE_KEY;
      }
    }
  } catch {
    // supabase CLI not available or not running
  }

  throw new Error(
    'Could not resolve SUPABASE_SERVICE_ROLE_KEY.\n' +
    'Either start Supabase (cd apps/tenant-dashboard && npx supabase start)\n' +
    'or set SUPABASE_SERVICE_ROLE_KEY in your environment.'
  );
}

async function checkSupabaseConnection(serviceKey: string, maxRetries = 3): Promise<{ ok: boolean; lastError?: string }> {
  const client = createClient(SUPABASE_URL, serviceKey);
  let lastError: string | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const { error } = await client.auth.admin.listUsers({ perPage: 1 });
      if (!error) return { ok: true };
      lastError = `auth.admin.listUsers returned error: ${error.message} (status=${(error as any).status ?? 'n/a'})`;
    } catch (e) {
      lastError = `connection threw: ${(e as Error).message}`;
    }
    if (i < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return { ok: false, lastError };
}

/**
 * Staging serves behind Vercel Authentication. Rather than sending the
 * project's automation-bypass secret as a header on every browser request
 * (which would carry it cross-origin to third-party subresources and land
 * it in uploaded Playwright traces), do the bypass handshake ONCE here,
 * node-side: one request with the bypass query params captures Vercel's
 * `_vercel_jwt` — an origin-scoped, short-lived cookie — into a storage
 * state that the chromium-staging project loads. The durable secret never
 * enters a browser context; the worst a failed-run trace can leak is a
 * cookie that expires on its own.
 */
const VERCEL_BYPASS_STATE = resolve(__dirname, '.vercel-bypass-state.json');

async function setupVercelBypass(): Promise<void> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) return;

  const base = process.env.E2E_BASE_URL;
  if (!base) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET is set but E2E_BASE_URL is not.');

  const url = new URL(base);
  url.searchParams.set('x-vercel-protection-bypass', secret);
  url.searchParams.set('x-vercel-set-bypass-cookie', 'true');
  const resp = await fetch(url, { redirect: 'manual' });
  const jwt = resp.headers
    .getSetCookie()
    .map((c) => c.match(/^_vercel_jwt=([^;]+);?/))
    .find(Boolean)?.[1];

  const state = {
    cookies: jwt
      ? [{
          name: '_vercel_jwt',
          value: jwt,
          domain: url.hostname,
          path: '/',
          // Vercel controls the real TTL server-side; an hour comfortably
          // outlasts a shard and an expired guess only re-surfaces the wall.
          expires: Math.floor(Date.now() / 1000) + 3600,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax' as const,
        }]
      : [],
    origins: [],
  };
  writeFileSync(VERCEL_BYPASS_STATE, JSON.stringify(state));
  if (jwt) {
    console.log('🔓 Vercel bypass cookie captured for', url.hostname);
  } else {
    // Protection may be off, or the secret was rotated without re-import;
    // write the empty state so contexts still construct, and let the run
    // show the wall if it is genuinely up.
    console.warn('⚠ Vercel bypass handshake returned no _vercel_jwt (status', resp.status + ') — continuing without it');
  }
}

export default async function globalSetup() {
  await setupVercelBypass();
  console.log('\n🔍 Checking Supabase connection...');
  console.log(`   URL: ${SUPABASE_URL}\n`);

  let serviceKey: string;
  try {
    serviceKey = resolveServiceRoleKey();
    console.log('🔑 Service role key resolved');
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const { ok, lastError } = await checkSupabaseConnection(serviceKey);

  if (!ok) {
    console.error(`
╔══════════════════════════════════════════════════════════════════╗
║                SUPABASE CONNECTION FAILED                        ║
╠══════════════════════════════════════════════════════════════════╣
║ URL: ${SUPABASE_URL.padEnd(60)}║
╚══════════════════════════════════════════════════════════════════╝

Last error after ${3} attempts:
  ${lastError ?? 'unknown (no error captured)'}

If running locally, start Supabase:
  cd apps/tenant-dashboard && npx supabase start

If running against a remote instance, verify:
  - NEXT_PUBLIC_SUPABASE_URL is reachable
  - SUPABASE_SERVICE_ROLE_KEY is valid and not rotated
  - service_role has access to auth.users (GoTrue admin API)
`);
    process.exit(1);
  }

  console.log('✅ Supabase is running and ready\n');
}
