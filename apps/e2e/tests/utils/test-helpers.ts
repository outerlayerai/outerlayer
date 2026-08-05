/**
 * Shared test utilities for E2E tests
 *
 * Provides reliable patterns for:
 * - Database operations with retry logic
 * - Test data cleanup with error handling
 * - Supabase client initialization
 * - Common test setup/teardown patterns
 */

import { randomInt } from 'node:crypto';

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Page } from '@playwright/test';

// ============================================================================
// Configuration
// ============================================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54421';
// Resolved by global-setup.ts from `supabase status` and set on process.env
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ??
  (() => { throw new Error('SUPABASE_SERVICE_ROLE_KEY not set — global-setup should resolve this automatically'); })();

// Standard timeouts (ms)
export const TIMEOUTS = {
  SHORT: 5000,
  MEDIUM: 10000,
  LONG: 15000,
  NAVIGATION: 20000,
  DB_RETRY_INTERVAL: 500,
  DB_MAX_RETRIES: 3,
} as const;

// ----------------------------------------------------------------------------
// Collision-proof unique tokens for seeded identifiers (emails, org names).
//
// `Date.now()` alone is NOT unique: this suite runs `fullyParallel` with
// multiple workers locally (and supports `--repeat-each`), so two rows can be
// seeded within the same millisecond and collide on a UNIQUE constraint
// (e.g. tenant_organization_name_key) — flaking the run and orphaning rows
// from any helper that throws mid-provision. Timestamp + per-process monotonic
// counter + random tail is unique within a process AND across worker processes.
// ----------------------------------------------------------------------------
let __uniqueCounter = 0;
export function uniqueToken(): string {
  __uniqueCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}-${__uniqueCounter}-${rand}`;
}

// ============================================================================
// Types (defined early for use in constants)
// ============================================================================

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface TestOrganization {
  tenantId: string;
  organizationName: string;
  companyName: string;
}

// ============================================================================
// Test accounts (created on the fly via the Supabase admin client)
// ============================================================================

/**
 * Standard test password used across all test accounts
 * Must be strong enough to pass Supabase's password strength check
 */
const TEST_PASSWORD = 'E2eT3st!Secure#2026Pwd';


// ============================================================================
// Supabase Client
// ============================================================================

let _supabaseAdmin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_supabaseAdmin) {
    // persistSession:false — the singleton is reused across tests; any signInWithPassword on this client would swap its Authorization header from service_role to the user JWT and later service-role writes would hit RLS.
    _supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return _supabaseAdmin;
}

// ============================================================================
// Database Helpers
// ============================================================================

/**
 * Waits for Supabase to be ready with exponential backoff
 */
export async function waitForSupabase(maxRetries = TIMEOUTS.DB_MAX_RETRIES): Promise<boolean> {
  const client = getSupabaseAdmin();
  let lastError: unknown = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const { error } = await client.auth.admin.listUsers({ perPage: 1 });
      if (!error) return true;
      lastError = error;
    } catch (e) {
      lastError = e;
    }
    await sleep(1000 * Math.pow(2, i));
  }

  console.error('[E2E] Supabase not ready after retries. Last error:', lastError);
  return false;
}


type Awaitable<T> = T | PromiseLike<T>;

/**
 * Retries a database query until it succeeds or max retries reached.
 * Useful for eventual consistency scenarios.
 *
 * IMPORTANT: This function throws on query errors (connection issues, SQL errors).
 * It only retries when data is null/empty (eventual consistency).
 */
export async function retryDbQuery<T>(
  queryFn: () => Awaitable<{ data: T | null; error: unknown }>,
  options: {
    maxRetries?: number;
    retryInterval?: number;
    shouldRetry?: (data: T | null) => boolean;
  } = {}
): Promise<T | null> {
  const {
    maxRetries = TIMEOUTS.DB_MAX_RETRIES,
    retryInterval = TIMEOUTS.DB_RETRY_INTERVAL,
    shouldRetry = (data) => data === null,
  } = options;

  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { data, error } = await queryFn();

    // Throw on actual query errors - don't silently retry
    if (error) {
      lastError = error;
      // Only retry on transient errors, throw on others
      const errorMessage = String(error);
      const isTransient = errorMessage.includes('timeout') ||
                          errorMessage.includes('connection') ||
                          errorMessage.includes('ECONNREFUSED');
      if (!isTransient) {
        throw new Error(`Database query failed: ${errorMessage}`);
      }
      console.warn(`[E2E] Transient DB error on attempt ${attempt + 1}/${maxRetries}:`, error);
    }

    if (!shouldRetry(data)) {
      return data;
    }

    if (attempt < maxRetries - 1) {
      await sleep(retryInterval);
    }
  }

  // Max retries exhausted - log warning but return null for backward compatibility
  console.warn(`[E2E] retryDbQuery exhausted ${maxRetries} retries. Last error:`, lastError);
  return null;
}

// ============================================================================
// Test User Helpers
// ============================================================================

/**
 * Creates a test user with profile
 */
export async function createTestUser(
  emailPrefix: string,
  options: { createProfile?: boolean; name?: string } = {}
): Promise<TestUser> {
  const { createProfile = true, name = 'Test User' } = options;
  const client = getSupabaseAdmin();
  const email = `${emailPrefix}-${uniqueToken()}@test.example.com`;
  const password = TEST_PASSWORD;

  const { data, error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });

  if (error) throw new Error(`Auth user creation failed: ${error.message}`);
  if (!data.user) throw new Error('No user returned');

  const userId = data.user.id;

  if (createProfile) {
    const { error: profileError } = await client.from('profile').insert({
      id: userId,
      email,
      name,
    });
    if (profileError) throw new Error(`Profile creation failed: ${profileError.message}`);
  }

  return { id: userId, email, password };
}

/**
 * Cleans up a test user and all associated data.
 * Logs errors but continues cleanup to prevent cascading failures.
 */
export async function cleanupTestUser(userId: string | null): Promise<void> {
  if (!userId) return;

  const client = getSupabaseAdmin();
  const errors: string[] = [];

  // Delete in order respecting FK constraints
  const { error: termsError } = await client.from('terms_agreement').delete().eq('user_id', userId);
  if (termsError) errors.push(`terms_agreement: ${termsError.message}`);

  const { error: membershipError } = await client.from('membership').delete().eq('user_id', userId);
  if (membershipError) errors.push(`membership: ${membershipError.message}`);

  const { error: profileError } = await client.from('profile').delete().eq('id', userId);
  if (profileError) errors.push(`profile: ${profileError.message}`);

  const { error: authError } = await client.auth.admin.deleteUser(userId);
  if (authError) errors.push(`auth: ${authError.message}`);

  if (errors.length > 0) {
    console.warn(`[E2E] cleanupTestUser(${userId}) had errors:`, errors.join(', '));
  }
}

// ============================================================================
// Login Helper
// ============================================================================

/**
 * Logs in a test user and waits for navigation to complete
 */
export async function loginTestUser(
  page: Page,
  user: TestUser,
  options: { expectedUrlPattern?: RegExp } = {}
): Promise<void> {
  const { expectedUrlPattern = /orgs|terms-agreement/ } = options;

  await page.goto('/auth/login');
  await page.fill('[name="email"]', user.email);
  await page.fill('[name="password"]', user.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.waitForURL(expectedUrlPattern, { timeout: TIMEOUTS.NAVIGATION });
}

// ============================================================================
// Test Organization Helpers
// ============================================================================

/**
 * Creates a test organization with the given owner
 */
export async function createTestOrganization(
  namePrefix: string,
  ownerId: string
): Promise<TestOrganization> {
  const client = getSupabaseAdmin();
  const token = uniqueToken();
  const organizationName = `${namePrefix}-org-${token}`;
  const companyName = `${namePrefix}-company-${token}`;

  // Create tenant
  const { data: tenant, error: tenantError } = await client
    .from('tenant')
    .insert({
      organization_name: organizationName,
      company_name: companyName,
      created_by: ownerId,
    })
    .select()
    .single();

  if (tenantError) throw new Error(`Tenant creation failed: ${tenantError.message}`);
  if (!tenant) throw new Error('No tenant returned');

  const tenantId = tenant.tenant_id;

  // Create owner membership
  const { error: membershipError } = await client.from('membership').insert({
    tenant_id: tenantId,
    user_id: ownerId,
    role: 'owner',
    status: 'active',
    accepted_at: new Date().toISOString(),
    created_by: ownerId,
  });

  if (membershipError) throw new Error(`Membership creation failed: ${membershipError.message}`);

  return { tenantId, organizationName, companyName };
}

/**
 * Cleans up a test organization and all associated data.
 * Logs errors but continues cleanup to prevent cascading failures.
 */
export async function cleanupTestOrganization(tenantId: string | null): Promise<void> {
  if (!tenantId) return;

  const client = getSupabaseAdmin();

  // Use platform_admin_delete_tenant RPC which sets the compensation flag
  // to bypass the protect_last_owner trigger, then cascades the delete
  const { error } = await client.rpc('platform_admin_delete_tenant', { p_tenant_id: tenantId });
  if (error) {
    console.warn(`[E2E] cleanupTestOrganization(${tenantId}) had errors:`, error.message);
  }
}

// ============================================================================
// Platform Admin Helpers
// ============================================================================

/**
 * Creates a test platform admin user
 * Note: Email uses @outerlayer.ai domain (required for platform admin access)
 */
export async function createTestPlatformAdmin(
  emailPrefix: string,
  options: { name?: string } = {}
): Promise<TestUser> {
  const { name = 'Test Platform Admin' } = options;
  const client = getSupabaseAdmin();
  const timestamp = Date.now();
  // Platform admins must be on an allowed company domain
  const email = `${emailPrefix}-${timestamp}@outerlayer.ai`;
  const password = TEST_PASSWORD;

  // Create auth user
  const { data, error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });

  if (error) throw new Error(`Auth user creation failed: ${error.message}`);
  if (!data.user) throw new Error('No user returned');

  const userId = data.user.id;

  // Create profile
  const { error: profileError } = await client.from('profile').insert({
    id: userId,
    email,
    name,
  });
  if (profileError) throw new Error(`Profile creation failed: ${profileError.message}`);

  // Grant platform admin role
  const { error: roleError } = await client.from('platform_user_role').insert({
    user_id: userId,
    role: 'platform_admin',
  });
  if (roleError) throw new Error(`Platform role assignment failed: ${roleError.message}`);

  // Create terms agreement so platform admin can access the app
  const { error: termsError } = await client.from('terms_agreement').insert({
    user_id: userId,
    terms_version: '2026-01-10',
    agreed_at: new Date().toISOString(),
    consent_type: 'explicit',
    created_by: userId,
  });
  if (termsError) throw new Error(`Terms agreement creation failed: ${termsError.message}`);

  return { id: userId, email, password };
}

/**
 * Cleans up a test platform admin user and all associated data.
 * Logs errors but continues cleanup to prevent cascading failures.
 */
export async function cleanupTestPlatformAdmin(userId: string | null): Promise<void> {
  if (!userId) return;

  const client = getSupabaseAdmin();

  // Delete platform role first
  const { error: roleError } = await client.from('platform_user_role').delete().eq('user_id', userId);
  if (roleError) {
    console.warn(`[E2E] cleanupTestPlatformAdmin(${userId}) platform_user_role error:`, roleError.message);
  }

  // Then clean up user data (uses existing cleanup function which logs its own errors)
  await cleanupTestUser(userId);
}

// ============================================================================
// Login Helper for Platform Admin
// ============================================================================

/**
 * Logs in a platform admin user and waits for navigation to platform-admin
 */
export async function loginPlatformAdmin(
  page: Page,
  user: TestUser
): Promise<void> {
  await page.goto('/auth/login');
  await page.fill('[name="email"]', user.email);
  await page.fill('[name="password"]', user.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  // Platform admin may be redirected to orgs first, then navigate to platform-admin
  await page.waitForURL(/orgs|platform-admin/, { timeout: TIMEOUTS.NAVIGATION });
}

// ============================================================================
// Billing Test Helpers
// ============================================================================

export interface TestBillingRecord {
  tenantId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  tierId: string;
}

/**
 * Creates a billing record for a tenant (hobby tier, no subscription).
 * Mirrors what the app does during org creation via Stripe.
 */
async function createTestBillingRecord(
  tenantId: string,
  options: {
    stripeSubscriptionId?: string | null;
    tierId?: string;
    createdBy?: string;
  } = {}
): Promise<TestBillingRecord> {
  const {
    stripeSubscriptionId = null,
    tierId = 'hobby',
    createdBy,
  } = options;
  const client = getSupabaseAdmin();
  // Unique across parallel workers: Date.now() alone collides when two
  // tests run in the same millisecond (billing_stripe_customer_id_key).
  const stripeCustomerId = `cus_test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const { error } = await client.from('billing').insert({
    tenant_id: tenantId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId,
    tier_id: tierId,
    created_by: createdBy ?? null,
  });

  if (error) throw new Error(`Billing record creation failed: ${error.message}`);

  return { tenantId, stripeCustomerId, stripeSubscriptionId, tierId };
}


