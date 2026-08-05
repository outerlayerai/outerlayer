/**
 * Gateway RLS — worker_run / worker_workspace.
 *
 * The /v1/workers routes access these tables through gateway-minted JWTs
 * (`role: 'gateway'`), guarded by the `gateway_tenant_*` policies from
 * `95-gateway-rls.sql`. This suite is the isolation proof for that grant
 * family: SELECT/INSERT/UPDATE are tenant-fenced, DELETE is not granted at
 * all, and `worker_run_event` (transcripts) is deliberately invisible to the
 * gateway role — the API returns dashboard deep links instead of event rows.
 *
 * One deliberate divergence from the tables in gateway-rls-matrix.test.ts:
 * the worker tables carry NO `set_tenant_id()` BEFORE INSERT trigger, so a
 * forged `tenant_id` is not silently corrected to the caller — the policy's
 * WITH CHECK rejects the row outright (42501). Strictly safe (nothing lands
 * anywhere); these tests pin the reject behavior so a future trigger addition
 * or policy relaxation shows up as a diff here.
 */

import { createHmac, randomUUID } from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin, cleanupTestUsers } from '../../lib/test-utils';
import { createSupabaseAdminClientUntyped } from '../../lib/supabase-admin';

// ---------------------------------------------------------------------------
// Config (same resolution as gateway-rls-matrix.test.ts)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ||
  'super-secret-jwt-token-with-at-least-32-characters-long';

// The permission set an actual workers API key carries.
const WORKER_PERMISSIONS = ['worker_run.read', 'worker_run.insert'];

// ---------------------------------------------------------------------------
// JWT minting (mirror of apps/gateway/src/lib/jwt.ts using node crypto)
// ---------------------------------------------------------------------------

function base64UrlEncode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mintGatewayJwt(secret: string, tenantId: string, ttlSeconds = 60): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    role: 'gateway',
    iss: 'gateway',
    sub: tenantId,
    app_metadata: { tenant_id: tenantId },
    gateway_permissions: WORKER_PERMISSIONS,
    iat,
    exp: iat + ttlSeconds,
  };
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf-8'));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function gatewayClient(tenantId: string): SupabaseClient {
  const jwt = mintGatewayJwt(JWT_SECRET, tenantId);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

// worker_run / worker_workspace aren't in the generated Database types yet
// (same posture as the gateway store) — the untyped admin client is the
// honest tool for seeding and re-reads on those tables.
const adminUntyped = createSupabaseAdminClientUntyped();

interface SeededTenant {
  tenantId: string;
  ownerId: string;
  appId: string;
  runId: string;
  envId: string;
}

async function adminInsertId(table: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await adminUntyped.from(table).insert(payload).select('id').single();
  if (error || !data) {
    throw new Error(`seed ${table} failed: ${error?.message ?? 'no row returned'}`);
  }
  return (data as { id: string }).id;
}

