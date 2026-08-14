/**
 * Artifact RLS — the store-level proof for the artifact table's policy
 * surface (78-artifact.sql + 95-gateway-rls.sql + 99-triggers.sql).
 *
 * Tenant users read artifacts through ONE policy conjunction: the row's
 * app must be in `authorized_app_ids('trace.read')` AND its tenant must be
 * the resolved request tenant. Both halves are exercised here — an
 * app-scoped member proves the permission half filters per app, and a
 * cross-tenant member proves the tenant half. SELECT is the only grant to
 * `authenticated`; writes are service-role/gateway territory.
 *
 * The gateway role holds SELECT + INSERT only, tenant-fenced by
 * `gateway_tenant_{read,insert}_artifact`. Unlike the worker tables (see
 * workers/gateway-worker-rls.test.ts), artifact carries the same
 * `set_tenant_id()` BEFORE INSERT trigger as the other gateway-writable
 * tables, so a forged tenant_id is silently corrected to the caller rather
 * than rejected — these tests pin the correction. UPDATE and DELETE are not
 * granted at all (retried ingests insert with ON CONFLICT DO NOTHING; the
 * sweeps that mutate rows run under service_role), so both must fail with a
 * hard 42501, not a silent RLS no-op.
 *
 * pull_request is gateway-readable (SELECT, tenant-fenced by
 * `gateway_tenant_read_pull_request`) so ingest can confirm a claimed PR
 * number — and nothing more: writes are 42501.
 */

import { createHmac, randomUUID } from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from 'tenant-dashboard/src/types/db';
import { getSupabaseAdmin } from '../../lib/test-utils';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { supabase as anonClient } from '../../lib/supabase';
import {
  createTenantWithOwner,
  addUserToTenant,
  cleanupTenantAndUsers,
  SameTenantUser,
} from '../app-level-roles/helpers';

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

// The permission set an artifacts-emitting API key carries.
const ARTIFACT_PERMISSIONS = ['trace.write', 'trace.read'];

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
    gateway_permissions: ARTIFACT_PERMISSIONS,
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

const FAKE_SHA = 'a'.repeat(64);

type ArtifactInsert = Database['public']['Tables']['artifact']['Insert'];

/** A minimal valid artifact row; explicit tenant/app land as-is because the
 *  admin (service_role) caller bypasses the set_tenant_id correction. */
function artifactRow(tenantId: string, appId: string, over: Partial<ArtifactInsert> = {}): ArtifactInsert {
  return {
    tenant_id: tenantId,
    app_id: appId,
    client_artifact_id: `rls-${randomUUID()}`,
    sha256: FAKE_SHA,
    filename: 'shot.png',
    media_type: 'image/png',
    kind: 'screenshot',
    provenance: 'local',
    git_repo: 'github.com/acme/app',
    git_branch: 'feat/rls',
    emitted_at: new Date().toISOString(),
    ...over,
  };
}

interface SeededOrg {
  owner: SameTenantUser;
  tenantId: string;
  appId: string;
  artifactId: string;
  prNumber: number;
}

async function seedOrg(label: string): Promise<SeededOrg> {
  const admin = getSupabaseAdmin();
  const owner = await createTenantWithOwner();

  const { data: app, error: appErr } = await admin
    .from('app')
    .insert({ name: `artifact-rls-${label}-${Date.now()}`, tenant_id: owner.tenantId, created_by: owner.id })
    .select('id')
    .single();
  if (appErr || !app) throw new Error(`seed app failed: ${appErr?.message}`);

  const { data: artifact, error: artErr } = await admin
    .from('artifact')
    .insert(artifactRow(owner.tenantId, app.id))
    .select('id')
    .single();
  if (artErr || !artifact) throw new Error(`seed artifact failed: ${artErr?.message}`);

  const prNumber = 4000 + Math.floor(Math.random() * 1000);
  const { error: prErr } = await admin.from('pull_request').insert({
    tenant_id: owner.tenantId,
    app_id: app.id,
    pr_number: prNumber,
    head_branch: 'feat/rls',
    base_branch: 'main',
  });
  if (prErr) throw new Error(`seed pull_request failed: ${prErr.message}`);

  return { owner, tenantId: owner.tenantId, appId: app.id, artifactId: artifact.id, prNumber };
}

