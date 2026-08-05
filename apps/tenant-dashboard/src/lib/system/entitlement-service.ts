import {
  ENTITLEMENTS,
  TIERS,
  UNLIMITED,
  type TierId,
  type EntitlementKey,
  type BooleanEntitlementKey,
  type NumericEntitlementKey,
  type EntitlementCheckResult,
  type ResolvedEntitlements,
  type TenantEntitlementOverride,
  type SetOverrideParams,
} from '@/config/entitlements';
import {
  resolveBoolean,
  resolveNumeric,
  readAllOverrides,
} from '@repo/entitlements';
import {
  isSelfHostDeployment,
  getSelfHostLicense,
  resolveSelfHostBoolean,
  SELF_HOST_NUMERIC_LIMIT,
} from '@repo/ee-license';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/db';
import {
  getRequiredTierForFeature,
  buildDeniedInfo,
} from '@/lib/app-shell/entitlement-denied';

// Re-exported for existing callers — the implementation moved to
// lib/app-shell/entitlement-denied.ts so client components (which may not
// import this services-tier module directly) can reach it too.
export { buildDeniedInfo };

// ---------------------------------------------------------------------------
// Self-host resolution (boundary doc: ee/README.md)
// ---------------------------------------------------------------------------
// On a self-hosted deployment (OUTERLAYER_SELF_HOSTED=true) entitlements don't
// come from billing tiers — there is no Stripe there. Every product feature is
// on and every numeric limit unlimited; only the EE keys (custom_roles,
// app_level_roles, custom_sso, audit_log) require a valid offline-verified
// enterprise license. Cloud deployments never enter these branches, so the
// override → tier → hobby resolution below stays byte-for-byte identical.

async function selfHostBooleanOrNull(key: BooleanEntitlementKey): Promise<boolean | null> {
  if (!isSelfHostDeployment()) return null;
  const licensed = (await getSelfHostLicense()) !== null;
  return resolveSelfHostBoolean(key, licensed);
}