async function seedTenant(label: string): Promise<SeededTenant> {
  const admin = getSupabaseAdmin();
  const tenantId = randomUUID();

  const ownerEmail = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@worker-rls.test`;
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
    company_name: `worker-rls-co-${label}`,
    organization_name: `worker-rls-org-${label}-${Date.now()}`,
    created_by: ownerId,
  });
  if (tenantError) throw new Error(`Failed to create tenant ${label}: ${tenantError.message}`);

  const { data: app, error: appErr } = await admin
    .from('app')
    .insert({ name: `worker-rls-app-${label}`, tenant_id: tenantId, created_by: ownerId })
    .select('id')
    .single();
  if (appErr || !app) throw new Error(`Failed to create app: ${appErr?.message}`);

  // One run + one environment per tenant, shaped like the gateway store's own
  // inserts (created_by NULL = key-attributed).
  const runId = await adminInsertId('worker_run', {
    tenant_id: tenantId,
    app_id: app.id,
    created_by: null,
    agent: 'claude-code',
    task_prompt: `seed run ${label}`,
    status: 'queued',
  });
  const envId = await adminInsertId('worker_workspace', {
    tenant_id: tenantId,
    app_id: app.id,
    agent: 'claude-code',
    work_branch: `outerlayer/worker/rls-${label}`,
    substrate: 'fly',
    status: 'active',
  });

  return { tenantId, ownerId, appId: app.id, runId, envId };
}

async function tearDownTenant(t: SeededTenant): Promise<void> {
  const admin = getSupabaseAdmin();
  await adminUntyped.from('worker_run').delete().eq('tenant_id', t.tenantId);
  await adminUntyped.from('worker_workspace').delete().eq('tenant_id', t.tenantId);
  await admin.from('app').delete().eq('id', t.appId);
  await admin.from('profile').delete().eq('id', t.ownerId);
  try {
    await admin.auth.admin.deleteUser(t.ownerId);
  } catch {
    /* ignore */
  }
  await admin.from('tenant').delete().eq('tenant_id', t.tenantId);
}

const WORKER_TABLES = ['worker_run', 'worker_workspace'] as const;
type WorkerTable = (typeof WORKER_TABLES)[number];

function rowIdOf(table: WorkerTable, t: SeededTenant): string {
  return table === 'worker_run' ? t.runId : t.envId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gateway RLS — worker tables', () => {
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
  // Reads
  // -------------------------------------------------------------------------

  describe('reads are tenant-fenced', () => {
    WORKER_TABLES.forEach((table) => {
      it(`gateway client for tenant A can SELECT its own ${table} row`, async () => {
        const client = gatewayClient(tenantA.tenantId);
        const { data, error } = await client
          .from(table)
          .select('id, tenant_id')
          .eq('id', rowIdOf(table, tenantA));

        expect(error).toBeNull();
        expect(data).toEqual([{ id: rowIdOf(table, tenantA), tenant_id: tenantA.tenantId }]);
      });

      it(`gateway client for tenant A cannot SELECT tenant B's ${table} row by id`, async () => {
        const client = gatewayClient(tenantA.tenantId);
        const { data, error } = await client
          .from(table)
          .select('id')
          .eq('id', rowIdOf(table, tenantB));

        expect(error).toBeNull();
        expect(data).toEqual([]);
      });

      it(`gateway client for tenant A cannot enumerate tenant B's ${table} rows`, async () => {
        const client = gatewayClient(tenantA.tenantId);
        const { data, error } = await client
          .from(table)
          .select('id')
          .eq('tenant_id', tenantB.tenantId);

        expect(error).toBeNull();
        expect(data).toEqual([]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Inserts (the launch / create-session write path)
  // -------------------------------------------------------------------------

  describe('inserts land under the caller tenant only', () => {
    const tracked: Array<{ table: WorkerTable; id: string }> = [];

    afterAll(async () => {
      for (const { table, id } of tracked) {
        await adminUntyped.from(table).delete().eq('id', id);
      }
    });

    it('gateway CAN INSERT a worker_run for its own tenant (key-attributed shape)', async () => {
      const client = gatewayClient(tenantA.tenantId);
      const prompt = `gw-run-${randomUUID()}`;

      const { data, error } = await client
        .from('worker_run')
        .insert({
          tenant_id: tenantA.tenantId,
          app_id: tenantA.appId,
          created_by: null,
          agent: 'claude-code',
          task_prompt: prompt,
          status: 'queued',
        })
        .select('id, tenant_id, created_by, status')
        .single();

      expect(error).toBeNull();
      const row = data as { id: string; tenant_id: string; created_by: null; status: string };
      expect(row.tenant_id).toBe(tenantA.tenantId);
      expect(row.created_by).toBeNull();
      expect(row.status).toBe('queued');
      tracked.push({ table: 'worker_run', id: row.id });
    });

    it('gateway CAN INSERT a worker_workspace for its own tenant', async () => {
      const client = gatewayClient(tenantA.tenantId);

      const { data, error } = await client
        .from('worker_workspace')
        .insert({
          tenant_id: tenantA.tenantId,
          app_id: tenantA.appId,
          agent: 'claude-code',
          substrate: 'fly',
          status: 'creating',
        })
        .select('id, tenant_id')
        .single();

      expect(error).toBeNull();
      const row = data as { id: string; tenant_id: string };
      expect(row.tenant_id).toBe(tenantA.tenantId);
      tracked.push({ table: 'worker_workspace', id: row.id });
    });

    WORKER_TABLES.forEach((table) => {
      it(`gateway CANNOT forge tenant_id on ${table} INSERT (WITH CHECK rejects outright)`, async () => {
        // No set_tenant_id trigger on the worker tables — unlike the matrix
        // tables there is no silent correction; the policy's WITH CHECK must
        // reject the row hard.
        const client = gatewayClient(tenantA.tenantId);
        const marker = `gw-forge-${randomUUID()}`;
        const forged = {
          tenant_id: tenantB.tenantId, // forged
          app_id: tenantA.appId,
          agent: 'claude-code',
        };

        const { data, error } =
          table === 'worker_run'
            ? await client.from('worker_run').insert({ ...forged, task_prompt: marker }).select('id')
            : await client.from('worker_workspace').insert({ ...forged, work_branch: marker }).select('id');

        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error?.code).toBe('42501');

        // Load-bearing: nothing landed under EITHER tenant with the marker.
        const markerCol = table === 'worker_run' ? 'task_prompt' : 'work_branch';
        const { data: leak } = await adminUntyped.from(table).select('id').eq(markerCol, marker);
        expect(leak ?? []).toEqual([]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Updates (dispatch transitions + the single-turn lock)
  // -------------------------------------------------------------------------

  describe('updates are tenant-fenced', () => {
    it('gateway CAN UPDATE its own worker_run (status transition)', async () => {
      const client = gatewayClient(tenantA.tenantId);
      const { data, error } = await client
        .from('worker_run')
        .update({ status: 'provisioning' })
        .eq('id', tenantA.runId)
        .select('status')
        .single();

      expect(error).toBeNull();
      expect((data as { status: string }).status).toBe('provisioning');
    });

    it('gateway CAN UPDATE its own worker_workspace (lock acquire/release shape)', async () => {
      const client = gatewayClient(tenantA.tenantId);
      const { data, error } = await client
        .from('worker_workspace')
        .update({ current_run_id: tenantA.runId, status: 'active' })
        .eq('id', tenantA.envId)
        .select('current_run_id')
        .single();

      expect(error).toBeNull();
      expect((data as { current_run_id: string }).current_run_id).toBe(tenantA.runId);

      const { error: releaseErr } = await client
        .from('worker_workspace')
        .update({ current_run_id: null })
        .eq('id', tenantA.envId)
        .eq('current_run_id', tenantA.runId);
      expect(releaseErr).toBeNull();
    });

    WORKER_TABLES.forEach((table) => {
      it(`gateway CANNOT UPDATE tenant B's ${table} row`, async () => {
        const client = gatewayClient(tenantA.tenantId);
        const targetId = rowIdOf(table, tenantB);
        const payload =
          table === 'worker_run' ? { status: 'cancelled' } : { status: 'destroyed' };

        const { data, error } = await client
          .from(table)
          .update(payload)
          .eq('id', targetId)
          .select('id');

        // RLS USING filters the row out — zero rows, no error.
        expect(error).toBeNull();
        expect(data).toEqual([]);

        // Tenant B's row is untouched.
        const { data: reread } = await adminUntyped
          .from(table)
          .select('status')
          .eq('id', targetId)
          .single();
        expect((reread as { status: string }).status).not.toBe(payload.status);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Deletes: not granted at all
  // -------------------------------------------------------------------------

  describe('DELETE is not granted to the gateway role', () => {
    WORKER_TABLES.forEach((table) => {
      it(`gateway client cannot DELETE from ${table} (42501)`, async () => {
        const client = gatewayClient(tenantA.tenantId);
        const rowId = rowIdOf(table, tenantA);

        const { error } = await client.from(table).delete().eq('id', rowId);

        // Hard privilege denial — not a silent RLS no-op. Destroyed sessions
        // are soft-deleted via status; the gateway must never hard-delete.
        expect(error).not.toBeNull();
        expect(error?.code).toBe('42501');

        const { data: reread } = await adminUntyped.from(table).select('id').eq('id', rowId).single();
        expect((reread as { id: string }).id).toBe(rowId);
      });
    });
  });

  // -------------------------------------------------------------------------
  // worker_run_event: invisible to the gateway role entirely
  // -------------------------------------------------------------------------

  describe('worker_run_event has no gateway grants (transcripts stay behind the dashboard)', () => {
    it('gateway client cannot SELECT worker_run_event (42501)', async () => {
      const client = gatewayClient(tenantA.tenantId);
      const { error } = await client.from('worker_run_event').select('id').limit(1);

      expect(error).not.toBeNull();
      expect(error?.code).toBe('42501');
    });

    it('gateway client cannot INSERT into worker_run_event (42501)', async () => {
      const client = gatewayClient(tenantA.tenantId);
      const { error } = await client.from('worker_run_event').insert({
        worker_run_id: tenantA.runId,
        tenant_id: tenantA.tenantId,
        app_id: tenantA.appId,
        seq: 1,
        event_type: 'status',
        payload: { should: 'be rejected' },
      });

      expect(error).not.toBeNull();
      expect(error?.code).toBe('42501');
    });
  });
});