async function tearDownOrg(org: SeededOrg, extraUsers: SameTenantUser[] = []): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin.from('artifact').delete().eq('tenant_id', org.tenantId);
  await admin.from('pull_request').delete().eq('tenant_id', org.tenantId);
  await admin.from('app').delete().eq('tenant_id', org.tenantId);
  await cleanupTenantAndUsers(org.tenantId, [org.owner, ...extraUsers]);
}

describe('Artifact RLS', () => {
  const admin = getSupabaseAdmin();
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  beforeAll(async () => {
    [orgA, orgB] = await Promise.all([seedOrg('A'), seedOrg('B')]);
  }, 60000);

  afterAll(async () => {
    // Guarded: if beforeAll died partway, cleanup must not throw a second,
    // more confusing error over the top of the real one.
    if (orgA) await tearDownOrg(orgA);
    if (orgB) await tearDownOrg(orgB);
  }, 60000);

  // -------------------------------------------------------------------------
  // Tenant users: SELECT gated on trace.read AND the resolved tenant
  // -------------------------------------------------------------------------

  describe('tenant users read through trace.read + tenant scoping', () => {
    it('a member with trace.read sees exactly their own tenant rows on an unfiltered read', async () => {
      const asA = await createTenantScopedClient(orgA.owner, orgA.tenantId);

      // Unfiltered: whatever comes back is exactly what the policy allows, so
      // a policy that stopped filtering would surface here as org B's row.
      const { data, error } = await asA.from('artifact').select('id, tenant_id');

      expect(error).toBeNull();
      expect(data).toEqual([{ id: orgA.artifactId, tenant_id: orgA.tenantId }]);
    });

    it("naming another tenant's artifact id explicitly still returns nothing", async () => {
      const asB = await createTenantScopedClient(orgB.owner, orgB.tenantId);

      const { data, error } = await asB.from('artifact').select('id').eq('id', orgA.artifactId);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('an app-scoped member sees only artifacts of apps their trace.read covers', async () => {
      // Isolates the authorized_app_ids('trace.read') conjunct: same tenant,
      // same user, two apps — visibility must follow the per-app grant, so a
      // policy reduced to tenant-matching alone fails here.
      const scoped = await addUserToTenant(orgA.tenantId, 'read');
      const { data: otherApp, error: appErr } = await admin
        .from('app')
        .insert({ name: `artifact-rls-hidden-${Date.now()}`, tenant_id: orgA.tenantId, created_by: orgA.owner.id })
        .select('id')
        .single();
      if (appErr || !otherApp) throw new Error(`seed hidden app failed: ${appErr?.message}`);
      const { data: hiddenArtifact, error: hiddenErr } = await admin
        .from('artifact')
        .insert(artifactRow(orgA.tenantId, otherApp.id))
        .select('id')
        .single();
      if (hiddenErr || !hiddenArtifact) throw new Error(`seed hidden artifact failed: ${hiddenErr?.message}`);

      try {
        await admin.from('membership').update({ is_app_scoped: true }).eq('id', scoped.membershipId);
        await admin.from('app_member_role').insert({
          membership_id: scoped.membershipId,
          app_id: orgA.appId,
          tenant_id: orgA.tenantId,
          role: 'read',
          created_by: orgA.owner.id,
        });

        const asScoped = await createTenantScopedClient(scoped, orgA.tenantId);
        const { data, error } = await asScoped.from('artifact').select('id');

        expect(error).toBeNull();
        expect(data).toEqual([{ id: orgA.artifactId }]);
      } finally {
        await admin.from('app_member_role').delete().eq('membership_id', scoped.membershipId);
        await admin.from('artifact').delete().eq('id', hiddenArtifact.id);
        await admin.from('app').delete().eq('id', otherApp.id);
        await admin.from('membership').delete().eq('id', scoped.membershipId);
        await admin.from('profile').delete().eq('id', scoped.id);
        try {
          await admin.auth.admin.deleteUser(scoped.id);
        } catch {
          /* best-effort */
        }
      }
    });

    it('a member whose role carries no trace.read reads nothing', async () => {
      const disabled = await addUserToTenant(orgA.tenantId, 'disabled');
      try {
        const asDisabled = await createTenantScopedClient(disabled, orgA.tenantId);
        const { data } = await asDisabled.from('artifact').select('id');

        // Denied or filtered to nothing — either is fail-closed; a row coming
        // back is the failure.
        expect(data ?? []).toEqual([]);
      } finally {
        await admin.from('membership').delete().eq('id', disabled.membershipId);
        await admin.from('profile').delete().eq('id', disabled.id);
        try {
          await admin.auth.admin.deleteUser(disabled.id);
        } catch {
          /* best-effort */
        }
      }
    });

    it('an anonymous caller can neither read nor write', async () => {
      const { data: readData } = await anonClient.from('artifact').select('id');
      expect(readData ?? []).toEqual([]);

      const marker = `anon-${randomUUID()}`;
      const { error: writeError } = await anonClient
        .from('artifact')
        .insert(artifactRow(orgA.tenantId, orgA.appId, { client_artifact_id: marker }));
      expect(writeError).not.toBeNull();

      const { data: leak } = await admin.from('artifact').select('id').eq('client_artifact_id', marker);
      expect(leak).toEqual([]);
    });

    it('an authenticated member cannot write — SELECT is the only grant', async () => {
      const asA = await createTenantScopedClient(orgA.owner, orgA.tenantId);

      const marker = `member-${randomUUID()}`;
      const { error: insertError } = await asA
        .from('artifact')
        .insert(artifactRow(orgA.tenantId, orgA.appId, { client_artifact_id: marker }));
      expect(insertError).not.toBeNull();
      expect(insertError?.code).toBe('42501');

      const { error: updateError } = await asA
        .from('artifact')
        .update({ caption: 'defaced' })
        .eq('id', orgA.artifactId);
      expect(updateError).not.toBeNull();
      expect(updateError?.code).toBe('42501');

      const { error: deleteError } = await asA.from('artifact').delete().eq('id', orgA.artifactId);
      expect(deleteError).not.toBeNull();
      expect(deleteError?.code).toBe('42501');

      const { data: unchanged } = await admin
        .from('artifact')
        .select('id, caption')
        .eq('id', orgA.artifactId);
      expect(unchanged).toEqual([{ id: orgA.artifactId, caption: '' }]);
    });
  });

  // -------------------------------------------------------------------------
  // Gateway role: SELECT + INSERT, tenant-fenced; UPDATE/DELETE withheld
  // -------------------------------------------------------------------------

  describe('gateway role on artifact', () => {
    const trackedIds: string[] = [];

    afterAll(async () => {
      for (const id of trackedIds) {
        await admin.from('artifact').delete().eq('id', id);
      }
    });

    it('gateway client for tenant A can SELECT its own artifact row', async () => {
      const client = gatewayClient(orgA.tenantId);
      const { data, error } = await client
        .from('artifact')
        .select('id, tenant_id')
        .eq('id', orgA.artifactId);

      expect(error).toBeNull();
      expect(data).toEqual([{ id: orgA.artifactId, tenant_id: orgA.tenantId }]);
    });

    it("gateway client for tenant A cannot SELECT tenant B's artifact row by id", async () => {
      const client = gatewayClient(orgA.tenantId);
      const { data, error } = await client.from('artifact').select('id').eq('id', orgB.artifactId);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("gateway client for tenant A cannot enumerate tenant B's artifact rows", async () => {
      const client = gatewayClient(orgA.tenantId);
      const { data, error } = await client
        .from('artifact')
        .select('id')
        .eq('tenant_id', orgB.tenantId);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('gateway CAN INSERT an artifact for its own tenant (the ingest write shape)', async () => {
      const client = gatewayClient(orgA.tenantId);
      const clientArtifactId = `gw-${randomUUID()}`;

      const { data, error } = await client
        .from('artifact')
        .insert(artifactRow(orgA.tenantId, orgA.appId, { client_artifact_id: clientArtifactId }))
        .select('id, tenant_id, client_artifact_id')
        .single();

      expect(error).toBeNull();
      const row = data as { id: string; tenant_id: string; client_artifact_id: string };
      expect(row.tenant_id).toBe(orgA.tenantId);
      expect(row.client_artifact_id).toBe(clientArtifactId);
      trackedIds.push(row.id);
    });

    it('gateway CANNOT forge tenant_id on INSERT (set_tenant_id corrects to the caller)', async () => {
      // The trigger overwrites new.tenant_id with the JWT tenant for any
      // non-service caller, so the row lands under the CALLER, never the
      // forged target — the same two-layer defense as `app` and `api_key` in
      // gateway-rls-matrix.test.ts.
      const client = gatewayClient(orgA.tenantId);
      const marker = `gw-forge-${randomUUID()}`;

      const { data, error } = await client
        .from('artifact')
        .insert(artifactRow(orgB.tenantId, orgA.appId, { client_artifact_id: marker }))
        .select('id, tenant_id');

      if (data && data.length > 0) {
        // Trigger-correction path: created under tenant A, not tenant B.
        expect(data[0]!.tenant_id).toBe(orgA.tenantId);
        trackedIds.push(data[0]!.id);
      } else {
        // Alternative path: rejected outright.
        expect(error).not.toBeNull();
      }

      // Load-bearing: no row may exist under the forged target tenant.
      const { data: leak } = await admin
        .from('artifact')
        .select('id')
        .eq('tenant_id', orgB.tenantId)
        .eq('client_artifact_id', marker);
      expect(leak).toEqual([]);
    });

    it('gateway CANNOT UPDATE artifact (no UPDATE grant — 42501)', async () => {
      const client = gatewayClient(orgA.tenantId);

      // Hard privilege denial, evaluated before RLS: retried ingests insert
      // with ON CONFLICT DO NOTHING and the sweeps run under service_role, so
      // an UPDATE grant here would be reachable by no legitimate code path.
      const { error } = await client
        .from('artifact')
        .update({ verification: 'confirmed' })
        .eq('id', orgA.artifactId);

      expect(error).not.toBeNull();
      expect(error?.code).toBe('42501');

      const { data: reread } = await admin
        .from('artifact')
        .select('verification')
        .eq('id', orgA.artifactId)
        .single();
      expect((reread as { verification: string }).verification).toBe('pending');
    });

    it('gateway CANNOT DELETE artifact (42501)', async () => {
      const client = gatewayClient(orgA.tenantId);

      const { error } = await client.from('artifact').delete().eq('id', orgA.artifactId);

      expect(error).not.toBeNull();
      expect(error?.code).toBe('42501');

      const { data: reread } = await admin
        .from('artifact')
        .select('id')
        .eq('id', orgA.artifactId)
        .single();
      expect((reread as { id: string }).id).toBe(orgA.artifactId);
    });
  });

  // -------------------------------------------------------------------------
  // Gateway role: pull_request is read-only and tenant-fenced
  // -------------------------------------------------------------------------

  describe('gateway role on pull_request (anchor confirmation lookup)', () => {
    it("gateway client can SELECT its own tenant's pull_request row", async () => {
      const client = gatewayClient(orgA.tenantId);
      const { data, error } = await client
        .from('pull_request')
        .select('pr_number, tenant_id')
        .eq('tenant_id', orgA.tenantId)
        .eq('pr_number', orgA.prNumber);

      expect(error).toBeNull();
      expect(data).toEqual([{ pr_number: orgA.prNumber, tenant_id: orgA.tenantId }]);
    });

    it("gateway client for tenant A cannot see tenant B's pull_request rows", async () => {
      const client = gatewayClient(orgA.tenantId);

      const [byKey, byTenant] = await Promise.all([
        client.from('pull_request').select('id').eq('pr_number', orgB.prNumber).eq('app_id', orgB.appId),
        client.from('pull_request').select('id').eq('tenant_id', orgB.tenantId),
      ]);

      expect(byKey.error).toBeNull();
      expect(byKey.data).toEqual([]);
      expect(byTenant.error).toBeNull();
      expect(byTenant.data).toEqual([]);
    });

    it('gateway client cannot write pull_request at all (42501 on INSERT/UPDATE/DELETE)', async () => {
      const client = gatewayClient(orgA.tenantId);

      const { error: insertError } = await client.from('pull_request').insert({
        tenant_id: orgA.tenantId,
        app_id: orgA.appId,
        pr_number: 999999,
        head_branch: 'forged',
        base_branch: 'main',
      });
      expect(insertError).not.toBeNull();
      expect(insertError?.code).toBe('42501');

      const { error: updateError } = await client
        .from('pull_request')
        .update({ head_branch: 'defaced' })
        .eq('pr_number', orgA.prNumber);
      expect(updateError).not.toBeNull();
      expect(updateError?.code).toBe('42501');

      const { error: deleteError } = await client
        .from('pull_request')
        .delete()
        .eq('pr_number', orgA.prNumber);
      expect(deleteError).not.toBeNull();
      expect(deleteError?.code).toBe('42501');

      const { data: unchanged } = await admin
        .from('pull_request')
        .select('head_branch')
        .eq('tenant_id', orgA.tenantId)
        .eq('pr_number', orgA.prNumber);
      expect(unchanged).toEqual([{ head_branch: 'feat/rls' }]);
    });
  });
});