/**
 * Cleans up a billing record for a tenant.
 */
async function cleanupTestBillingRecord(tenantId: string | null): Promise<void> {
  if (!tenantId) return;

  const client = getSupabaseAdmin();
  const { error } = await client.from('billing').delete().eq('tenant_id', tenantId);
  if (error) {
    console.warn(`[E2E] cleanupTestBillingRecord(${tenantId}) error:`, error.message);
  }
}

/**
 * Creates a fully provisioned test owner with org, membership, terms, and billing.
 * Returns all IDs needed for billing tests and cleanup.
 */
export async function createTestOwnerWithOrg(
  prefix: string,
  options: {
    billingTierId?: string;
    billingSubscriptionId?: string | null;
  } = {}
): Promise<{
  user: TestUser;
  org: TestOrganization;
  billing: TestBillingRecord;
}> {
  const user = await createTestUser(prefix);

  // Add terms agreement so the user can access the app
  const client = getSupabaseAdmin();
  const { error: termsError } = await client.from('terms_agreement').insert({
    user_id: user.id,
    terms_version: '2026-01-10',
    agreed_at: new Date().toISOString(),
    consent_type: 'explicit',
    created_by: user.id,
  });
  if (termsError) throw new Error(`Terms agreement creation failed: ${termsError.message}`);

  const org = await createTestOrganization(prefix, user.id);

  // Set app_metadata.tenant_id so the JWT carries the tenant claim that
  // `app_authorize()` and `tenant_id()` read at RLS time. Use the
  // `set_claim` RPC — same path the dashboard's `switchOrganization`
  // server action takes (lib/system/organization-service.ts) — instead
  // of `auth.admin.updateUserById({ app_metadata })`. The
  // latter works on local Supabase but on Supabase Cloud the JWT can be
  // minted before the metadata write propagates, leaving the test user
  // without `app_metadata.tenant_id` and silently failing every
  // `app_authorize` check (403 across all dashboard analytics routes,
  // as observed on staging).
  for (const [claim, value] of [
    ['tenant_id', org.tenantId],
    ['role', 'owner'],
  ] as const) {
    const { error: claimError } = await client.rpc('set_claim', {
      uid: user.id,
      claim,
      value,
    });
    if (claimError) {
      throw new Error(`set_claim(${claim}) failed: ${claimError.message}`);
    }
  }

  const billing = await createTestBillingRecord(org.tenantId, {
    tierId: options.billingTierId,
    stripeSubscriptionId: options.billingSubscriptionId,
    createdBy: user.id,
  });

  return { user, org, billing };
}

