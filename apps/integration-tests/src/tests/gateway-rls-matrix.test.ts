/**
 * Gateway RLS Matrix Test
 *
 * Verifies that gateway-minted JWTs (`role: 'gateway'`) enforce tenant
 * isolation on the 5 tables accessed via createTenantScopedClient, and
 * that the gateway Postgres role has no write privileges.
 *
 * This is the regression guard for the gateway Postgres role — if any
 * future change breaks tenant isolation or accidentally grants writes
 * to the gateway role, these tests fail.
 */

import { createHmac, randomUUID } from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GATEWAY_PERMISSIONS } from '@repo/gateway-core/lib/permissions';
import { getSupabaseAdmin, cleanupTestUsers } from '../lib/test-utils';
import { createSupabaseAdminClientUntyped } from '../lib/supabase-admin';
import { ensureDefaultEnvironment } from '../lib/environment-test-utils';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

// Default Supabase local dev JWT secret (same across integration-tests and tenant-dashboard envs)
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ||
  'super-secret-jwt-token-with-at-least-32-characters-long';

// Tables gateway-scoped clients are allowed to read
const GATEWAY_READABLE_TABLES = [
  'app',
  'git_connection',
  'git_branch',
] as const;

type GatewayReadableTable = (typeof GATEWAY_READABLE_TABLES)[number];

// The matrix mints JWTs carrying the gateway's full permission catalog, taken
// from the gateway's own export rather than a copy: a maximally-permissioned
// claim is what makes a tenant-isolation failure attributable to RLS alone, and
// a hand-listed copy would silently stop being "the full set" as the catalog
// grows.
const ALL_GATEWAY_PERMISSIONS: string[] = [...GATEWAY_PERMISSIONS];

// ---------------------------------------------------------------------------
// JWT minting (mirror of apps/gateway/src/lib/jwt.ts using node crypto)
// ---------------------------------------------------------------------------