async function selfHostEffectiveEntitlementsOrNull(): Promise<ResolvedEntitlements | null> {
  if (!isSelfHostDeployment()) return null;
  const licensed = (await getSelfHostLicense()) !== null;
  // tierId is display metadata on this shape; self-host isn't a tier. An
  // unlicensed instance reads as the free tier, a licensed one as enterprise.
  const result = { tierId: licensed ? 'enterprise' : 'hobby' } as ResolvedEntitlements;
  for (const key of Object.keys(ENTITLEMENTS) as EntitlementKey[]) {
    const def = ENTITLEMENTS[key];
    const value =
      def.type === 'boolean'
        ? resolveSelfHostBoolean(key, licensed)
        : def.type === 'numeric'
          ? SELF_HOST_NUMERIC_LIMIT
          : licensed
            ? def.enterprise
            : def.hobby;
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

// Build a per-tier matrix for one entitlement key from the dashboard's
// ENTITLEMENTS registry. The shared resolver in @repo/entitlements is
// matrix-agnostic — the dashboard's registry is wider than
// `@repo/tier-config` (display-only keys like `git_integration`,
// `custom_sso`, `traces_enabled`), so the dashboard threads its own
// matrix through.
//
// Two narrowly typed pickers (one per kind) rather than a generic
// `pickMatrix<T>` because TS can't infer a conditional return type from
// a runtime parameter — the generic version required an unsafe double
// cast. These overloads use the `BooleanEntitlementKey` /
// `NumericEntitlementKey` discriminated unions instead.
function pickBooleanMatrix(key: BooleanEntitlementKey): Record<TierId, boolean> {
  const def = ENTITLEMENTS[key];
  return {
    hobby: def.hobby,
    growth: def.growth,
    team: def.team,
    enterprise: def.enterprise,
  };
}

function pickNumericMatrix(key: NumericEntitlementKey): Record<TierId, number> {
  const def = ENTITLEMENTS[key];
  return {
    hobby: def.hobby,
    growth: def.growth,
    team: def.team,
    enterprise: def.enterprise,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface EntitlementServiceDeps {
  db: SupabaseClient<Database>;
}

export class EntitlementService {
  private db: SupabaseClient<Database>;

  constructor(deps: EntitlementServiceDeps) {
    this.db = deps.db;
  }

  // ── Queries ──────────────────────────────────────────────────────────

  async getTenantTier(tenantId: string): Promise<TierId> {
    const { data, error } = await this.db
      .from('billing')
      .select('tier_id')
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) return 'hobby';
    const tier = data.tier_id as string;
    return isValidTier(tier) ? tier : 'hobby';
  }

  async canAccess(tenantId: string, key: BooleanEntitlementKey): Promise<boolean> {
    const selfHost = await selfHostBooleanOrNull(key);
    if (selfHost !== null) return selfHost;
    // Delegates to @repo/entitlements — the shared resolver pins the
    // override → tier → hobby-default rules so the gateway and the
    // dashboard can't drift on edge cases (non-boolean overrides on
    // boolean keys, etc.). Matrix comes from the dashboard's own
    // ENTITLEMENTS registry because some keys (e.g. `git_integration`,
    // `custom_sso`) are dashboard-only and don't appear in
    // `@repo/tier-config`'s shared matrix.
    return resolveBoolean(this.db, tenantId, key, pickBooleanMatrix(key));
  }

  async getLimit(tenantId: string, key: NumericEntitlementKey): Promise<number> {
    if (isSelfHostDeployment()) return SELF_HOST_NUMERIC_LIMIT;
    return resolveNumeric(this.db, tenantId, key, pickNumericMatrix(key));
  }

  async checkLimit(
    tenantId: string,
    key: NumericEntitlementKey,
    currentCount: number,
  ): Promise<EntitlementCheckResult> {
    const limit = await this.getLimit(tenantId, key);

    if (limit === UNLIMITED) {
      return { allowed: true, limit, currentCount };
    }

    const allowed = currentCount < limit;

    if (allowed) {
      return { allowed: true, limit, currentCount };
    }

    const requiredTier = EntitlementService.getRequiredTierForFeature(key);
    const tierConfig = TIERS[requiredTier];

    return {
      allowed: false,
      limit,
      currentCount,
      requiredTier,
      upgradeUrl: tierConfig.isSelfServe ? '/settings/billing' : '/contact',
    };
  }

  async getEffectiveEntitlements(tenantId: string): Promise<ResolvedEntitlements> {
    const selfHost = await selfHostEffectiveEntitlementsOrNull();
    if (selfHost !== null) return selfHost;

    const tier = await this.getTenantTier(tenantId);
    const defaults = EntitlementService.getTierDefaults(tier);

    // Layer overrides on top of tier defaults. Uses @repo/entitlements
    // `readAllOverrides` so the type-coercion guards (skip malformed
    // override values) and the override-table read live in one place —
    // same source of truth used by `canAccess` and `getLimit` for
    // per-key resolution.
    const overrides = await readAllOverrides(this.db, tenantId);
    for (const override of overrides) {
      if (override.entitlementKey in ENTITLEMENTS) {
        (defaults as Record<string, unknown>)[override.entitlementKey] = override.value;
      }
    }

    return defaults;
  }

  // ── Tier mutation ──────────────────────────────────────────────────

  async setTenantTier(tenantId: string, tierId: TierId): Promise<void> {
    const { error } = await this.db
      .from('billing')
      .update({ tier_id: tierId })
      .eq('tenant_id', tenantId);

    if (error) throw new Error(`Failed to set tier: ${error.message}`);
  }

  // ── Override CRUD ────────────────────────────────────────────────────

  async getOverrides(tenantId: string): Promise<TenantEntitlementOverride[]> {
    const { data, error } = await this.db
      .from('tenant_entitlement_override')
      .select('id, tenant_id, entitlement_key, value, override_reason, created_at, created_by')
      .eq('tenant_id', tenantId);

    if (error || !data) return [];

    return (data as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      tenantId: row.tenant_id as string,
      entitlementKey: row.entitlement_key as EntitlementKey,
      value: (row.value as { v: unknown }).v as boolean | number | string,
      overrideReason: (row.override_reason as string) ?? null,
      createdAt: row.created_at as string,
      createdBy: (row.created_by as string) ?? null,
    }));
  }

  async setOverride(params: SetOverrideParams): Promise<void> {
    const { error } = await this.db.from('tenant_entitlement_override').upsert(
      {
        tenant_id: params.tenantId,
        entitlement_key: params.key,
        value: { v: params.value },
        override_reason: params.reason,
        created_by: params.createdBy ?? null,
      },
      { onConflict: 'tenant_id,entitlement_key' },
    );

    if (error) throw new Error(`Failed to set override: ${error.message}`);
  }

  async removeOverride(tenantId: string, key: EntitlementKey): Promise<void> {
    const { error } = await this.db
      .from('tenant_entitlement_override')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('entitlement_key', key);

    if (error) throw new Error(`Failed to remove override: ${error.message}`);
  }

  // ── Static helpers ───────────────────────────────────────────────────

  static getTierDefaults(tierId: TierId): ResolvedEntitlements {
    const result = { tierId } as ResolvedEntitlements;
    for (const key of Object.keys(ENTITLEMENTS) as EntitlementKey[]) {
      (result as Record<string, unknown>)[key] = ENTITLEMENTS[key][tierId];
    }
    return result;
  }

  /**
   * Returns the lowest tier that grants a feature. Delegates to
   * lib/app-shell/entitlement-denied.ts — kept as a static method here for
   * existing callers (`EntitlementService.getRequiredTierForFeature(...)`).
   */
  static getRequiredTierForFeature(key: EntitlementKey): TierId {
    return getRequiredTierForFeature(key);
  }

}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isValidTier(value: string): value is TierId {
  return value in TIERS;
}
