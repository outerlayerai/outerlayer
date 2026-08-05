/**
 * Onboarding acceptance — both `withApi` route handlers (checklist,
 * has-traces) driven as real HTTP-shaped calls via the
 * session-cookie fixture. `withApi` returns a plain `(request, ctx) =>
 * Promise<Response>` function — no Next.js route dispatch needed, so the
 * exported `GET` is invoked directly with a real `Request` and the session
 * cookie fixture supplies the cookies/`x-tenant-id` header every route reads
 * through `getRequestTenantId()`/`createSupabaseServerClient()`.
 *
 * Both routes share one gate: `verifyAppAccess` resolves the requested
 * app under the resolved request tenant and throws `ForbiddenError` (→ 403)
 * before any onboarding signal is gathered — proven once per route below.
 *
 * `checklist`'s `hasTrace` field and `has-traces`' `{hasTraces}` boolean are
 * UNCOVERABLE as a deterministic value: with `CLICKHOUSE_HOST` unset,
 * `getAnalyticsService` falls back to `MockAnalyticsService`
 * (`lib/analytics/service.ts:59-64`), whose `getTraces` reads a fixed
 * synthetic pool unrelated to any real app (`lib/analytics/mock-service.ts`)
 * — always non-empty, and not filtered by appId. Both fields are pinned as
 * `expect.any(Boolean)` (the route runs to completion, returns the right
 * shape) rather than a specific value; the trace signal itself needs a real
 * or fixture-backed ClickHouse, which this harness has neither.
 */

import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantWithOwner, type SameTenantUser } from '../app-level-roles/helpers';
import { actAsInOrg, resetRequestScope } from '../../lib/session-cookie';
import { GET as checklistGet } from '@/app/api/orgs/[orgName]/apps/[appId]/onboarding/checklist/route';
import { GET as hasTracesGet } from '@/app/api/orgs/[orgName]/has-traces/route';


/** Builds the Request + Next route ctx shape `withApi`'s returned handler expects. */
function apiRequest(
  path: string,
  query: Record<string, string>,
  params: Record<string, string>,
): [Request, { params: Promise<Record<string, string>> }] {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return [new Request(url), { params: Promise.resolve(params) }];
}

