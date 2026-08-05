/**
 * Acceptance: the onboarding checklist's signal-gathering + interpretation,
 * and the has-traces route's app-access gate — the behavior
 * onboarding-checklist-tenancy.acceptance.test.ts doesn't reach (that suite
 * proves the checklist/client-status app-access gate and the client-status
 * signal itself end-to-end; cited, not duplicated, for two of the three
 * onboarding routes).
 *
 * All three onboarding routes (`checklist`, `client-status`, `has-traces`)
 * are `withApi`-wrapped Next.js Route Handlers that reach
 * `createSupabaseServerClient` (next/headers) for auth — same Next.js
 * request-scope gap as every other domain's actions, so they can't be
 * invoked as route handlers here. What they delegate to past that auth gate
 * IS directly reachable:
 *
 *   - `gatherOnboardingSignals` (checklist route) takes a plain `TenantContext`
 *     object — no Next.js dependency — and its Supabase half
 *     (`countOnboardingSignals`) opens its own service-role client.
 *   - `interpretChecklistCounts` is a pure function over those counts.
 *
 * has-traces' actual `{hasTraces}` boolean is UNCOVERABLE: with
 * `CLICKHOUSE_HOST` unset, `getAnalyticsService` falls back to
 * `MockAnalyticsService` (verified: `lib/analytics/service.ts:59-64`), whose
 * `getTraces` reads a fixed synthetic pool unrelated to any real app
 * (`lib/analytics/mock-service.ts:497-504,659+`) — always non-empty. This
 * harness cannot produce an app that truly has zero traces, nor does the
 * mock path filter by appId (so the cross-tenant half is equally
 * unreachable). The route's app-access GATE (not the trace signal) is still
 * coverable and included below to round out onboarding's route coverage.
 *
 * The same fallback governs `gatherOnboardingSignals` below (it calls the
 * same `getCachedTraces` → `getAnalyticsService` path): `hasTrace` is
 * deterministically `true` in this harness, not a reflection of the seeded
 * app's real trace count — asserted as such rather than treated as reachable
 * app-scoped signal.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { createSupabaseAdminClient } from '../../lib/supabase-admin';
import { createTenantScopedClient } from '../../lib/tenant-scoped-client';
import { createTenantWithOwner, cleanupTenantAndUsers, type SameTenantUser } from '../app-level-roles/helpers';
import { gatherOnboardingSignals } from 'tenant-dashboard/src/features/onboarding/service';
import { interpretChecklistCounts } from 'tenant-dashboard/src/features/onboarding/checklist';
import type { TenantContext, VerifiedAppId } from '@repo/observability-service';

/** The exact lookup verifyAppAccess runs for has-traces — same gate pattern onboarding-checklist-tenancy.acceptance.test.ts already proves for the other two routes. */
async function resolveAppUnderTenant(
  user: SameTenantUser,
  requestTenantId: string,
  appId: string,
): Promise<string | null> {
  const scoped = await createTenantScopedClient(user, requestTenantId);
  const { data } = await scoped
    .from('app')
    .select('id')
    .eq('id', appId)
    .eq('tenant_id', requestTenantId)
    .maybeSingle();
  return data?.id ?? null;
}

