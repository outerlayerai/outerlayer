/**
 * Shared helpers for the Environments & Promotion integration tests.
 *
 * Mirrors the multi-user-in-shared-tenant pattern from
 * `apps/integration-tests/src/tests/app-level-roles/helpers.ts`. The fixture
 * here adds: an app row, the default `dev` environment (seeded automatically by
 * the `on_create_seed_default_env` trigger on app insert; this fixture also
 * calls `EnvironmentService.createDefaultEnvironment`, which is idempotent and
 * returns the trigger-seeded row), and three users with different org-level
 * roles (owner/write/read).
 *
 * Runs against a real local Supabase; each test cleans up the rows it seeds.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { retryOnTransientError } from '../../lib/retry';
import {
  EnvironmentService,
} from '@repo/environments-service';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface SameTenantUser {
  id: string;
  email: string;
  tenantId: string;
  membershipId: string;
  orgRole: 'owner' | 'admin' | 'write' | 'read' | 'disabled';
  client: SupabaseClient;
}

export interface Environment {
  id: string;
  tenant_id: string;
  app_id: string;
  name: string;
  is_default: boolean;
  current_version: number;
  fly_app_name: string | null;
  epoch: number;
  created_at: string;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface EnvTestFixture {
  tenant: { id: string };
  app: { id: string; name: string };
  ownerUser: SameTenantUser;
  writerUser: SameTenantUser;
  readerUser: SameTenantUser;
  defaultEnv: Environment;
  cleanup: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal config
// ─────────────────────────────────────────────────────────────────────────────

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// ─────────────────────────────────────────────────────────────────────────────
// User + tenant setup
// ─────────────────────────────────────────────────────────────────────────────

async function createUser(params: {
  tenantId: string;
  role: 'owner' | 'admin' | 'write' | 'read' | 'disabled';
  rid: string;
}): Promise<SameTenantUser> {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const { tenantId, role, rid } = params;
  const localId = Math.random().toString(36).substring(2, 8);
  const email = `${role}-${Date.now()}-${rid}-${localId}@test-envs.com`;
  const password = 'TestPassword123!';

  const { data: authData, error: authError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (authError || !authData?.user) {
    throw new Error(`Auth user create: ${authError?.message}`);
  }
  const userId = authData.user.id;

  // Kong occasionally returns a transient 502 ("An invalid response was
  // received from the upstream server") right after the stack boots in CI.
  // The shared retry helper rides out the blip; upsert keeps the retry
  // idempotent if the row actually committed before Kong dropped the response.
  const { error: profileError } = await retryOnTransientError(() =>
    admin.from('profile').upsert({ id: userId, name: `${role} ${rid}`, email })
  );
  if (profileError) throw new Error(`Profile create: ${profileError.message}`);

  const { data: membershipData, error: membershipError } = await retryOnTransientError(() =>
    admin
      .from('membership')
      .insert({
        user_id: userId,
        tenant_id: tenantId,
        role,
        status: 'active',
      })
      .select('id')
      .single()
  );
  if (membershipError) {
    throw new Error(`Membership create: ${membershipError.message}`);
  }

  await admin.rpc('set_claim', { claim: 'tenant_id', uid: userId, value: tenantId });
  await admin.rpc('set_claim', { claim: 'role', uid: userId, value: role });

  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(`Sign in: ${signInError.message}`);
  await client.auth.refreshSession();

  return {
    id: userId,
    email,
    tenantId,
    membershipId: membershipData.id as string,
    orgRole: role,
    client,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// setupEnvFixture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates tenant + app + 3 users (owner / writer / reader) and the default
 * `dev` environment for the app. Returns the fixture plus a cleanup function
 * that removes every row + auth user the fixture created.
 *
 * Notes on the default env:
 *   - The `on_create_seed_default_env` trigger (migration 20260529221911) seeds
 *     the default `dev` env automatically when the app row is inserted.
 *   - This fixture also calls `EnvironmentService.createDefaultEnvironment`,
 *     which is idempotent (returns the trigger-seeded row on a 23505) — kept so
 *     the fixture still works if run against a pre-trigger DB, and so the
 *     service method stays exercised here.
 */
export async function setupEnvFixture(): Promise<EnvTestFixture> {
  // Cast to a generic SupabaseClient — the typed `Database` does not know
  // about `environment` / `promotion_history` until `yarn codegen:db` runs
  // against these migrations. There are no `template_snapshot` /
  // `env_config_snapshot` tables at all; codegen will never produce them.
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const tenantId = randomUUID();
  const rid = Math.random().toString(36).substring(2, 8);

  // 1. Create tenant. created_by is bootstrapped to a UUID placeholder then
  //    updated below once the owner user exists.
  const { error: tenantError } = await retryOnTransientError(() =>
    admin.from('tenant').insert({
      tenant_id: tenantId,
      company_name: `env-tests-${rid}`,
      organization_name: `env-tests-org-${rid}`,
      created_by: randomUUID(),
    })
  );
  if (tenantError) throw new Error(`Tenant create: ${tenantError.message}`);

  // 2. Create three users — owner first because we need its id for the
  //    tenant.created_by update.
  const ownerUser = await createUser({ tenantId, role: 'owner', rid });
  await admin.from('tenant').update({ created_by: ownerUser.id }).eq('tenant_id', tenantId);
  const writerUser = await createUser({ tenantId, role: 'write', rid });
  const readerUser = await createUser({ tenantId, role: 'read', rid });

  // 3. Create the app row. Wrapped in retryOnTransientError like the tenant
  //    insert above — under CI load Kong/PostgREST can return a transient 502
  //    ("invalid response was received from the upstream server") on this
  //    insert too.
  const appName = `env-test-app-${rid}`;
  const { data: appData, error: appError } = await retryOnTransientError(() =>
    admin
      .from('app')
      .insert({
        tenant_id: tenantId,
        name: appName,
        created_by: ownerUser.id,
      })
      .select('id, name')
      .single()
  );
  if (appError || !appData) {
    throw new Error(`App create: ${appError?.message}`);
  }

  // 4. Auto-create the default env via the service. This mirrors
  //    what the production app-creation server action does.
  const envService = new EnvironmentService({
    supabase: admin as unknown as SupabaseClient,
  });
  const defaultEnv = await envService.createDefaultEnvironment({
    tenantId,
    appId: appData.id as string,
    actorId: ownerUser.id,
  });

  const fixture: EnvTestFixture = {
    tenant: { id: tenantId },
    app: { id: appData.id as string, name: appData.name as string },
    ownerUser,
    writerUser,
    readerUser,
    defaultEnv: defaultEnv as Environment,
    cleanup: () => cleanupFixture(tenantId, [ownerUser, writerUser, readerUser]),
  };
  return fixture;
}

