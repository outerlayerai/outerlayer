/**
 * Agent-sessions permissions acceptance — findings RLS, and the DB grant/RPC
 * layer `resolveAgentSessionScope` (`apps/tenant-dashboard/src/features/
 * agent-sessions/scope.ts`) depends on.
 *
 * `resolveAgentSessionScope` itself cannot run end-to-end in this harness:
 * it calls `checkAppPermission`, which unconditionally builds a Supabase
 * client bound to the request's session COOKIE (`createSupabaseServerClient`
 * → `next/headers` `cookies()`). This harness stubs `next/headers`'s
 * `headers()` only (`src/stubs/next-headers.ts`) — there is no cookie
 * bridge for a real Supabase session here. So this file proves the two
 * things that ARE drivable over the real wire:
 *
 *   1. The `app_authorize` RPC — the exact call `checkAppPermission` makes —
 *      resolves `agents.sessions.team.read`/`agents.sessions.self.read`
 *      correctly across the role matrix, through the same header-scoped
 *      client (`createTenantScopedClient`) every other acceptance suite uses.
 *   2. `AgentSessionsService.getFindings` (Supabase-only, no permission gate
 *      of its own — RLS is the only enforcement) is tenant-isolated for real.
 *
 * `resolveAgentSessionScope`'s own branch logic (team vs self, the
 * `NO_ACTOR_SENTINEL` fail-closed case, and the 404-no-oracle branch in
 * `getSessionDetail`) is unit-tested with `checkAppPermission` mocked in
 * `apps/tenant-dashboard/src/features/agent-sessions/scope.test.ts` and
 * `service.test.ts` — real code, the permission seam swapped out exactly the
 * way `escalations/actions.test.ts` swaps `checkRequestPermission`.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, addUserToTenant, type SameTenantUser } from '../app-level-roles/helpers';

const SELF_READ = 'agents.sessions.self.read';
const TEAM_READ = 'agents.sessions.team.read';

describe('agent-sessions permissions and findings — the real Postgres wire path', () => {
  const admin = createSupabaseAdminClient();

  let orgA: SameTenantUser; // owner of A → has team.read AND self.read
  let orgB: SameTenantUser; // owner of B, member of B only — the foreign-tenant probe
  let writeA: SameTenantUser; // write role in A → self.read only
  let readA: SameTenantUser; // read role in A → self.read only
  let appA: string;

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
    writeA = await addUserToTenant(orgA.tenantId, 'write');
    readA = await addUserToTenant(orgA.tenantId, 'read');
    appA = await seedApp(`agent-perm-a-${randomUUID().slice(0, 8)}`, orgA.tenantId, orgA.id);
  }, 90000);

  afterAll(async () => {
    await admin.from('agent_finding').delete().eq('app_id', appA);
    await admin.from('agent_theme').delete().eq('app_id', appA);
    await admin.from('app').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
    await admin.from('membership').delete().in('user_id', [orgA.id, orgB.id, writeA.id, readA.id]);
    for (const user of [orgA, orgB, writeA, readA]) {
      await admin.from('profile').delete().eq('id', user.id);
      try {
        await admin.auth.admin.deleteUser(user.id);
      } catch {
        // best-effort; a leaked auth user does not affect other suites
      }
    }
    await admin.from('tenant').delete().in('tenant_id', [orgA.tenantId, orgB.tenantId]);
  });

  describe('app_authorize — the RPC resolveAgentSessionScope calls, across the role matrix', () => {
    it('owner (admin-tier role) holds BOTH team.read and self.read', async () => {
      const asOwner = await createTenantScopedClient(orgA, orgA.tenantId);
      const { data: team } = await asOwner.rpc('app_authorize', { requested_permission: TEAM_READ, target_app_id: appA });
      const { data: self } = await asOwner.rpc('app_authorize', { requested_permission: SELF_READ, target_app_id: appA });
      expect(team).toBe(true);
      expect(self).toBe(true);
    });

    it('write role holds self.read but NOT team.read', async () => {
      const asWrite = await createTenantScopedClient(writeA, orgA.tenantId);
      const { data: team } = await asWrite.rpc('app_authorize', { requested_permission: TEAM_READ, target_app_id: appA });
      const { data: self } = await asWrite.rpc('app_authorize', { requested_permission: SELF_READ, target_app_id: appA });
      expect(team).toBe(false);
      expect(self).toBe(true);
    });

    it('read role holds self.read but NOT team.read', async () => {
      const asRead = await createTenantScopedClient(readA, orgA.tenantId);
      const { data: team } = await asRead.rpc('app_authorize', { requested_permission: TEAM_READ, target_app_id: appA });
      const { data: self } = await asRead.rpc('app_authorize', { requested_permission: SELF_READ, target_app_id: appA });
      expect(team).toBe(false);
      expect(self).toBe(true);
    });

    it("a non-member under A's tenant header holds NEITHER permission — fail closed, no claim fallback", async () => {
      // orgB's owner is not a member of A; the header names A anyway (the
      // spoof case every other acceptance suite pins).
      const asForeign = await createTenantScopedClient(orgB, orgA.tenantId);
      const { data: team } = await asForeign.rpc('app_authorize', { requested_permission: TEAM_READ, target_app_id: appA });
      const { data: self } = await asForeign.rpc('app_authorize', { requested_permission: SELF_READ, target_app_id: appA });
      expect(team).toBe(false);
      expect(self).toBe(false);
    });
  });

  describe('AgentSessionsService.getFindings — Supabase RLS, no separate permission gate', () => {
    const findingId = randomUUID();
    const themeId = randomUUID();

    beforeAll(async () => {
      const { error: findingError } = await admin.from('agent_finding').insert({
        id: findingId,
        tenant_id: orgA.tenantId,
        app_id: appA,
        detector_id: 'edit-retry-loop',
        severity: 'warn',
        summary: 'Repeated failed edits to the same file',
        session_count: 3,
        session_ids: ['s1', 's2', 's3'],
      });
      if (findingError) throw new Error(`seed agent_finding: ${findingError.message}`);

      const { error: themeError } = await admin.from('agent_theme').insert({
        id: themeId,
        tenant_id: orgA.tenantId,
        app_id: appA,
        label: 'Stale edit anchors',
        description: 'Multiple sessions hit the same stale-anchor edit failure',
        severity: 'warn',
        evidence_session_ids: ['s1', 's2'],
      });
      if (themeError) throw new Error(`seed agent_theme: ${themeError.message}`);
    });

    it("a member of A sees A's findings and themes", async () => {
      const { agentSessionsService } = await import('tenant-dashboard/src/features/agent-sessions/service');
      const db = await createTenantScopedClient(orgA, orgA.tenantId);
      const result = await agentSessionsService.getFindings({
        userId: orgA.id,
        tenantId: orgA.tenantId,
        appId: appA as never,
        dataRetentionDays: -1,
        db,
      });
      expect(result.findings.map((f) => f.id)).toEqual([findingId]);
      expect(result.themes.map((t) => t.id)).toEqual([themeId]);
    });

    it("a non-member under A's tenant header sees NO findings or themes — RLS denies the row, not a filtered empty page", async () => {
      const { agentSessionsService } = await import('tenant-dashboard/src/features/agent-sessions/service');
      const db = await createTenantScopedClient(orgB, orgA.tenantId);
      const result = await agentSessionsService.getFindings({
        userId: orgB.id,
        tenantId: orgA.tenantId,
        appId: appA as never,
        dataRetentionDays: -1,
        db,
      });
      expect(result.findings).toEqual([]);
      expect(result.themes).toEqual([]);
    });
  });
});
