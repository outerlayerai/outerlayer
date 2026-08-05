#!/usr/bin/env tsx
/**
 * Seeds a deterministic test tenant + app into a local Supabase instance,
 * then mints a REAL peppered API key against the Postgres key-store.
 *
 * Used by CI workflows and the gateway-http integration harness that need a
 * genuine API key exercising the real verify path
 * (`verify_api_key` RPC over hex HMAC-SHA256(rawKey, API_KEY_PEPPER) — see
 * `packages/gateway-core/src/lib/verify-key.ts`). The minted key is scoped to the
 * seeded app + default environment with the full gateway permission surface,
 * and can be sent as `Authorization: Bearer <key>` alongside the emitted
 * `X-Outerlayer-App-Id` against `wrangler dev` with no Unkey involvement.
 *
 * The seeder MUST run with the same `API_KEY_PEPPER` the gateway boots with
 * (both from `apps/gateway/.dev.vars` / `.dev.vars.ci`), or the minted digest
 * won't match on verify. It THROWS if `API_KEY_PEPPER` is missing/empty.
 *
 * Idempotent: re-running against the same Supabase finds the existing
 * tenant by organization_name, reuses (or recreates) its app + default env,
 * and rotates the seed key in place (`replaceExisting`).
 *
 * Usage:
 *   API_KEY_PEPPER=... tsx apps/gateway/scripts/seed-test-tenant.ts
 *
 * Env vars:
 *   API_KEY_PEPPER                REQUIRED — HMAC pepper (must match gateway)
 *   SUPABASE_URL                  http://127.0.0.1:54331 (optional)
 *   SUPABASE_SECRET_KEY           demo key (safe locally) (optional;
 *                                 legacy SUPABASE_SERVICE_ROLE_KEY still read)
 *   SEED_ORG_NAME                 ci-fuzz-tenant (optional)
 *   SEED_APP_NAME                 fuzz-app (optional)
 *
 * Output: three (+mask) lines on stdout for consumers to parse:
 *   ::add-mask::<plaintext>
 *   app_id=<appId>
 *   tenant_id=<tenantId>
 *   api_key=<plaintext>
 *
 * Diagnostics go to stderr so they don't pollute stdout.
 */

import { createClient } from '@supabase/supabase-js';
import { mintApiKey } from '@repo/api-key-service';
import { GATEWAY_PERMISSIONS } from '@repo/gateway-core/lib/permissions';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54331';
// The local Supabase demo secret key (bypasses RLS for seeding), only valid
// against a local `supabase start` instance — safe to commit. Prefers
// SUPABASE_SECRET_KEY and falls back to the legacy SUPABASE_SERVICE_ROLE_KEY
// name. The hardcoded default is a legacy-format demo key so it also works
// against integration Supabase instances that predate the opaque keys.
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const ORG_NAME = process.env.SEED_ORG_NAME ?? 'ci-fuzz-tenant';
const APP_NAME = process.env.SEED_APP_NAME ?? 'fuzz-app';

function log(...args: unknown[]) {
   
  console.error('[seed-test-tenant]', ...args);
}

interface SeedResult {
  appId: string;
  tenantId: string;
  apiKey: string;
}

async function main(): Promise<SeedResult> {
  const pepper = process.env.API_KEY_PEPPER;
  if (!pepper) {
    throw new Error(
      'API_KEY_PEPPER is required to mint the seed key — set it to the same ' +
        'value the gateway boots with (apps/gateway/.dev.vars[.ci]).',
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Upsert tenant. organization_name is unique, so we can find-or-create.
  // (There is no per-tenant gateway system user; the gateway attributes
  // machine writes via sub = tenant_id, so the tenant row is all this seed
  // needs.)
  const { data: existingTenant } = await supabase
    .from('tenant')
    .select('tenant_id')
    .eq('organization_name', ORG_NAME)
    .maybeSingle();

  let tenantId: string;
  if (existingTenant) {
    tenantId = existingTenant.tenant_id;
    log('reusing tenant', tenantId);
  } else {
    const { data: newTenant, error } = await supabase
      .from('tenant')
      .insert({
        organization_name: ORG_NAME,
        company_name: 'CI Fuzz Tenant',
      })
      .select('tenant_id')
      .single();
    if (error || !newTenant) {
      throw new Error(`tenant insert failed: ${error?.message}`);
    }
    tenantId = newTenant.tenant_id;
    log('created tenant', tenantId);
  }

  // 3. Upsert app. (tenant_id, name) is unique per the app schema.
  const { data: existingApp } = await supabase
    .from('app')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', APP_NAME)
    .maybeSingle();

  let appId: string;
  if (existingApp) {
    appId = existingApp.id;
    log('reusing app', appId);
  } else {
    const { data: newApp, error } = await supabase
      .from('app')
      .insert({ tenant_id: tenantId, name: APP_NAME })
      .select('id')
      .single();
    if (error || !newApp) {
      throw new Error(`app insert failed: ${error?.message}`);
    }
    appId = newApp.id;
    log('created app', appId);
  }

  // 4. Ensure the app has a default `dev` environment.
  // `api_key.environment_id` / `deployment.environment_id` are NOT NULL,
  // and every app is expected to have exactly one default environment.
  // A raw `app` insert does NOT auto-create it (no DB trigger — production
  // does this in the app-creation action), so the gateway's CreateApiKey
  // handler would 500 without this row.
  const { data: existingEnv } = await supabase
    .from('environment')
    .select('id')
    .eq('app_id', appId)
    .eq('is_default', true)
    .maybeSingle();

  let environmentId: string;
  if (existingEnv) {
    environmentId = existingEnv.id;
    log('reusing default environment', environmentId);
  } else {
    const { data: newEnv, error } = await supabase
      .from('environment')
      .insert({
        tenant_id: tenantId,
        app_id: appId,
        name: 'dev',
        is_default: true,
      })
      .select('id')
      .single();
    if (error || !newEnv) {
      throw new Error(`environment insert failed: ${error?.message}`);
    }
    environmentId = newEnv.id;
    log('created default environment', environmentId);
  }

  // 5. Mint a real peppered API key for the seeded app + default env. For
  // service-role seeding the SAME service-role client is both rowClient (INSERT
  // the api_key row) and adminClient (set_api_key_secret RPC over the private
  // digest table). `replaceExisting` rotates the fixed-name seed key in place
  // so re-runs stay idempotent. createdBy: null marks it as a machine-authored
  // key with no human author.
  const { plaintext } = await mintApiKey({
    rowClient: supabase,
    adminClient: supabase,
    pepper,
    tenantId,
    appId,
    name: 'ci-seed-key',
    environmentId,
    permissions: [...GATEWAY_PERMISSIONS],
    isMachine: false,
    replaceExisting: true,
    createdBy: null,
  });
  log('minted seed key with prefix', plaintext.slice(0, 12));

  return { appId, tenantId, apiKey: plaintext };
}

main()
  .then(({ appId, tenantId, apiKey }) => {
    // stdout: mask the secret for CI logs, then emit parseable key=value lines
    // so consumers can capture app_id / tenant_id / api_key independently.
    process.stdout.write(`::add-mask::${apiKey}\n`);
    process.stdout.write(`app_id=${appId}\n`);
    process.stdout.write(`tenant_id=${tenantId}\n`);
    process.stdout.write(`api_key=${apiKey}\n`);
  })
  .catch((err) => {
    log('FAILED:', err.message ?? err);
    process.exit(1);
  });