async function cleanupFixture(
  tenantId: string,
  users: SameTenantUser[],
): Promise<void> {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;

  // Order matters: child rows first. There is no env-promotion saga
  // (`deployment`, `template_snapshot`, `env_config_snapshot`), so nothing
  // beyond the tables below needs clearing.
  try {
    await admin.from('api_key').delete().eq('tenant_id', tenantId);
    await admin.from('environment').delete().eq('tenant_id', tenantId);
    await admin.from('app_member_role').delete().eq('tenant_id', tenantId);
    await admin.from('app').delete().eq('tenant_id', tenantId);
  } catch (err) {
    // Cleanup is best-effort; swallow.

    console.warn(`cleanup: child-row delete swallowed: ${(err as Error).message}`);
  }

  for (const u of users) {
    try {
      await admin.from('membership').delete().eq('id', u.membershipId);
      await admin.from('profile').delete().eq('id', u.id);
      await admin.auth.admin.deleteUser(u.id);
    } catch (err) {
       
      console.warn(`Cleanup user ${u.email} failed: ${(err as Error).message}`);
    }
  }

  try {
    await admin.from('tenant').delete().eq('tenant_id', tenantId);
  } catch (err) {
     
    console.warn(`Cleanup tenant ${tenantId} failed: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct seeders (used by tests asserting RLS / rollback, not flow)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * INSERT a non-default env row pinned to a known version + commit SHA, for
 * tests that need a specific env state without a service layer in the way.
 *
 * There is no env-promotion saga and no `deployment` table. "Pinned" lives
 * directly on `environment`: `current_version` (a plain counter nothing
 * advances) + `current_commit_sha` (the live pointer — see
 * `52-environment.sql`).
 */
export async function seedPinnedEnvironment(
  fixture: EnvTestFixture,
  input: { name: string; version: number; commitSha: string; flyAppName?: string },
): Promise<Environment> {
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  // fly_app_name is bounded to 30 chars AND unique per tenant. Naively
  // `slice(0, 30)` truncates distinct env names (e.g. `casc-saga-a` vs
  // `casc-saga-b`) to the same prefix and collides on the unique index when
  // the combined string exceeds 30. Reserve the env-name suffix verbatim (it's
  // the distinguishing piece) and truncate the app-name prefix instead.
  const SUFFIX_BUDGET = 30 - 1 - input.name.length; // 1 char for '-'
  const flyAppName =
    input.flyAppName ??
    (SUFFIX_BUDGET > 0
      ? `${fixture.app.name.slice(0, SUFFIX_BUDGET)}-${input.name}`
      : input.name.slice(0, 30));

  // 1. INSERT the environment row.
  // Wrapped in retryOnTransientError to ride out Supabase's transient 502s, and
  // made idempotent (clear any prior same-(app_id,name) row first) so a retry
  // after a 502 that actually committed can't collide on
  // idx_environment_app_name_unique.
  const { data: envData, error: envError } = await retryOnTransientError(async () => {
    await admin
      .from('environment')
      .delete()
      .eq('app_id', fixture.app.id)
      .eq('name', input.name);
    return admin
      .from('environment')
      .insert({
        tenant_id: fixture.tenant.id,
        app_id: fixture.app.id,
        name: input.name,
        is_default: false,
        fly_app_name: flyAppName,
        created_by: fixture.ownerUser.id,
      })
      .select('*')
      .single();
  });

  if (envError || !envData) {
    throw new Error(
      `seedPinnedEnvironment(${input.name}) env insert failed: ${envError?.message}`,
    );
  }
  const env = envData as Record<string, unknown>;

  // 2. UPDATE environment to reflect the pinned version + commit directly —
  //    there is no saga row to go through anymore.
  const { data: updatedEnv, error: updateError } = await admin
    .from('environment')
    .update({
      current_version: input.version,
      current_commit_sha: input.commitSha,
    })
    .eq('id', env['id'] as string)
    .select('*')
    .single();

  if (updateError || !updatedEnv) {
    throw new Error(
      `seedPinnedEnvironment(${input.name}) env update failed: ${updateError?.message}`,
    );
  }
  return updatedEnv as unknown as Environment;
}

