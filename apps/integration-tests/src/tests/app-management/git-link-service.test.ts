/**
 * Integration test for AppsService.linkRepository / unlinkRepository.
 *
 * Two describe blocks, one per auth mode:
 *
 *   1. **Bearer auth (`authenticated` PG role)** — what the dashboard
 *      uses. The user's Supabase cookie session JWT lands on an
 *      `authenticated`-role connection. RLS policies of the form
 *      `app_authorize(...)` decide which rows the user can touch.
 *
 *   2. **API-key auth (`gateway` PG role)** — what headless MCP / CI
 *      agents use. A short-lived JWT with `role: gateway` is minted
 *      via `mintGatewayJwt` and applied to a connection that lands
 *      on the `gateway` PG role. Column-level GRANTs + the
 *      `gateway_tenant_*` RLS policies decide which writes succeed.
 *
 * **Why two blocks**: an earlier version of this test only exercised
 * mode 1, and the code review caught that the gateway-role PG grants
 * were missing for `git_connection.repository`, `git_branch.*`, and
 * the GitLab `webhook_id` / `webhook_secret` columns. Every API-key
 * call would have 42501'd in production despite a green test run.
 * Splitting the suite forces every behaviour to be verified under
 * both identities — a regression in the grants migration would now
 * surface here instead of waiting for a stg smoke.
 *
 * **Provider stub**: `linkRepository` only invokes
 * `provider.getLatestCommitSha()`. The other methods throw so an
 * accidental reliance during link surfaces as a test failure.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppsService, GitConnectionMissingError } from '@repo/gateway-core/services/apps-service';
import {
  createAuthenticatedUser,
  cleanupTestUsers,
  TestUser,
} from '../../lib/test-utils';
import {
  createTestApp,
  createTestGitConnection,
  cleanupTestApps,
  cleanupTestGitConnections,
  uniqueInstallationId,
} from '../../lib/app-test-utils';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import type { GitFileProvider } from '@repo/gateway-core/git/types';

// ---------------------------------------------------------------------------
// Gateway-role JWT minting (mirror of apps/gateway/src/lib/jwt.ts).
// Local-only — mirrors the helper already used by gateway-rls-matrix.test.ts.
// Both files inline the same logic; a shared lib helper would be a
// follow-up refactor.
// ---------------------------------------------------------------------------

// Env-var names match gateway-rls-matrix.test.ts. CI sets these via the
// integration-tests workflow. Local dev: `supabase status` prints the
// values for the running stack and tests inherit them via the test
// runner's setup script (`apps/integration-tests/scripts/setup-db.ts`).
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54331';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ||
  'super-secret-jwt-token-with-at-least-32-characters-long';

// Permissions matching the gateway's lib/permissions.ts. The link/unlink
// routes gate on `app.update`, but the JWT can carry the full set —
// the Hono middleware does the checking, not Postgres.
const APP_WRITE_PERMISSIONS = ['app.read', 'app.insert', 'app.update', 'app.delete'];

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

function gatewayRoleClient(tenantId: string, systemUserId: string): SupabaseClient {
  const jwt = mintGatewayJwt(JWT_SECRET, tenantId, systemUserId, APP_WRITE_PERMISSIONS);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

// ---------------------------------------------------------------------------
// GitFileProvider stub. `linkRepository` only calls getLatestCommitSha.
// ---------------------------------------------------------------------------

function stubProvider(opts: { commitSha?: string | null } = {}): GitFileProvider {
  return {
    async listRepositories() {
      throw new Error('listRepositories should not be called during link');
    },
    async listBranches() {
      throw new Error('listBranches should not be called during link');
    },
    async getLatestCommitSha() {
      return opts.commitSha ?? null;
    },
    async streamFile() {
      throw new Error('streamFile should not be called during link');
    },
  };
}

// ---------------------------------------------------------------------------
// Suite 1: bearer auth (authenticated role)
// ---------------------------------------------------------------------------

describe('AppsService.linkRepository — bearer auth (authenticated PG role)', () => {
  let testUser: TestUser;
  let service: AppsService;

  beforeAll(async () => {
    testUser = await createAuthenticatedUser('owner');
    service = new AppsService(
      testUser.client as unknown as ConstructorParameters<typeof AppsService>[0],
    );
  });

  afterAll(async () => {
    await cleanupTestGitConnections(testUser.tenantId);
    await cleanupTestApps(testUser.tenantId);
    await cleanupTestUsers();
  });

  afterEach(async () => {
    await cleanupTestGitConnections(testUser.tenantId);
    await cleanupTestApps(testUser.tenantId);
  });

  it('links a repo+branch on an app the caller owns', async () => {
    const app = await createTestApp(testUser.tenantId, { name: `link-bearer-${Date.now()}` });
    await createTestGitConnection(testUser.tenantId, {
      provider: 'github',
      appId: app.id,
    });

    const result = await service.linkRepository(
      testUser.tenantId,
      app.id,
      { repository: 'acme/triage', branch: 'main' },
      stubProvider({ commitSha: 'sha-bearer' }),
    );

    expect(result.repository).toBe('acme/triage');
    expect(result.branch_id).toMatch(/^[0-9a-f-]{36}$/i);

    const admin = createSupabaseAdminClient();
    const { data: conn } = await admin
      .from('git_connection')
      .select('repository')
      .eq('app_id', app.id)
      .single();
    expect(conn?.repository).toBe('acme/triage');

    const { data: branch } = await admin
      .from('git_branch')
      .select('branch_name, repo, tenant_id, app_id')
      .eq('app_id', app.id)
      .single();
    expect(branch).toMatchObject({
      branch_name: 'main',
      repo: 'acme/triage',
      tenant_id: testUser.tenantId,
      app_id: app.id,
    });
  });

  it('updates the existing git_branch row instead of inserting a duplicate on re-link', async () => {
    const app = await createTestApp(testUser.tenantId, { name: `relink-bearer-${Date.now()}` });
    await createTestGitConnection(testUser.tenantId, {
      provider: 'github',
      appId: app.id,
    });

    await service.linkRepository(
      testUser.tenantId,
      app.id,
      { repository: 'acme/triage', branch: 'main' },
      stubProvider({ commitSha: 'first' }),
    );

    const second = await service.linkRepository(
      testUser.tenantId,
      app.id,
      { repository: 'acme/triage', branch: 'develop' },
      stubProvider({ commitSha: 'second' }),
    );

    const admin = createSupabaseAdminClient();
    const { data: branches } = await admin
      .from('git_branch')
      .select('id, branch_name')
      .eq('app_id', app.id);
    expect(branches).toHaveLength(1);
    expect(branches?.[0]?.id).toBe(second.branch_id);
    expect(branches?.[0]?.branch_name).toBe('develop');
  });

  it('throws GitConnectionMissingError when no git_connection row exists yet', async () => {
    const app = await createTestApp(testUser.tenantId, { name: `no-connect-bearer-${Date.now()}` });

    await expect(
      service.linkRepository(
        testUser.tenantId,
        app.id,
        { repository: 'acme/triage', branch: 'main' },
        stubProvider(),
      ),
    ).rejects.toBeInstanceOf(GitConnectionMissingError);
  });

  it('refuses to link a repo onto an app in a different tenant', async () => {
    const otherUser = await createAuthenticatedUser('owner');
    try {
      const otherApp = await createTestApp(otherUser.tenantId, { name: `other-bearer-${Date.now()}` });
      await createTestGitConnection(otherUser.tenantId, {
        provider: 'github',
        appId: otherApp.id,
      });

      await expect(
        service.linkRepository(
          testUser.tenantId,
          otherApp.id,
          { repository: 'evil/exfil', branch: 'main' },
          stubProvider(),
        ),
      ).rejects.toThrow(/not found/i);

      const admin = createSupabaseAdminClient();
      const { data: conn } = await admin
        .from('git_connection')
        .select('repository')
        .eq('app_id', otherApp.id)
        .single();
      expect(conn?.repository).toBeNull();
    } finally {
      await cleanupTestGitConnections(otherUser.tenantId);
      await cleanupTestApps(otherUser.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: gateway-role auth (API-key path) — the suite that caught
// the missing PG grants in code review. WITHOUT the
// 20260523120000_grant_gateway_git_link.sql migration in place, these
// tests fail with `permission denied for table git_branch` / `for
// column repository of relation git_connection` (PG error 42501).
// ---------------------------------------------------------------------------

describe('AppsService.linkRepository — API-key auth (gateway PG role)', () => {
  let testUser: TestUser; // used only to create the tenant + app via the seed helpers
  let service: AppsService;

  beforeAll(async () => {
    testUser = await createAuthenticatedUser('owner');
    // Mint a gateway-role JWT for the same tenant, then construct a
    // Supabase client that lands on the `gateway` PG role. This is
    // the EXACT client the apikey-auth path of the gateway routes
    // would build via createTenantScopedClient.
    const gwClient = gatewayRoleClient(testUser.tenantId, testUser.id);
    service = new AppsService(gwClient as unknown as ConstructorParameters<typeof AppsService>[0]);
  });

  afterAll(async () => {
    await cleanupTestGitConnections(testUser.tenantId);
    await cleanupTestApps(testUser.tenantId);
    await cleanupTestUsers();
  });

  afterEach(async () => {
    await cleanupTestGitConnections(testUser.tenantId);
    await cleanupTestApps(testUser.tenantId);
  });

  it('links under the gateway role (GRANTS + RLS allow writes on git_connection.repository + git_branch)', async () => {
    const app = await createTestApp(testUser.tenantId, { name: `link-gw-${Date.now()}` });
    await createTestGitConnection(testUser.tenantId, {
      provider: 'github',
      appId: app.id,
    });

    const result = await service.linkRepository(
      testUser.tenantId,
      app.id,
      { repository: 'acme/triage', branch: 'main' },
      stubProvider({ commitSha: 'sha-gateway' }),
    );

    expect(result.repository).toBe('acme/triage');

    const admin = createSupabaseAdminClient();
    const { data: conn } = await admin
      .from('git_connection')
      .select('repository')
      .eq('app_id', app.id)
      .single();
    expect(conn?.repository).toBe('acme/triage');

    const { data: branch } = await admin
      .from('git_branch')
      .select('branch_name, tenant_id')
      .eq('app_id', app.id)
      .single();
    expect(branch?.branch_name).toBe('main');
    expect(branch?.tenant_id).toBe(testUser.tenantId);
  });

  it('re-link upserts under the gateway role', async () => {
    const app = await createTestApp(testUser.tenantId, { name: `relink-gw-${Date.now()}` });
    await createTestGitConnection(testUser.tenantId, {
      provider: 'github',
      appId: app.id,
    });

    await service.linkRepository(
      testUser.tenantId,
      app.id,
      { repository: 'acme/triage', branch: 'main' },
      stubProvider(),
    );
    const second = await service.linkRepository(
      testUser.tenantId,
      app.id,
      { repository: 'acme/triage', branch: 'develop' },
      stubProvider(),
    );

    const admin = createSupabaseAdminClient();
    const { data: branches } = await admin
      .from('git_branch')
      .select('id, branch_name')
      .eq('app_id', app.id);
    expect(branches).toHaveLength(1);
    expect(branches?.[0]?.id).toBe(second.branch_id);
    expect(branches?.[0]?.branch_name).toBe('develop');
  });

  it('unlink under the gateway role clears repository + deletes git_branch row', async () => {
    const app = await createTestApp(testUser.tenantId, { name: `unlink-gw-${Date.now()}` });
    // Unlink must clear the repository and leave the installation binding in
    // place, so this one is pinned rather than auto-allocated.
    const installationId = uniqueInstallationId();
    await createTestGitConnection(testUser.tenantId, {
      provider: 'github',
      appId: app.id,
      installationId,
      repository: 'acme/already-linked',
    });
    const admin = createSupabaseAdminClient();
    await admin.from('git_branch').insert({
      app_id: app.id,
      tenant_id: testUser.tenantId,
      branch_name: 'main',
      repo: 'acme/already-linked',
    });

    await service.unlinkRepository(testUser.tenantId, app.id);

    const { data: conn } = await admin
      .from('git_connection')
      .select('repository, installation_id')
      .eq('app_id', app.id)
      .single();
    expect(conn?.repository).toBeNull();
    expect(conn?.installation_id).toBe(installationId);

    const { data: branches } = await admin
      .from('git_branch')
      .select('id')
      .eq('app_id', app.id);
    expect(branches).toEqual([]);
  });
});