/**
 * Cleans up all resources created by createTestOwnerWithOrg.
 */
export async function cleanupTestOwnerWithOrg(
  userId: string | null,
  tenantId: string | null
): Promise<void> {
  // Clean billing before org (billing FK references tenant)
  await cleanupTestBillingRecord(tenantId);
  await cleanupTestOrganization(tenantId);
  await cleanupTestUser(userId);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Promisified sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates a unique timestamp-based identifier
 */
export function uniqueId(): number {
  return Date.now();
}

// ============================================================================
// Critical-Path Seeding Helpers
// ============================================================================

export interface TestApp {
  id: string;
  name: string;
  tenantId: string;
  /**
   * The app's auto-created default `dev` environment id. Since 054/055 every
   * app has exactly one default env and the dashboard's env-scoped pages key
   * off it (see {@link createTestApp}). Threaded here so deployment seeding +
   * env-scoped assertions don't each re-query for it.
   */
  defaultEnvId: string;
}

export async function createTestApp(
  tenantId: string,
  prefix: string,
  options: { createdBy?: string } = {},
): Promise<TestApp> {
  const client = getSupabaseAdmin();
  const name = `${prefix}-app-${Date.now()}`;
  // The `app` table carries no Fly state — what remains of it lives on
  // `environment` — so a bare app insert sets only identity + audit columns.
  // Naming a column the table does not have 500s with "Could not find the
  // '<col>' column of 'app' in the schema cache".
  const { data, error } = await client
    .from('app')
    .insert({
      tenant_id: tenantId,
      name,
      created_by: options.createdBy ?? null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`App creation failed: ${error.message}`);
  if (!data) throw new Error('No app returned');
  const appId = data.id as string;

  // Every app gets exactly one default `dev` environment, no-pin
  // (current_version=0), auto-seeded by the `app_seed_default_env` trigger
  // (AFTER INSERT ON app) before the insert above returns — so we just read
  // it back rather than inserting our own (an insert here always loses the
  // (app_id, name) unique race and 23505s). The env is required for the
  // tests, not cosmetic: since 054/055 the dashboard's deployment views are
  // environment-scoped. `useDeploymentHistoryList`/`useActiveDeployment` skip
  // their query entirely when no env is selected and filter on
  // `.eq('environment_id', envId)`; `EnvContext` only resolves a selected env
  // when the app actually has a `dev` row. An app with no env therefore
  // renders a permanently-empty deployments list — which is exactly why
  // `deployments/lifecycle.spec.ts` could never find its seeded card.
  // apps/e2e has no `@repo/*` deps, so we direct-fetch here.
  // The app_id FK is ON DELETE CASCADE, so `cleanupTestApp` still removes this.
  const { data: envData, error: envError } = await client
    .from('environment')
    .select('id')
    .eq('app_id', appId)
    .eq('is_default', true)
    .single();
  if (envError || !envData) {
    throw new Error(`Default env lookup failed: ${envError?.message ?? 'no row returned'}`);
  }
  return { id: appId, name, tenantId, defaultEnvId: envData.id as string };
}

export async function cleanupTestApp(appId: string | null): Promise<void> {
  if (!appId) return;
  const client = getSupabaseAdmin();
  const { error } = await client.from('app').delete().eq('id', appId);
  if (error) console.warn(`[E2E] cleanupTestApp(${appId}) error:`, error.message);
}

/**
 * Mints a real gateway API key scoped to `permissions`, for specs that need
 * to call the gateway's own auth path (there is no dev-bypass token — every
 * `/v1` route verifies an API key against the Postgres key-store). Signs the
 * test user in for a bearer JWT, then has the GATEWAY mint the key
 * (POST /v1/api-keys) so the request also proves the deployed pepper/key-store
 * agree, mirroring apps/e2e/scripts/probe-gateway-read.ts.
 */
export async function mintApiKey(
  user: TestUser,
  appId: string,
  permissions: string[],
  options: { gatewayUrl?: string; keyName?: string } = {},
): Promise<string> {
  const gatewayUrl =
    options.gatewayUrl ?? process.env.E2E_GATEWAY_URL ?? 'http://localhost:9101';
  const keyName = options.keyName ?? `e2e-key-${uniqueToken()}`;

  const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn, error: signInErr } = await authClient.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (signInErr || !signIn.session) {
    throw new Error(
      `mintApiKey: sign-in as ${user.email} failed: ${signInErr?.message ?? 'no session'}`,
    );
  }

  const res = await fetch(`${gatewayUrl}/v1/api-keys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signIn.session.access_token}`,
      'X-Outerlayer-App-Id': appId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: keyName, app_id: appId, permissions }),
  });
  if (!res.ok) {
    throw new Error(
      `mintApiKey: POST /v1/api-keys failed: ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
  const body = (await res.json()) as { data: { plaintext_key: string } };
  return body.data.plaintext_key;
}

export interface TestGitConnection {
  repository: string;
  installationId: number;
  branch: string;
}

/**
 * Seed a git connection for an app end-to-end. Writes the same rows
 * seed-staging-fixture.ts::ensureGitConnectionFixture does: git_connection
 * (repo + installation), git_branch, and app.commit_sha.
 *
 * The default installation_id is a unique synthetic value per call:
 * excl_git_connection_installation_one_tenant binds an installation to one
 * tenant, and the real agentmark-stg installation is already claimed by the
 * staging fixture tenant — a fresh test tenant reusing it would raise 23P01.
 * A spec that must produce a REAL commit has to pass installationId explicitly
 * AND run against the tenant that owns that installation. All rows are
 * app_id-scoped + ON DELETE CASCADE, so cleanupTestApp removes them.
 */
export async function createTestGitConnection(
  tenantId: string,
  appId: string,
  options: {
    repository?: string;
    installationId?: number;
    provider?: 'github' | 'gitlab';
    branch?: string;
    commitSha?: string;
    createdBy?: string;
  } = {},
): Promise<TestGitConnection> {
  const client = getSupabaseAdmin();
  const repository =
    options.repository ?? process.env.E2E_AUTHORING_REPO ?? 'agentmark-ai/e2e-authoring-fixture';
  // Synthetic ids live in [2.0e9, 2.147e9) — inside the column's int4 range but
  // far above GitHub's real installation ids, so they never collide with an
  // actual installation row.
  const installationId = options.installationId ?? 2_000_000_000 + randomInt(0, 147_000_000);
  const provider = options.provider ?? 'github';
  const branch = options.branch ?? 'main';

  const { error: connErr } = await client.from('git_connection').insert({
    tenant_id: tenantId,
    app_id: appId,
    provider,
    repository,
    installation_id: installationId,
    created_by: options.createdBy ?? null,
  });
  if (connErr) throw new Error(`git_connection insert failed: ${connErr.message}`);

  const { error: branchErr } = await client.from('git_branch').insert({
    tenant_id: tenantId,
    app_id: appId,
    branch_name: branch,
    created_by: options.createdBy ?? null,
  });
  if (branchErr) throw new Error(`git_branch insert failed: ${branchErr.message}`);

  if (options.commitSha) {
    const { error: shaErr } = await client
      .from('app')
      .update({ commit_sha: options.commitSha })
      .eq('id', appId);
    if (shaErr) throw new Error(`app.commit_sha update failed: ${shaErr.message}`);
  }

  return { repository, installationId, branch };
}

