/**
 * Unit tests for EntitlementService and buildDeniedInfo.
 *
 * Supabase is faked at the HTTP layer via MSW (see
 * `test-helpers/msw-handlers/supabase.ts`). State is seeded with
 * `seedSupabaseMswState`; mutation captures are inspected through
 * `getUpsertedEntitlementOverrides`, `getDeletedEntitlementOverrides`,
 * and `getUpdatedBilling`. The dashboard CLAUDE.md bans hand-rolled
 * query-builder stubs for HTTP boundaries — this file matches the
 * exemplar at `features/api-keys/actions.test.ts`.
 *
 * Resolution-rule tests (override → tier → hobby default semantics)
 * live in `@repo/entitlements/src/resolver.test.ts`. Tests here verify
 * the dashboard-specific surface: rich `checkLimit` results,
 * `getEffectiveEntitlements` merging, override CRUD, and the static
 * `getRequiredTierForFeature` / `getTierDefaults` helpers.
 */

import { getAdminDataClient } from './admin-client';
import {
  ENTITLEMENTS,
  UNLIMITED,
} from '@/config/entitlements';
import {
  seedSupabaseMswState,
  getUpsertedEntitlementOverrides,
  getDeletedEntitlementOverrides,
  getUpdatedBilling,
} from '@/test-helpers/msw-handlers';
import { EntitlementService, buildDeniedInfo } from './entitlement-service';
import type { EntitlementKey, TierId } from '@/config/entitlements';

// `getAdminDataClient` reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY
// from env. The unit-test setup pre-populates both with the localhost URL
// the MSW server is wired to. We construct a fresh service per test so
// cached state never leaks across cases.
function makeService(): EntitlementService {
  return new EntitlementService({ db: getAdminDataClient() });
}

function seedTier(tenantId: string, tier: TierId): void {
  seedSupabaseMswState({
    billing: [{ tenant_id: tenantId, tier_id: tier }],
  });
}