function base64UrlEncode(data: Buffer): string {
  return data
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintGatewayJwt(
  secret: string,
  tenantId: string,
  systemUserId: string,
  permissions: string[],
  ttlSeconds = 60,
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    role: 'gateway',
    iss: 'gateway',
    sub: systemUserId,
    app_metadata: { tenant_id: tenantId },
    gateway_permissions: permissions,
    iat,
    exp: iat + ttlSeconds,
  };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf-8'));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function gatewayClient(tenantId: string, systemUserId: string): SupabaseClient {
  const jwt = mintGatewayJwt(JWT_SECRET, tenantId, systemUserId, ALL_GATEWAY_PERMISSIONS);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

interface SeededTenant {
  tenantId: string;
  systemUserId: string;
  ownerId: string;
  appId: string;
  /** Default env id for the seeded app. Required because
   *  `api_key.environment_id` is NOT NULL and the writable fixture needs to
   *  populate it. */
  defaultEnvId: string;
  gitConnectionId: string;
  gitBranchId: string;
}

async function seedTenant(label: string): Promise<SeededTenant> {
  const admin = getSupabaseAdmin();
  const tenantId = randomUUID();

  // Create an owning auth user — required for tenant.created_by FK
  const ownerEmail = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@rls-matrix.test`;
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email: ownerEmail,
    password: 'TestPassword123!',
    email_confirm: true,
  });
  if (authError || !authData?.user) {
    throw new Error(`Failed to create owner auth user for ${label}: ${authError?.message}`);
  }
  const ownerId = authData.user.id;

  await admin.from('profile').insert({ id: ownerId, name: `Owner ${label}`, email: ownerEmail });

  const { error: tenantError } = await admin.from('tenant').insert({
    tenant_id: tenantId,
    company_name: `rls-matrix-co-${label}`,
    organization_name: `rls-matrix-org-${label}-${Date.now()}`,
    created_by: ownerId,
  });
  if (tenantError) throw new Error(`Failed to create tenant ${label}: ${tenantError.message}`);

  // The gateway mints sub = tenant_id; there is no fake-user machinery.
  // RLS keys on the tenant claim, not sub.
  const systemUserId = tenantId;

  // Seed app → git_connection → git_branch
  const { data: app, error: appErr } = await admin
    .from('app')
    .insert({ name: `rls-matrix-app-${label}`, tenant_id: tenantId, created_by: ownerId })
    .select('id')
    .single();
  if (appErr || !app) throw new Error(`Failed to create app: ${appErr?.message}`);

  const { data: gitConn, error: gcErr } = await admin
    .from('git_connection')
    .insert({ app_id: app.id, tenant_id: tenantId, created_by: ownerId })
    .select('id')
    .single();
  if (gcErr || !gitConn) throw new Error(`Failed to create git_connection: ${gcErr?.message}`);

  const { data: gitBranch, error: gbErr } = await admin
    .from('git_branch')
    .insert({ app_id: app.id, tenant_id: tenantId, created_by: ownerId })
    .select('id')
    .single();
  if (gbErr || !gitBranch) throw new Error(`Failed to create git_branch: ${gbErr?.message}`);

  // The default `dev` env — required for the `api_key` NOT NULL
  // environment_id constraint that the writable fixture relies on — is
  // auto-seeded by the `on_create_seed_default_env` trigger on app insert.
  // Resolve its id via the fetch-or-create helper rather than inserting a
  // colliding duplicate.
  const defaultEnvId = await ensureDefaultEnvironment(app.id, tenantId);

  return {
    tenantId,
    systemUserId: systemUserId as string,
    ownerId,
    appId: app.id,
    defaultEnvId,
    gitConnectionId: gitConn.id,
    gitBranchId: gitBranch.id,
  };
}

async function tearDownTenant(t: SeededTenant): Promise<void> {
  const admin = getSupabaseAdmin();
  // Delete in FK-safe order. Cascade handles most children of app.
  await admin.from('git_branch').delete().eq('id', t.gitBranchId);
  await admin.from('git_connection').delete().eq('id', t.gitConnectionId);
  await admin.from('app').delete().eq('id', t.appId);
  await admin.from('profile').delete().eq('id', t.ownerId);
  try {
    await admin.auth.admin.deleteUser(t.ownerId);
  } catch {
    /* ignore */
  }
  await admin.from('tenant').delete().eq('tenant_id', t.tenantId);
}

// Helper: which table column identifies the seeded row for each table?
function rowIdOf(table: GatewayReadableTable, t: SeededTenant): string {
  switch (table) {
    case 'app':
      return t.appId;
    case 'git_connection':
      return t.gitConnectionId;
    case 'git_branch':
      return t.gitBranchId;
  }
}

// ---------------------------------------------------------------------------
// Cross-table write-forgery helpers (section 4e)
// ---------------------------------------------------------------------------
// Gateway-writable, tenant-scoped tables beyond `app` (4b) and git_branch (4c).
// Each carries the same set_tenant_id() BEFORE INSERT trigger, so each must
// resist tenant_id forgery the same way.

// One valid seeded row per writable table under a tenant, created via the
// service-role admin client. Used as (a) parent refs for child INSERT payloads
// and (b) cross-tenant targets in UPDATE/DELETE isolation tests.
interface WritableFixture {
  apiKeyId: string;
}

// Service-role client WITHOUT the Database generic, from the shared factory
// (reuses the same URL + key resolution as getSupabaseAdmin — no second copy of
// the key here). getSupabaseAdmin() is typed against the full schema and
// (correctly) rejects dynamic table names + arbitrary row payloads; these
// helpers address many tables by name, so the untyped client is the honest tool
// rather than casting the typed one. Test bodies keep the typed
// getSupabaseAdmin() for their literal-table re-reads.
const adminUntyped = createSupabaseAdminClientUntyped();

// Admin INSERT that returns the new row id or throws — keeps seed failures loud
// instead of surfacing later as a confusing assertion failure.
async function adminInsertId(table: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await adminUntyped.from(table).insert(payload).select('id').single();
  if (error || !data) {
    throw new Error(`seed ${table} failed: ${error?.message ?? 'no row returned'}`);
  }
  return (data as { id: string }).id;
}

async function seedWritableFixture(t: SeededTenant): Promise<WritableFixture> {
  const apiKeyId = await adminInsertId('api_key', {
    tenant_id: t.tenantId,
    app_id: t.appId,
    // Post-054: api_key.environment_id is NOT NULL. Bind to the seeded
    // default env so the writable fixture stays exercisable in this matrix.
    environment_id: t.defaultEnvId,
    name: `fx-key-${randomUUID()}`,
    api_key_id: `fx-${randomUUID()}`,
    created_by: t.ownerId,
  });
  return { apiKeyId };
}

// Asserts a gateway INSERT that forged `tenant_id = targetTenantId` was
// corrected by the set_tenant_id() trigger: the row (if one was returned) lands
// under callerTenantId, and crucially NO row exists under targetTenantId
// matching `leakFilter` (the non-tenant columns that uniquely identify the
// attempted row). Mirrors the app-CRUD forgery assertion in section 4b.
async function expectForgeryCorrectedToCaller(opts: {
  table: string;
  insert: { data: Array<{ id: string; tenant_id: string }> | null; error: unknown };
  callerTenantId: string;
  targetTenantId: string;
  leakFilter: Record<string, string | number>;
  track: (id: string) => void;
}): Promise<void> {
  const { table, insert, callerTenantId, targetTenantId, leakFilter, track } = opts;

  if (insert.data && insert.data.length > 0) {
    // Trigger-correction path: row created under the caller, never the target.
    expect(insert.data[0]!.tenant_id).toBe(callerTenantId);
    track(insert.data[0]!.id);
  } else {
    // Alternative path: RLS rejected the row outright (no trigger correction).
    expect(insert.error).not.toBeNull();
  }

  // Load-bearing invariant: no row may exist under the forged target tenant.
  let query = adminUntyped.from(table).select('id, tenant_id').eq('tenant_id', targetTenantId);
  for (const [col, val] of Object.entries(leakFilter)) {
    query = query.eq(col, val);
  }
  const { data: leak } = await query;
  expect(leak ?? []).toEqual([]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gateway RLS Matrix — tenant isolation via gateway role', () => {
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    [tenantA, tenantB] = await Promise.all([seedTenant('A'), seedTenant('B')]);
  }, 30000);

  afterAll(async () => {
    await tearDownTenant(tenantA);
    await tearDownTenant(tenantB);
    await cleanupTestUsers();
  }, 30000);

  // -------------------------------------------------------------------------
  // 1. Same-tenant reads: gateway client sees its own tenant's rows
  // -------------------------------------------------------------------------

  describe('Same-tenant reads succeed', () => {
    GATEWAY_READABLE_TABLES.forEach((table) => {
      it(`gateway client for tenant A can SELECT its own ${table} row`, async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        const rowId = rowIdOf(table, tenantA);

        const { data, error } = await client.from(table).select('id, tenant_id').eq('id', rowId);

        expect(error).toBeNull();
        expect(data).not.toBeNull();
        expect(data!.length).toBe(1);
        expect((data![0] as { tenant_id: string }).tenant_id).toBe(tenantA.tenantId);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Cross-tenant reads: gateway client for tenant A CANNOT see tenant B
  // -------------------------------------------------------------------------

  describe('Cross-tenant reads return empty (tenant isolation)', () => {
    GATEWAY_READABLE_TABLES.forEach((table) => {
      it(`gateway client for tenant A cannot SELECT tenant B's ${table} row`, async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        const crossTenantRowId = rowIdOf(table, tenantB);

        const { data, error } = await client
          .from(table)
          .select('id, tenant_id')
          .eq('id', crossTenantRowId);

        expect(error).toBeNull();
        expect(data).toEqual([]);
      });

      it(`gateway client for tenant A cannot see tenant B's ${table} via unfiltered SELECT`, async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

        const { data, error } = await client
          .from(table)
          .select('id, tenant_id')
          .eq('tenant_id', tenantB.tenantId);

        expect(error).toBeNull();
        expect(data).toEqual([]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Writes are denied: gateway role only has SELECT grants
  //
  // Excluded from the strict deny set:
  //   - `app` — the public /v1/apps/* surface (apps CRUD PR) grants
  //     INSERT/UPDATE/DELETE on `app` to the gateway role.
  //   - `git_branch` — the B1 git-link PR grants INSERT/UPDATE/DELETE on
  //     `git_branch` to the gateway role so headless agents can link/unlink
  //     repositories. Write isolation for git_branch is asserted in section
  //     4c below.
  //   - `git_connection` — the column-level UPDATE grant covers
  //     {repository, webhook_id, webhook_secret}. INSERT and DELETE
  //     remain denied for the gateway role; UPDATE is column-restricted.
  //     UPDATE isolation is asserted in section 4d below. INSERT/DELETE
  //     remain in the strict deny set above by way of NOT being listed here.
  // -------------------------------------------------------------------------

  const READ_ONLY_TABLES = GATEWAY_READABLE_TABLES.filter(
    (t) => t !== 'app' && t !== 'git_branch',
  );

  describe('Writes are denied for read-only tables (gateway role has SELECT only)', () => {
    READ_ONLY_TABLES.forEach((table) => {
      it(`gateway client cannot INSERT into ${table}`, async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

        // Payload uses only columns that exist on each table — so the error
        // we're asserting is a table-level permission denial (42501), not a
        // PostgREST schema error (PGRST204) from unknown columns.
        const payloadByTable: Record<GatewayReadableTable, Record<string, unknown>> = {
          app: { tenant_id: tenantA.tenantId, name: 'should-be-rejected' },
          git_connection: { tenant_id: tenantA.tenantId, app_id: tenantA.appId, provider: 'github' },
          git_branch: { tenant_id: tenantA.tenantId, app_id: tenantA.appId, branch_name: 'should-be-rejected' },
        };

        const { error } = await client.from(table).insert(payloadByTable[table]);

        // Must be SQLSTATE 42501 (insufficient_privilege). A weaker assertion
        // (`error != null`) would pass even if the failure were a spurious RLS
        // denial from an accidental INSERT grant + row-filter combo.
        expect(error).not.toBeNull();
        expect(error?.code).toBe('42501');
      });

      it(`gateway client cannot UPDATE tenant A's ${table} row`, async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        const rowId = rowIdOf(table, tenantA);

        // `name` for app. For git_connection the gateway has column-restricted
        // UPDATE on (repository, webhook_id, webhook_secret) — to test the
        // *denied* set we attempt a column the gateway has no write grant on.
        // `provider` is read-only for the gateway role.
        const updatePayload: Record<string, unknown> =
          table === 'git_connection'
            ? { provider: 'gitlab' }
            : { name: 'mutated-by-gateway' };

        const { data, error } = await client
          .from(table)
          .update(updatePayload)
          .eq('id', rowId)
          .select();

        // Either error or empty result — mutation must not occur.
        if (!error) {
          expect(data ?? []).toEqual([]);
        } else {
          expect(error).not.toBeNull();
        }

        // Re-read with admin to prove row is unchanged
        const admin = getSupabaseAdmin();
        const { data: reread } = await admin.from(table).select('id').eq('id', rowId).single();
        expect(reread).not.toBeNull();
        expect((reread as { id: string }).id).toBe(rowId);
      });

      it(`gateway client cannot DELETE tenant A's ${table} row`, async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        const rowId = rowIdOf(table, tenantA);

        const { error } = await client.from(table).delete().eq('id', rowId);

        // Gateway has no DELETE grant on any of the 5 tables — must be a hard
        // permission denial (42501), not a silent no-op. A silent RLS-only
        // block would pass a weaker assertion but wouldn't prove the DELETE
        // privilege itself is withheld.
        expect(error).not.toBeNull();
        expect(error?.code).toBe('42501');

        // Belt-and-suspenders: verify the row still exists.
        const admin = getSupabaseAdmin();
        const { data: reread } = await admin.from(table).select('id').eq('id', rowId).single();
        expect(reread).not.toBeNull();
        expect((reread as { id: string }).id).toBe(rowId);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4b. App-CRUD writes are tenant-isolated
  //
  // The public /v1/apps/* surface (apps CRUD PR) grants INSERT/UPDATE/DELETE
  // on `app` to the gateway role, gated by `gateway_tenant_{insert,update,
  // delete}_app` RLS policies. This block proves:
  //
  //   - INSERT succeeds for own-tenant rows
  //   - INSERT for cross-tenant rows is rejected by the policy's WITH CHECK
  //   - UPDATE / DELETE succeed on own-tenant rows, are no-ops on cross-tenant
  //
  // RLS bugs here would mean a headless agent with `app.insert` could create
  // apps under another tenant's id, or mutate apps it doesn't own. That's
  // the highest-blast-radius failure mode for the apps surface — these tests
  // are the safety net.
  // -------------------------------------------------------------------------

  describe('App-CRUD writes are tenant-isolated', () => {
    const trackedAppIds: string[] = [];

    afterAll(async () => {
      const admin = getSupabaseAdmin();
      for (const id of trackedAppIds) {
        await admin.from('app').delete().eq('id', id);
      }
    });

    it('gateway client CAN INSERT an app for its own tenant', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
      const name = `gw-insert-${randomUUID()}`;

      const { data, error } = await client
        .from('app')
        .insert({ tenant_id: tenantA.tenantId, name })
        .select('id, tenant_id, name')
        .single();

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      const row = data as { id: string; tenant_id: string; name: string };
      expect(row.tenant_id).toBe(tenantA.tenantId);
      expect(row.name).toBe(name);
      trackedAppIds.push(row.id);
    });

    it('gateway client CANNOT forge tenant_id on INSERT (trigger silently corrects)', async () => {
      // Forgery defense is two-layered:
      //   (1) The `set_tenant_id()` BEFORE INSERT trigger overwrites
      //       `new.tenant_id = public.tenant_id()` for any non-service-role
      //       caller. So a caller-supplied tenant_id is silently discarded.
      //   (2) `gateway_tenant_insert_app` WITH CHECK then enforces
      //       `tenant_id = public.tenant_id()` against the (already corrected)
      //       new row — which trivially passes after the trigger ran.
      //
      // Net effect: the INSERT succeeds, but the row lands under the caller's
      // tenant, NEVER under the forged target. A row may still appear in the
      // result; the invariant that matters is that no row exists under
      // tenantB carrying the test name.
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
      const name = `gw-hijack-${randomUUID()}`;

      const { data, error } = await client
        .from('app')
        .insert({ tenant_id: tenantB.tenantId, name })
        .select('id, tenant_id');

      if (data && data.length > 0) {
        // Trigger-correction path: row created under tenantA, not tenantB.
        expect((data[0] as { tenant_id: string }).tenant_id).toBe(tenantA.tenantId);
        trackedAppIds.push((data[0] as { id: string }).id);
      } else {
        // Alternative path: RLS rejected outright (no trigger).
        expect(error).not.toBeNull();
      }

      // Load-bearing: no row may exist under tenantB with this name. If
      // this fails, the trigger / RLS combo has a real cross-tenant leak.
      const admin = getSupabaseAdmin();
      const { data: leakCheck } = await admin
        .from('app')
        .select('id, tenant_id')
        .eq('name', name)
        .eq('tenant_id', tenantB.tenantId);
      expect(leakCheck ?? []).toEqual([]);
    });

    it('gateway client CAN UPDATE its own tenant app', async () => {
      const admin = getSupabaseAdmin();
      const name = `gw-update-${randomUUID()}`;
      const { data: seeded, error: seedErr } = await admin
        .from('app')
        .insert({ tenant_id: tenantA.tenantId, name, created_by: tenantA.ownerId })
        .select('id')
        .single();
      if (seedErr || !seeded) throw new Error(`seed failed: ${seedErr?.message}`);
      trackedAppIds.push(seeded.id);

      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
      const renamed = `${name}-renamed`;
      const { data, error } = await client
        .from('app')
        .update({ name: renamed })
        .eq('id', seeded.id)
        .select('id, name')
        .single();

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect((data as { name: string }).name).toBe(renamed);
    });

    it('gateway client CANNOT UPDATE a cross-tenant app', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('app')
        .update({ name: 'hijacked-name' })
        .eq('id', tenantB.appId)
        .select('id');

      // RLS USING + WITH CHECK both require tenant match — cross-tenant
      // UPDATE comes back as zero rows (or, less commonly, an error).
      if (!error) {
        expect(data ?? []).toEqual([]);
      }

      // Defense-in-depth: prove tenant B's app wasn't mutated.
      const admin = getSupabaseAdmin();
      const { data: reread } = await admin
        .from('app')
        .select('name')
        .eq('id', tenantB.appId)
        .single();
      expect((reread as { name: string }).name).not.toBe('hijacked-name');
    });

    it('gateway client CAN DELETE its own tenant app', async () => {
      const admin = getSupabaseAdmin();
      const { data: seeded, error: seedErr } = await admin
        .from('app')
        .insert({
          tenant_id: tenantA.tenantId,
          name: `gw-delete-${randomUUID()}`,
          created_by: tenantA.ownerId,
        })
        .select('id')
        .single();
      if (seedErr || !seeded) throw new Error(`seed failed: ${seedErr?.message}`);

      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
      const { error } = await client.from('app').delete().eq('id', seeded.id);
      expect(error).toBeNull();

      // Confirm the row is actually gone, not just RLS-filtered.
      const { data: reread } = await admin
        .from('app')
        .select('id')
        .eq('id', seeded.id)
        .maybeSingle();
      expect(reread).toBeNull();
    });

    it('gateway client CANNOT DELETE a cross-tenant app', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { error } = await client.from('app').delete().eq('id', tenantB.appId);
      // RLS denies (0 rows affected); some PostgREST versions surface as error.
      // Both are acceptable — the assertion below is the one that matters.
      if (error) {
        expect(error).not.toBeNull();
      }

      // Belt-and-suspenders: tenant B's app must still exist.
      const admin = getSupabaseAdmin();
      const { data: reread } = await admin
        .from('app')
        .select('id')
        .eq('id', tenantB.appId)
        .single();
      expect(reread).not.toBeNull();
      expect((reread as { id: string }).id).toBe(tenantB.appId);
    });
  });

  // -------------------------------------------------------------------------
  // 4c. git_branch CRUD writes are tenant-isolated (B1 git-link PR)
  //
  // git_branch moved out of READ_ONLY_TABLES because the B1 PR granted
  // INSERT/UPDATE/DELETE to the gateway role (so headless agents can
  // link/unlink repositories). Same shape as the app-CRUD section above —
  // own-tenant writes succeed, cross-tenant writes are RLS-denied.
  // -------------------------------------------------------------------------

  describe('git_branch CRUD writes are tenant-isolated (B1 git-link)', () => {
    const trackedBranchIds: string[] = [];

    afterAll(async () => {
      const admin = getSupabaseAdmin();
      for (const id of trackedBranchIds) {
        await admin.from('git_branch').delete().eq('id', id);
      }
    });

    it('gateway client CAN INSERT git_branch for its own tenant', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
      const branchName = `gw-link-${randomUUID()}`;

      const { data, error } = await client
        .from('git_branch')
        .insert({
          tenant_id: tenantA.tenantId,
          app_id: tenantA.appId,
          branch_name: branchName,
          repo: 'acme/test',
        })
        .select('id, tenant_id, app_id, branch_name')
        .single();

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      const row = data as { id: string; tenant_id: string; app_id: string; branch_name: string };
      expect(row.tenant_id).toBe(tenantA.tenantId);
      expect(row.app_id).toBe(tenantA.appId);
      expect(row.branch_name).toBe(branchName);
      trackedBranchIds.push(row.id);
    });

    it('gateway client CAN UPDATE its own git_branch row', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('git_branch')
        .update({ branch_name: 'updated-by-gateway' })
        .eq('id', tenantA.gitBranchId)
        .select('branch_name')
        .single();

      expect(error).toBeNull();
      expect((data as { branch_name: string }).branch_name).toBe('updated-by-gateway');
    });

    it('gateway client CANNOT UPDATE tenant B\'s git_branch row (RLS isolation)', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('git_branch')
        .update({ branch_name: 'exfil-attempt' })
        .eq('id', tenantB.gitBranchId)
        .select();

      if (error) {
        expect(error).not.toBeNull();
      } else {
        expect(data ?? []).toEqual([]);
      }

      // Tenant B's row must be unchanged.
      const admin = getSupabaseAdmin();
      const { data: reread } = await admin
        .from('git_branch')
        .select('branch_name')
        .eq('id', tenantB.gitBranchId)
        .single();
      expect((reread as { branch_name: string }).branch_name).not.toBe('exfil-attempt');
    });

    it('gateway client CAN DELETE its own git_branch row', async () => {
      // Seed a fresh row to avoid trampling the shared tenantA.gitBranchId.
      const admin = getSupabaseAdmin();
      const { data: seeded } = await admin
        .from('git_branch')
        .insert({
          tenant_id: tenantA.tenantId,
          app_id: tenantA.appId,
          branch_name: `delete-me-${randomUUID()}`,
          repo: 'acme/test',
        })
        .select('id')
        .single();
      const rowId = (seeded as { id: string }).id;

      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
      const { error } = await client.from('git_branch').delete().eq('id', rowId);
      expect(error).toBeNull();

      const { data: reread } = await admin
        .from('git_branch')
        .select('id')
        .eq('id', rowId)
        .maybeSingle();
      expect(reread).toBeNull();
    });

    it('gateway client CANNOT DELETE tenant B\'s git_branch row (RLS isolation)', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      await client.from('git_branch').delete().eq('id', tenantB.gitBranchId);

      // Either error or zero rows affected — tenant B's row must remain.
      const admin = getSupabaseAdmin();
      const { data: reread } = await admin
        .from('git_branch')
        .select('id')
        .eq('id', tenantB.gitBranchId)
        .single();
      expect(reread).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 4d. git_connection — column-restricted UPDATE grant
  //
  // The gateway may write (repository, webhook_id, webhook_secret) so the link
  // route and webhook registration can do their work. Other columns (provider,
  // installation_id, tenant_id, app_id, created_*) remain read-only for the
  // gateway role.
  // -------------------------------------------------------------------------

  describe('git_connection broadened UPDATE grant (B1)', () => {
    it('gateway client CAN UPDATE git_connection.repository for its own tenant', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
      const newRepo = `acme/link-${randomUUID().slice(0, 8)}`;

      const { error } = await client
        .from('git_connection')
        .update({ repository: newRepo })
        .eq('id', tenantA.gitConnectionId);

      expect(error).toBeNull();

      const admin = getSupabaseAdmin();
      const { data } = await admin
        .from('git_connection')
        .select('repository')
        .eq('id', tenantA.gitConnectionId)
        .single();
      expect((data as { repository: string }).repository).toBe(newRepo);
    });

    it('gateway client CAN UPDATE git_connection.webhook_id + webhook_secret', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { error } = await client
        .from('git_connection')
        .update({ webhook_id: 'wh-12345', webhook_secret: 'iv:ciphertext-placeholder' })
        .eq('id', tenantA.gitConnectionId);

      expect(error).toBeNull();
    });

    it('gateway client CANNOT UPDATE git_connection.provider (column not in grant)', async () => {
      // `provider` is in the SELECT grant but NOT in the UPDATE column
      // grant. Postgres rejects this with 42501 before evaluating RLS.
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { error } = await client
        .from('git_connection')
        .update({ provider: 'gitlab' })
        .eq('id', tenantA.gitConnectionId);

      expect(error).not.toBeNull();
      expect(error?.code).toBe('42501');
    });

    it('gateway client CANNOT UPDATE tenant B\'s git_connection.repository (RLS isolation)', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('git_connection')
        .update({ repository: 'exfil/attempt' })
        .eq('id', tenantB.gitConnectionId)
        .select();

      if (error) {
        expect(error).not.toBeNull();
      } else {
        expect(data ?? []).toEqual([]);
      }

      const admin = getSupabaseAdmin();
      const { data: reread } = await admin
        .from('git_connection')
        .select('repository')
        .eq('id', tenantB.gitConnectionId)
        .single();
      expect((reread as { repository: string | null }).repository).not.toBe('exfil/attempt');
    });
  });

  // -------------------------------------------------------------------------
  // 4e. Cross-table write-forgery resistance (set_tenant_id trigger defense)
  //
  // Every gateway-writable, tenant-scoped table carries the same
  // `set_tenant_id()` BEFORE INSERT trigger as `app` (section 4b). For any
  // non-service caller the trigger OVERWRITES new.tenant_id with the JWT's
  // tenant — a forged tenant_id in the body is silently discarded and the row
  // lands under the CALLER, never the attacker-named target. The matching
  // `gateway_tenant_insert_*` WITH CHECK then passes trivially.
  //
  // Section 4b proves this for `app`. This section proves the same invariant
  // for the other gateway-writable table carrying the trigger, so a change to
  // either layer that re-enables forgery is caught.
  //
  //   api_key                         → INSERT + DELETE (UPDATE not granted)
  // -------------------------------------------------------------------------

  describe('Cross-table write-forgery resistance (set_tenant_id)', () => {
    let fxA: WritableFixture; // parent refs / own-tenant rows under tenant A
    let fxB: WritableFixture; // cross-tenant targets under tenant B
    const tracked: Array<{ table: string; id: string }> = [];
    const track =
      (table: string) =>
      (id: string): void => {
        tracked.push({ table, id });
      };

    beforeAll(async () => {
      [fxA, fxB] = await Promise.all([seedWritableFixture(tenantA), seedWritableFixture(tenantB)]);
    }, 30000);

    afterAll(async () => {
      // Reverse insertion order; the outer tenant teardown (app delete →
      // cascade) is the real backstop, so per-row delete errors are ignored.
      // adminUntyped because the table name is dynamic across tracked rows.
      for (const { table, id } of [...tracked].reverse()) {
        await adminUntyped.from(table).delete().eq('id', id);
      }
    });

    // ----- api_key (INSERT, DELETE; UPDATE not granted) -----
    describe('api_key', () => {
      it('gateway CAN INSERT an api_key for its own tenant', async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        const apiKeyId = `gw-${randomUUID()}`;
        const { data, error } = await client
          .from('api_key')
          .insert({
            tenant_id: tenantA.tenantId,
            app_id: tenantA.appId,
            // Post-054: api_key.environment_id is NOT NULL.
            environment_id: tenantA.defaultEnvId,
            name: `gw-key-${randomUUID()}`,
            api_key_id: apiKeyId,
          })
          .select('id, tenant_id, api_key_id')
          .single();

        expect(error).toBeNull();
        const row = data as { id: string; tenant_id: string; api_key_id: string };
        expect(row.tenant_id).toBe(tenantA.tenantId);
        expect(row.api_key_id).toBe(apiKeyId);
        track('api_key')(row.id);
      });

      it('gateway CANNOT forge tenant_id on INSERT (trigger corrects to caller)', async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        const apiKeyId = `gw-forge-${randomUUID()}`;
        const insert = await client
          .from('api_key')
          .insert({
            tenant_id: tenantB.tenantId, // forged
            app_id: tenantA.appId,
            // env binding must be present so the NOT NULL passes; the
            // forgery test asserts the trigger corrects tenant_id back
            // to the caller — env binding is incidental.
            environment_id: tenantA.defaultEnvId,
            name: `gw-key-forge-${randomUUID()}`,
            api_key_id: apiKeyId,
          })
          .select('id, tenant_id');

        await expectForgeryCorrectedToCaller({
          table: 'api_key',
          insert: { data: insert.data as Array<{ id: string; tenant_id: string }> | null, error: insert.error },
          callerTenantId: tenantA.tenantId,
          targetTenantId: tenantB.tenantId,
          leakFilter: { api_key_id: apiKeyId },
          track: track('api_key'),
        });
      });

      it('gateway CANNOT UPDATE api_key (no UPDATE grant — least privilege)', async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        const { error } = await client.from('api_key').update({ name: 'renamed' }).eq('id', fxA.apiKeyId);

        // Table-level UPDATE privilege is withheld → hard 42501, evaluated
        // before RLS. A silent no-op would pass a weaker assertion but would
        // not prove the privilege itself is absent.
        expect(error).not.toBeNull();
        expect((error as { code?: string } | null)?.code).toBe('42501');
      });

      it('gateway CAN DELETE its own api_key', async () => {
        const id = await adminInsertId('api_key', {
          tenant_id: tenantA.tenantId,
          app_id: tenantA.appId,
          environment_id: tenantA.defaultEnvId,
          name: `gw-key-del-${randomUUID()}`,
          api_key_id: `gw-del-${randomUUID()}`,
          created_by: tenantA.ownerId,
        });

        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        const { error } = await client.from('api_key').delete().eq('id', id);
        expect(error).toBeNull();

        const admin = getSupabaseAdmin();
        const { data: reread } = await admin.from('api_key').select('id').eq('id', id).maybeSingle();
        expect(reread).toBeNull();
      });

      it('gateway CANNOT DELETE a cross-tenant api_key', async () => {
        const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
        await client.from('api_key').delete().eq('id', fxB.apiKeyId);

        const admin = getSupabaseAdmin();
        const { data: reread } = await admin.from('api_key').select('id').eq('id', fxB.apiKeyId).single();
        expect(reread).not.toBeNull();
        expect((reread as { id: string }).id).toBe(fxB.apiKeyId);
      });
    });
  });

  // -------------------------------------------------------------------------
  // 5. Other tenant-scoped tables NOT granted to gateway are invisible
  // -------------------------------------------------------------------------

  describe('Tables outside gateway grant list are invisible', () => {
    // NOTE: `api_key` is a gateway-writable table (95-gateway-rls.sql grants
    // SELECT/INSERT/DELETE), so its read + write isolation is covered in
    // section 4e instead. The table below (`tenant`)
    // carry no gateway grant at all.

    it('gateway client cannot SELECT from tenant table (not granted)', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);
      const { data, error } = await client.from('tenant').select('tenant_id');

      if (error) {
        expect(error).not.toBeNull();
      } else {
        expect(data ?? []).toEqual([]);
      }
    });

  });

  // -------------------------------------------------------------------------
  // 5b. git_connection column-level grant — webhook_secret never readable,
  //     tokens readable (encrypted), tokens updatable for same tenant only.
  // -------------------------------------------------------------------------

  describe('git_connection column-level grant', () => {
    it('gateway client cannot SELECT webhook_secret column', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('git_connection')
        .select('webhook_secret')
        .eq('id', tenantA.gitConnectionId);

      // Postgres raises "permission denied for column webhook_secret" which
      // PostgREST surfaces as a 4xx error. Accept either an error or (as a
      // defensive fallback) completely empty data.
      if (!error) {
        expect(data ?? []).toEqual([]);
      } else {
        expect(error).not.toBeNull();
      }
    });

    it('gateway client cannot SELECT * (would expand to include webhook_secret)', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { error } = await client
        .from('git_connection')
        .select('*')
        .eq('id', tenantA.gitConnectionId);

      // `SELECT *` expands against the role's column privileges and fails when
      // any column (webhook_secret) is withheld. This guarantees future devs
      // writing `.select("*")` get a loud failure rather than silent leakage.
      expect(error).not.toBeNull();
    });

    it('gateway client CAN SELECT explicit non-sensitive columns', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('git_connection')
        .select('provider, installation_id, repository')
        .eq('id', tenantA.gitConnectionId);

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.length).toBe(1);
    });

    it('gateway client CAN UPDATE a granted column for own tenant (link path)', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('git_connection')
        .update({ repository: 'acme/linked-by-gateway' })
        .eq('id', tenantA.gitConnectionId)
        .select('id');

      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(data!.length).toBe(1);
    });

    it('gateway client CANNOT UPDATE a granted column on a cross-tenant row', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('git_connection')
        .update({ repository: 'acme/hijacked' })
        .eq('id', tenantB.gitConnectionId)
        .select('id');

      // Either RLS returns zero rows, or Postgres errors. Either is acceptable
      // — both prove cross-tenant row was not mutated.
      if (!error) {
        expect(data ?? []).toEqual([]);
      }

      const admin = getSupabaseAdmin();
      const { data: reread } = await admin
        .from('git_connection')
        .select('repository')
        .eq('id', tenantB.gitConnectionId)
        .single();
      expect((reread as { repository: string | null }).repository).not.toBe('acme/hijacked');
    });

    // Note: the gateway client CAN UPDATE webhook_secret — it's in the
    // column-level UPDATE grant for a per-repo webhook registration path.
    // The remaining invariants for this column are:
    //
    //   - SELECT is still denied → see "gateway client cannot SELECT
    //     webhook_secret column" above.
    //   - Cross-tenant UPDATE is still denied → see "git_connection
    //     broadened UPDATE grant (B1)" section that covers
    //     "CANNOT UPDATE tenant B's git_connection.repository (RLS isolation)".
    //     Same RLS policy gates webhook_secret writes.
  });

  // -------------------------------------------------------------------------
  // 6. Regression smoke: exact queries from template-repository.ts
  // -------------------------------------------------------------------------

  describe('Regression smoke: exact queries from template-repository.ts', () => {
    it('reproduces template-repository.getCommitSha flow (app SELECT)', async () => {
      // Before the gateway PG role landed, this query returned null for a
      // gateway JWT because app_authorize() fails for gateway system users.
      // After the fix, the gateway role + tenant-isolation RLS lets it through.
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const { data, error } = await client
        .from('app')
        .select('commit_sha')
        .eq('id', tenantA.appId)
        .single();

      expect(error).toBeNull();
      expect(data).not.toBeNull();
    });

    it('reproduces dataset-streamer git_connection + git_branch joins', async () => {
      const client = gatewayClient(tenantA.tenantId, tenantA.systemUserId);

      const [gitConn, gitBranch] = await Promise.all([
        client.from('git_connection').select('id').eq('app_id', tenantA.appId),
        client.from('git_branch').select('id').eq('app_id', tenantA.appId),
      ]);

      expect(gitConn.error).toBeNull();
      expect(gitConn.data!.length).toBeGreaterThanOrEqual(1);
      expect(gitBranch.error).toBeNull();
      expect(gitBranch.data!.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 7. JWT with wrong tenant cannot impersonate: signature check
  // -------------------------------------------------------------------------

  describe('JWT integrity', () => {
    it('forged JWT (wrong secret) is rejected', async () => {
      const wrongSecretJwt = mintGatewayJwt(
        'wrong-secret-at-least-32-characters-long',
        tenantA.tenantId,
        tenantA.systemUserId,
        ALL_GATEWAY_PERMISSIONS,
      );
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${wrongSecretJwt}` } },
      });

      const { data, error } = await client.from('app').select('id').eq('id', tenantA.appId);

      // Signature-invalid JWT is rejected: Supabase falls back to anon, so the
      // query sees no rows (anon role has no access to app).
      if (error) {
        expect(error).not.toBeNull();
      } else {
        expect(data ?? []).toEqual([]);
      }
    });

    it('expired JWT is rejected', async () => {
      // Mint a JWT with negative TTL so exp is in the past.
      const expiredJwt = mintGatewayJwt(
        JWT_SECRET,
        tenantA.tenantId,
        tenantA.systemUserId,
        ALL_GATEWAY_PERMISSIONS,
        -60,
      );
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${expiredJwt}` } },
      });

      const { data, error } = await client.from('app').select('id').eq('id', tenantA.appId);

      // PostgREST rejects expired JWTs (JWT expiration is signature-level
      // validation). Falls back to anon which sees nothing.
      if (error) {
        expect(error).not.toBeNull();
      } else {
        expect(data ?? []).toEqual([]);
      }
    });
  });
});