describe('onboarding route handlers — real withApi calls (session-cookie fixture)', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser;
  let orgB: SameTenantUser;
  let appA: string;
  let appB: string;
  const suffix = randomUUID().slice(0, 8);

  const seedApp = async (name: string, tenantId: string, createdBy: string): Promise<string> => {
    const { data, error } = await admin
      .from('app')
      .insert({ name, tenant_id: tenantId, created_by: createdBy })
      .select('id')
      .single();
    if (error) throw new Error(`seed app ${name}: ${error.message}`);
    return data!.id;
  };

  beforeAll(async () => {
    orgA = await createTenantWithOwner();
    orgB = await createTenantWithOwner();
    appA = await seedApp(`onb-a-${suffix}`, orgA.tenantId, orgA.id);
    appB = await seedApp(`onb-b-${suffix}`, orgB.tenantId, orgB.id);

    // apiKey + git signals for the checklist's exact-shape pin: one active key,
    // a real git connection (installation_id set) with one branch — every
    // Supabase-backed field lands "done" except teammate (single member).
    const { error: keyError } = await admin.from('api_key').insert({
      app_id: appA,
      tenant_id: orgA.tenantId,
      name: 'onboarding-key',
      api_key_id: `am_test_${suffix}`,
      allowed_env_kinds: ['development'],
    });
    if (keyError) throw new Error(`seed api_key: ${keyError.message}`);
    const { error: connError } = await admin
      .from('git_connection')
      .insert({ app_id: appA, tenant_id: orgA.tenantId, provider: 'github', repository: `octo/onb-${suffix}`, installation_id: 42, created_by: orgA.id });
    if (connError) throw new Error(`seed git_connection: ${connError.message}`);
    const { error: branchError } = await admin
      .from('git_branch')
      .insert({ app_id: appA, tenant_id: orgA.tenantId, branch_name: 'main' });
    if (branchError) throw new Error(`seed git_branch: ${branchError.message}`);
  }, 90000);

  afterEach(() => {
    resetRequestScope();
  });

  afterAll(async () => {
    const tenantIds = [orgA.tenantId, orgB.tenantId];
    await admin.from('git_branch').delete().in('tenant_id', tenantIds);
    await admin.from('git_connection').delete().in('tenant_id', tenantIds);
    await admin.from('api_key').delete().in('tenant_id', tenantIds);
    await admin.from('environment').delete().in('tenant_id', tenantIds);
    await admin.from('app').delete().in('tenant_id', tenantIds);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id]);
    for (const user of [orgA, orgB]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', tenantIds);
  });

  describe('checklist', () => {
    it('returns the exact checklist shape for a member with every Supabase signal set', async () => {
      await actAsInOrg(orgA, orgA.tenantId);
      const [request, ctx] = apiRequest(
        `/api/orgs/${orgA.tenantId}/apps/${appA}/onboarding/checklist`,
        { appId: appA },
        { orgName: orgA.tenantId, appId: appA },
      );
      const response = await checklistGet(request, ctx);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        hasApiKey: true,
        hasTrace: expect.any(Boolean),
        hasTeammate: false,
        hasGitConnection: true,
        hasRepoLinked: true,
        provider: 'github',
      });
    });

    it('denies a non-member pointed at the app under a spoofed tenant header — 403, no signal', async () => {
      await actAsInOrg(orgB, orgA.tenantId);
      const [request, ctx] = apiRequest(
        `/api/orgs/${orgA.tenantId}/apps/${appA}/onboarding/checklist`,
        { appId: appA },
        { orgName: orgA.tenantId, appId: appA },
      );
      const response = await checklistGet(request, ctx);
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
    });

    it("denies a foreign app even under the caller's own request tenant", async () => {
      await actAsInOrg(orgA, orgA.tenantId);
      const [request, ctx] = apiRequest(
        `/api/orgs/${orgA.tenantId}/apps/${appB}/onboarding/checklist`,
        { appId: appB },
        { orgName: orgA.tenantId, appId: appB },
      );
      const response = await checklistGet(request, ctx);
      expect(response.status).toBe(403);
    });

    it('rejects a path/query appId mismatch as a validation error — the URL-spoof guard', async () => {
      // The query appId (appA, the caller's own app) is what `withApi`
      // authenticates against, so this clears verifyAppAccess and reaches the
      // handler's own path-vs-query pin — a DIFFERENT appId on the [appId]
      // path segment must not silently authorize a different app than the
      // one actually verified.
      await actAsInOrg(orgA, orgA.tenantId);
      const [request, ctx] = apiRequest(
        `/api/orgs/${orgA.tenantId}/apps/${appB}/onboarding/checklist`,
        { appId: appA },
        { orgName: orgA.tenantId, appId: appB },
      );
      const response = await checklistGet(request, ctx);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_field_value');
    });
  });

  describe('has-traces', () => {
    it('returns the {hasTraces} shape for a member — the boolean itself is unpinnable (mock analytics fallback)', async () => {
      await actAsInOrg(orgA, orgA.tenantId);
      const [request, ctx] = apiRequest(
        `/api/orgs/${orgA.tenantId}/has-traces`,
        { appId: appA },
        { orgName: orgA.tenantId },
      );
      const response = await hasTracesGet(request, ctx);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ hasTraces: expect.any(Boolean) });
    });

    it('denies a foreign appId under the caller’s own request tenant — 403, before any analytics read', async () => {
      await actAsInOrg(orgA, orgA.tenantId);
      const [request, ctx] = apiRequest(
        `/api/orgs/${orgA.tenantId}/has-traces`,
        { appId: appB },
        { orgName: orgA.tenantId },
      );
      const response = await hasTracesGet(request, ctx);
      expect(response.status).toBe(403);
    });
  });
});