function seedTierAndOverride(
  tenantId: string,
  tier: TierId,
  key: EntitlementKey,
  value: { v: boolean | number | string },
): void {
  seedSupabaseMswState({
    billing: [{ tenant_id: tenantId, tier_id: tier }],
    tenantEntitlementOverrides: [
      {
        id: 'ov-1',
        tenant_id: tenantId,
        entitlement_key: key,
        value,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// EntitlementService — DB-dependent methods
// ---------------------------------------------------------------------------

describe('EntitlementService', () => {
  // ── getTenantTier ───────────────────────────────────────────────────

  describe('getTenantTier()', () => {
    it('should return the tier when billing row exists', async () => {
      seedTier('t1', 'growth');
      expect(await makeService().getTenantTier('t1')).toBe('growth');
    });

    it('should fall back to hobby when billing row is missing', async () => {
      expect(await makeService().getTenantTier('t1')).toBe('hobby');
    });
  });

  // ── canAccess (delegates to @repo/entitlements) ──────────────────────

  describe('canAccess()', () => {
    it('should return true when tier grants the boolean entitlement', async () => {
      seedTier('t1', 'growth');
      expect(await makeService().canAccess('t1', 'workers_enabled')).toBe(true);
    });

    it('should return false when tier denies the boolean entitlement', async () => {
      seedTier('t1', 'hobby');
      expect(await makeService().canAccess('t1', 'workers_enabled')).toBe(false);
    });

    it('should return true when override grants access despite tier denial', async () => {
      seedTierAndOverride('t1', 'hobby', 'workers_enabled', { v: true });
      expect(await makeService().canAccess('t1', 'workers_enabled')).toBe(true);
    });

    it('should return false when override restricts access despite tier grant', async () => {
      seedTierAndOverride('t1', 'growth', 'workers_enabled', { v: false });
      expect(await makeService().canAccess('t1', 'workers_enabled')).toBe(false);
    });
  });

  // ── getLimit (delegates to @repo/entitlements) ───────────────────────

  describe('getLimit()', () => {
    it('should return the tier limit when no override exists', async () => {
      seedTier('t1', 'hobby');
      expect(await makeService().getLimit('t1', 'max_apps')).toBe(1);
    });

    it('should return UNLIMITED sentinel for enterprise tier', async () => {
      seedTier('t1', 'enterprise');
      expect(await makeService().getLimit('t1', 'max_apps')).toBe(UNLIMITED);
    });

    it('should return override value when override exists', async () => {
      seedTierAndOverride('t1', 'hobby', 'max_apps', { v: 50 });
      expect(await makeService().getLimit('t1', 'max_apps')).toBe(50);
    });
  });

  // ── checkLimit (dashboard-specific rich result) ──────────────────────

  describe('checkLimit()', () => {
    it('should allow when current count is below limit', async () => {
      seedTier('t1', 'team');
      const result = await makeService().checkLimit('t1', 'max_apps', 5);
      expect(result).toEqual({ allowed: true, limit: 10, currentCount: 5 });
    });

    it('should block when current count equals limit', async () => {
      seedTier('t1', 'team');
      const result = await makeService().checkLimit('t1', 'max_apps', 10);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(10);
    });

    it('should block when current count exceeds limit', async () => {
      seedTier('t1', 'hobby');
      const result = await makeService().checkLimit('t1', 'max_apps', 3);
      expect(result.allowed).toBe(false);
    });

    it('should always allow when limit is unlimited', async () => {
      seedTier('t1', 'enterprise');
      const result = await makeService().checkLimit('t1', 'max_apps', 999_999);
      expect(result).toEqual({ allowed: true, limit: UNLIMITED, currentCount: 999_999 });
    });

    it('should include required tier when blocked', async () => {
      seedTier('t1', 'hobby');
      const result = await makeService().checkLimit('t1', 'max_apps', 1);
      expect(result.requiredTier).toBe('growth');
    });

    it('should include upgrade URL when blocked', async () => {
      seedTier('t1', 'hobby');
      const result = await makeService().checkLimit('t1', 'max_apps', 1);
      expect(result.upgradeUrl).toBe('/settings/billing');
    });
  });

  // ── getEffectiveEntitlements (dashboard-specific) ────────────────────

  describe('getEffectiveEntitlements()', () => {
    it('should return all tier defaults when no overrides exist', async () => {
      seedTier('t1', 'hobby');
      const resolved = await makeService().getEffectiveEntitlements('t1');
      expect(resolved.tierId).toBe('hobby');
      expect(resolved.max_apps).toBe(1);
      expect(resolved.workers_enabled).toBe(false);
      expect(resolved.support_level).toBe('community');
    });

    it('should merge override value into tier defaults', async () => {
      seedTierAndOverride('t1', 'hobby', 'max_apps', { v: 50 });
      const resolved = await makeService().getEffectiveEntitlements('t1');
      expect(resolved.max_apps).toBe(50);
    });

    it('should preserve non-overridden defaults when overrides exist', async () => {
      seedTierAndOverride('t1', 'hobby', 'max_apps', { v: 50 });
      const resolved = await makeService().getEffectiveEntitlements('t1');
      expect(resolved.max_users).toBe(2);
      expect(resolved.workers_enabled).toBe(false);
    });
  });

  // ── setTenantTier — mutation captured by MSW PATCH handler ───────────

  describe('setTenantTier()', () => {
    it('should update billing row with the new tier', async () => {
      seedTier('t1', 'hobby');
      await makeService().setTenantTier('t1', 'growth');
      expect(getUpdatedBilling()).toEqual([{ tenant_id: 't1', tier_id: 'growth' }]);
    });

    it('should throw when the update fails', async () => {
      seedSupabaseMswState({
        billing: [{ tenant_id: 't1', tier_id: 'hobby' }],
        tableErrors: { billing_update: { message: 'DB error' } },
      });
      await expect(makeService().setTenantTier('t1', 'growth')).rejects.toThrow(
        'Failed to set tier',
      );
    });
  });

  // ── setOverride — mutation captured by MSW POST handler ──────────────

  describe('setOverride()', () => {
    it('should upsert with correct payload', async () => {
      await makeService().setOverride({
        tenantId: 't1',
        key: 'max_apps',
        value: 50,
        reason: 'Sales deal',
        createdBy: 'admin-123',
      });
      expect(getUpsertedEntitlementOverrides()).toEqual([
        {
          tenant_id: 't1',
          entitlement_key: 'max_apps',
          value: { v: 50 },
          override_reason: 'Sales deal',
          created_by: 'admin-123',
        },
      ]);
    });

    it('should default created_by to null when not provided', async () => {
      await makeService().setOverride({
        tenantId: 't1',
        key: 'max_apps',
        value: 50,
        reason: 'test',
      });
      expect(getUpsertedEntitlementOverrides()[0]?.created_by).toBeNull();
    });

    it('should wrap value in JSONB envelope', async () => {
      await makeService().setOverride({
        tenantId: 't1',
        key: 'workers_enabled',
        value: true,
        reason: 'POC',
      });
      expect(getUpsertedEntitlementOverrides()[0]?.value).toEqual({ v: true });
    });

    it('should throw when upsert fails', async () => {
      seedSupabaseMswState({
        tableErrors: { override_upsert: { message: 'DB error' } },
      });
      await expect(
        makeService().setOverride({ tenantId: 't1', key: 'max_apps', value: 50, reason: 'test' }),
      ).rejects.toThrow('Failed to set override');
    });
  });

  // ── removeOverride — mutation captured by MSW DELETE handler ─────────

  describe('removeOverride()', () => {
    it('should complete without error when delete succeeds', async () => {
      await expect(
        makeService().removeOverride('t1', 'max_apps'),
      ).resolves.toBeUndefined();
      expect(getDeletedEntitlementOverrides()).toEqual([
        { tenant_id: 't1', entitlement_key: 'max_apps' },
      ]);
    });

    it('should throw when delete fails', async () => {
      seedSupabaseMswState({
        tableErrors: { override_delete: { message: 'DB error' } },
      });
      await expect(makeService().removeOverride('t1', 'max_apps')).rejects.toThrow(
        'Failed to remove override',
      );
    });
  });

  // ── static getTierDefaults (pure logic, no DB) ──────────────────────

  describe('static getTierDefaults()', () => {
    it('should return hobby defaults', () => {
      const defaults = EntitlementService.getTierDefaults('hobby');
      expect(defaults.tierId).toBe('hobby');
      expect(defaults.max_apps).toBe(ENTITLEMENTS.max_apps.hobby);
      expect(defaults.workers_enabled).toBe(false);
    });

    it('should return growth defaults', () => {
      const defaults = EntitlementService.getTierDefaults('growth');
      expect(defaults.tierId).toBe('growth');
      expect(defaults.max_apps).toBe(ENTITLEMENTS.max_apps.growth);
      expect(defaults.workers_enabled).toBe(true);
    });

    it('should return enterprise defaults', () => {
      const defaults = EntitlementService.getTierDefaults('enterprise');
      expect(defaults.tierId).toBe('enterprise');
      expect(defaults.max_apps).toBe(UNLIMITED);
      expect(defaults.custom_sso).toBe(true);
    });
  });

  // ── static getRequiredTierForFeature (pure logic, no DB) ────────────

  describe('static getRequiredTierForFeature()', () => {
    it('should return growth when first true tier is growth', () => {
      expect(EntitlementService.getRequiredTierForFeature('workers_enabled')).toBe('growth');
    });

    it('should return team when first tier with the feature is team', () => {
      // custom_sso: hobby=false, growth=false, team=true, enterprise=true
      expect(EntitlementService.getRequiredTierForFeature('custom_sso')).toBe('team');
    });

    it('should return hobby when all tiers have the feature', () => {
      expect(EntitlementService.getRequiredTierForFeature('git_integration')).toBe('hobby');
    });

    it('should return growth for numeric key with higher growth limit', () => {
      expect(EntitlementService.getRequiredTierForFeature('max_apps')).toBe('growth');
    });
  });
});

// ---------------------------------------------------------------------------
// Span-limit / data-retention tier matrix — the numeric entitlements the
// billing meter and retention job read directly, kept separate from the
// generic getLimit()/checkLimit() coverage above (which exercises max_apps).
// ---------------------------------------------------------------------------

describe('EntitlementService — span limits', () => {
  it('getLimit returns 20000 for hobby max_spans_per_month', async () => {
    seedTier('tenant-1', 'hobby');
    const limit = await makeService().getLimit('tenant-1', 'max_spans_per_month');
    expect(limit).toBe(20000);
  });

  it('getLimit returns -1 (unlimited) for growth max_spans_per_month — paid metered tier', async () => {
    seedTier('tenant-1', 'growth');
    const limit = await makeService().getLimit('tenant-1', 'max_spans_per_month');
    expect(limit).toBe(-1);
  });

  it('getLimit returns -1 (unlimited) for enterprise max_spans_per_month', async () => {
    seedTier('tenant-1', 'enterprise');
    const limit = await makeService().getLimit('tenant-1', 'max_spans_per_month');
    expect(limit).toBe(-1);
  });

  it('checkLimit blocks at span limit (20000) for hobby', async () => {
    seedTier('tenant-1', 'hobby');
    const result = await makeService().checkLimit('tenant-1', 'max_spans_per_month', 20000);
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(20000);
    expect(result.currentCount).toBe(20000);
    // Growth is unlimited (metered) — it's the next tier up from hobby's cap
    expect(result.requiredTier).toBe('growth');
  });

  it('checkLimit allows under span limit (19999)', async () => {
    seedTier('tenant-1', 'hobby');
    const result = await makeService().checkLimit('tenant-1', 'max_spans_per_month', 19999);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(20000);
  });

  it('checkLimit always allows for unlimited tiers (enterprise)', async () => {
    seedTier('tenant-1', 'enterprise');
    const result = await makeService().checkLimit('tenant-1', 'max_spans_per_month', 999999);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(-1);
  });

  it('checkLimit never blocks growth — paid metered ingest is billed, not capped', async () => {
    seedTier('tenant-1', 'growth');
    const result = await makeService().checkLimit('tenant-1', 'max_spans_per_month', 10_000_000);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(-1);
  });

  it('override of 50000 takes precedence over 20000 default', async () => {
    seedTierAndOverride('tenant-1', 'hobby', 'max_spans_per_month', { v: 50000 });
    const limit = await makeService().getLimit('tenant-1', 'max_spans_per_month');
    expect(limit).toBe(50000);
  });

  it('checkLimit uses override value (50000) instead of tier default', async () => {
    seedTierAndOverride('tenant-1', 'hobby', 'max_spans_per_month', { v: 50000 });
    const result = await makeService().checkLimit('tenant-1', 'max_spans_per_month', 20000);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(50000);
  });
});

describe('EntitlementService — data retention', () => {
  it('getLimit returns 7 for hobby data_retention_days', async () => {
    seedTier('tenant-1', 'hobby');
    const limit = await makeService().getLimit('tenant-1', 'data_retention_days');
    expect(limit).toBe(7);
  });

  it('getLimit returns 90 for growth data_retention_days', async () => {
    seedTier('tenant-1', 'growth');
    const limit = await makeService().getLimit('tenant-1', 'data_retention_days');
    expect(limit).toBe(90);
  });

  it('getLimit returns -1 (unlimited) for enterprise data_retention_days', async () => {
    seedTier('tenant-1', 'enterprise');
    const limit = await makeService().getLimit('tenant-1', 'data_retention_days');
    expect(limit).toBe(-1);
  });
});

describe('EntitlementService — getEffectiveEntitlements span/retention shape', () => {
  it('includes the span limit and retention default for hobby', async () => {
    seedTier('tenant-1', 'hobby');
    const entitlements = await makeService().getEffectiveEntitlements('tenant-1');
    expect(entitlements.tierId).toBe('hobby');
    expect(entitlements.max_spans_per_month).toBe(20000);
    expect(entitlements.data_retention_days).toBe(7);
  });

  it('includes the retention default for growth (90 days)', () => {
    const defaults = EntitlementService.getTierDefaults('growth');
    expect(defaults.data_retention_days).toBe(90);
    expect(defaults.max_spans_per_month).toBe(-1);
  });

  it('includes unlimited span limit and retention for enterprise', () => {
    const defaults = EntitlementService.getTierDefaults('enterprise');
    expect(defaults.data_retention_days).toBe(-1);
    expect(defaults.max_spans_per_month).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// buildDeniedInfo — pure logic, no DB
// ---------------------------------------------------------------------------

describe('buildDeniedInfo()', () => {
  it('should set feature key and display name from config', () => {
    const info = buildDeniedInfo('workers_enabled');
    expect(info.featureKey).toBe('workers_enabled');
    expect(info.featureDisplayName).toBe('Cloud Workers');
  });

  it('should resolve the required tier for the feature', () => {
    const info = buildDeniedInfo('workers_enabled');
    expect(info.requiredTier).toBe('growth');
    expect(info.requiredTierDisplayName).toBe('Growth');
  });

  it('should include self-serve pricing and billing URL when tier is self-serve', () => {
    const info = buildDeniedInfo('workers_enabled');
    expect(info.isSelfServe).toBe(true);
    expect(info.pricing).toBe('$59/month');
    expect(info.upgradeUrl).toBe('/settings/billing');
  });

  it('should include self-serve pricing and contact URL when tier is team', () => {
    // custom_sso requires team tier (hobby=false, growth=false, team=true)
    const info = buildDeniedInfo('custom_sso');
    expect(info.isSelfServe).toBe(true);
    expect(info.pricing).toBe('$499/month');
    expect(info.upgradeUrl).toBe('/settings/billing');
  });

  it('should include current and required limits for numeric entitlements', () => {
    // max_apps: hobby=1, growth=3 — requiredTier is growth with limit 3
    const info = buildDeniedInfo('max_apps', { allowed: false, limit: 1, currentCount: 1 });
    expect(info.currentLimit).toBe(1);
    expect(info.requiredTierLimit).toBe(3);
  });

  it('should set null limits for boolean entitlements', () => {
    const info = buildDeniedInfo('workers_enabled');
    expect(info.currentLimit).toBeNull();
    expect(info.requiredTierLimit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Self-host mode (@repo/ee-license integration)
// ---------------------------------------------------------------------------
// With OUTERLAYER_SELF_HOSTED=true, resolution must not touch billing/overrides
// at all: product features on, numerics unlimited, EE keys by license. None of
// these tests seed MSW state — a DB read here would fail the request and the
// assertion, which is exactly the regression this guards.

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { LICENSE_KEY_PREFIX, _resetLicenseCacheForTests } from '@repo/ee-license';

function mintLicense(expOffsetSeconds: number): { token: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    org: 'Self Host Test Org',
    plan: 'enterprise',
    iat: nowSec - 60,
    exp: nowSec + expOffsetSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const message = `${LICENSE_KEY_PREFIX}.${payloadB64}`;
  const signature = cryptoSign(null, Buffer.from(message, 'ascii'), privateKey);
  return {
    token: `${message}.${signature.toString('base64url')}`,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

describe('self-host mode', () => {
  beforeEach(() => {
    _resetLicenseCacheForTests();
    vi.stubEnv('OUTERLAYER_SELF_HOSTED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('unlicensed', () => {
    it('denies EE keys and allows every other boolean, without any DB read', async () => {
      const service = makeService();
      expect(await service.canAccess('t-selfhost', 'custom_roles')).toBe(false);
      expect(await service.canAccess('t-selfhost', 'app_level_roles')).toBe(false);
      expect(await service.canAccess('t-selfhost', 'custom_sso')).toBe(false);
      expect(await service.canAccess('t-selfhost', 'audit_log')).toBe(false);
      expect(await service.canAccess('t-selfhost', 'branching_workflow')).toBe(true);
      expect(await service.canAccess('t-selfhost', 'workers_enabled')).toBe(true);
      expect(await service.canAccess('t-selfhost', 'preview_envs')).toBe(true);
    });

    it('resolves every numeric limit as unlimited', async () => {
      const service = makeService();
      expect(await service.getLimit('t-selfhost', 'max_apps')).toBe(UNLIMITED);
      expect(await service.getLimit('t-selfhost', 'max_spans_per_month')).toBe(UNLIMITED);
      expect(await service.checkLimit('t-selfhost', 'max_apps', 10_000)).toEqual({
        allowed: true,
        limit: UNLIMITED,
        currentCount: 10_000,
      });
    });

    it('getEffectiveEntitlements: EE keys false, product booleans true, numerics unlimited, free-tier label', async () => {
      const resolved = await makeService().getEffectiveEntitlements('t-selfhost');
      expect(resolved.tierId).toBe('hobby');
      expect(resolved.custom_roles).toBe(false);
      expect(resolved.app_level_roles).toBe(false);
      expect(resolved.custom_sso).toBe(false);
      expect(resolved.audit_log).toBe(false);
      expect(resolved.branching_workflow).toBe(true);
      expect(resolved.traces_enabled).toBe(true);
      expect(resolved.max_apps).toBe(UNLIMITED);
      expect(resolved.data_retention_days).toBe(UNLIMITED);
      expect(resolved.support_level).toBe('community');
    });
  });

  describe('licensed', () => {
    it('unlocks EE keys with a valid offline-verified license', async () => {
      const { token, publicKey } = mintLicense(30 * 24 * 60 * 60);
      vi.stubEnv('OUTERLAYER_EE_LICENSE_KEY', token);
      vi.stubEnv('OUTERLAYER_EE_PUBLIC_KEY', publicKey);

      const service = makeService();
      expect(await service.canAccess('t-selfhost', 'custom_roles')).toBe(true);
      expect(await service.canAccess('t-selfhost', 'audit_log')).toBe(true);
    });

    it('getEffectiveEntitlements reports the enterprise shape', async () => {
      const { token, publicKey } = mintLicense(30 * 24 * 60 * 60);
      vi.stubEnv('OUTERLAYER_EE_LICENSE_KEY', token);
      vi.stubEnv('OUTERLAYER_EE_PUBLIC_KEY', publicKey);

      const resolved = await makeService().getEffectiveEntitlements('t-selfhost');
      expect(resolved.tierId).toBe('enterprise');
      expect(resolved.custom_sso).toBe(true);
      expect(resolved.audit_log).toBe(true);
      expect(resolved.support_level).toBe('dedicated');
    });

    it('a license expired past the grace window stops unlocking EE keys', async () => {
      const { token, publicKey } = mintLicense(-15 * 24 * 60 * 60);
      vi.stubEnv('OUTERLAYER_EE_LICENSE_KEY', token);
      vi.stubEnv('OUTERLAYER_EE_PUBLIC_KEY', publicKey);

      const service = makeService();
      expect(await service.canAccess('t-selfhost', 'custom_roles')).toBe(false);
      expect(await service.canAccess('t-selfhost', 'branching_workflow')).toBe(true);
    });
  });

  it('cloud deployments are untouched: with the flag unset, tier resolution applies', async () => {
    vi.unstubAllEnvs();
    _resetLicenseCacheForTests();
    seedTier('t-cloud', 'team');
    const service = makeService();
    expect(await service.canAccess('t-cloud', 'custom_roles')).toBe(true);
    expect(await service.canAccess('t-cloud', 'audit_log')).toBe(false);
    expect(await service.getLimit('t-cloud', 'max_apps')).toBe(10);
  });
});