describe('onboarding feature behavior — checklist signal gathering + has-traces access gate', () => {
  const admin = createSupabaseAdminClient();

  let owner: SameTenantUser;
  let otherOrg: SameTenantUser;
  let appId: string;
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    owner = await createTenantWithOwner();
    otherOrg = await createTenantWithOwner();
    const { data: app, error: appError } = await admin
      .from('app')
      .insert({ name: `onb-behavior-${suffix}`, tenant_id: owner.tenantId, created_by: owner.id })
      .select('id')
      .single();
    if (appError) throw new Error(`app insert: ${appError.message}`);
    appId = app!.id as string;
  }, 60000);

  afterAll(async () => {
    await cleanupTenantAndUsers(owner.tenantId, [owner]);
    await cleanupTenantAndUsers(otherOrg.tenantId, [otherOrg]);
  });

  describe('gatherOnboardingSignals + interpretChecklistCounts', () => {
    it('an app with no signals reads every step not-done', async () => {
      const ctx: TenantContext = { userId: owner.id, tenantId: owner.tenantId, appId: appId as VerifiedAppId, dataRetentionDays: -1 };
      const signals = await gatherOnboardingSignals(ctx);
      const status = interpretChecklistCounts(signals);

      expect(status).toEqual({
        hasApiKey: false,
        // MockAnalyticsService's fixed synthetic pool (see the file header) is
        // what `getCachedTraces` falls back to with `CLICKHOUSE_HOST` unset —
        // always non-empty, so `hasTrace` is true regardless of app signals.
        hasTrace: true,
        hasTeammate: false,
        hasGitConnection: false,
        hasRepoLinked: false,
      });
    });

    it('a linked GitHub App connection + branch + API key flips repo/git/apiKey done; teammate stays not-done (creator alone)', async () => {
      const { error: keyError } = await admin
        .from('api_key')
        .insert({
          app_id: appId,
          tenant_id: owner.tenantId,
          name: 'ci',
          api_key_id: `am-${suffix}`,
          key_prefix: `am_${suffix}`,
          allowed_env_kinds: ['development'],
        });
      if (keyError) throw new Error(`api_key insert: ${keyError.message}`);

      const { error: connError } = await admin
        .from('git_connection')
        .insert({ app_id: appId, tenant_id: owner.tenantId, provider: 'github', repository: `octo/onb-${suffix}`, installation_id: 12345, created_by: owner.id });
      if (connError) throw new Error(`git_connection insert: ${connError.message}`);

      const { error: branchError } = await admin
        .from('git_branch')
        .insert({ app_id: appId, tenant_id: owner.tenantId, branch_name: 'main' });
      if (branchError) throw new Error(`git_branch insert: ${branchError.message}`);

      const ctx: TenantContext = { userId: owner.id, tenantId: owner.tenantId, appId: appId as VerifiedAppId, dataRetentionDays: -1 };
      const signals = await gatherOnboardingSignals(ctx);
      const status = interpretChecklistCounts(signals);

      expect(status).toEqual({
        hasApiKey: true,
        hasTrace: true, // MockAnalyticsService's fixed synthetic pool — see the file header.
        hasTeammate: false, // only the creator is a member (count 1, gate is > 1).
        hasGitConnection: true,
        hasRepoLinked: true,
      });
    });

    it('a second active member flips hasTeammate — the >1 boundary the pure interpreter pins', async () => {
      const teammate = await createTenantWithOwner();
      const { error } = await admin
        .from('membership')
        .insert({ user_id: teammate.id, tenant_id: owner.tenantId, role: 'write', status: 'active' });
      try {
        if (error) throw new Error(`membership insert: ${error.message}`);
        const ctx: TenantContext = { userId: owner.id, tenantId: owner.tenantId, appId: appId as VerifiedAppId, dataRetentionDays: -1 };
        const signals = await gatherOnboardingSignals(ctx);
        expect(interpretChecklistCounts(signals).hasTeammate).toBe(true);
      } finally {
        await admin.from('membership').delete().eq('user_id', teammate.id).eq('tenant_id', owner.tenantId);
        await cleanupTenantAndUsers(teammate.tenantId, [teammate]);
      }
    });
  });

  describe('has-traces app-access gate (verifyAppAccess), the third onboarding route', () => {
    it('opens for a member reading their own app', async () => {
      await expect(resolveAppUnderTenant(owner, owner.tenantId, appId)).resolves.toBe(appId);
    });

    it('denies a non-member pointed at the app under a spoofed tenant header', async () => {
      await expect(resolveAppUnderTenant(otherOrg, owner.tenantId, appId)).resolves.toBeNull();
    });
  });
});
