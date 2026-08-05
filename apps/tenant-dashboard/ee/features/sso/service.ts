import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getAdminDataClient } from "@/lib/system/admin-client";
import { EntitlementService } from "@/lib/system/entitlement-service";
import { SSOConfigService } from "./sso-config-service";
import type {
  SSOConfig,
  SaveSSOConfigInput,
  SSODiagnostics,
  SSOIdentityWithProfile,
} from "@/types/sso";

/**
 * Constructs `SSOConfigService` with the caller's RLS-scoped `db` plus the
 * admin client its writes need — GoTrue's SSO admin API, `sso_config`, and
 * `sso_audit_log` all bypass the owner/admin RLS on `schemas/65-sso.sql`,
 * which a plain member's RLS-scoped client cannot write through. The
 * `data-access-boundary` gate confines admin-client construction to the
 * service layer (each slice's `service.ts`) for exactly this reason: an
 * admin client built ad hoc outside a service that owns the authorization
 * check silently exposes cross-tenant data — so this factory, not the
 * feature's action/component glue, is where it is built.
 */
function getSSOConfigServiceForTenant(db: SupabaseClient): SSOConfigService {
  return new SSOConfigService({ db, adminDb: getAdminDataClient() as SupabaseClient });
}

/**
 * The Team-plan entitlement gate for SSO — distinct from the `sso_config.*`
 * permission the actions layer checks: this answers "does this tenant's plan
 * include SSO", not "can this member act on it". Reads via the admin client
 * because entitlement resolution is tenant-plan data outside what a member's
 * RLS-scoped client can read.
 */
async function checkSSOEntitlement(tenantId: string): Promise<string | null> {
  const entitlementService = new EntitlementService({ db: getAdminDataClient() as SupabaseClient });
  const canAccess = await entitlementService.canAccess(tenantId, "custom_sso");
  return canAccess ? null : "SSO is available on the Team plan or above";
}

export async function getSSOConfig(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ config: SSOConfig | null; isEnterprise: boolean; error?: string }> {
  try {
    const entitlementError = await checkSSOEntitlement(tenantId);
    const isEnterprise = entitlementError === null;

    const svc = getSSOConfigServiceForTenant(db);
    const config = await svc.getConfig(tenantId);

    // Lazy deactivation on tier downgrade: if config is active but the tenant
    // is no longer on enterprise, deactivate SSO (preserve config data) so a
    // downgraded tenant doesn't keep enforcing sign-in through a plan it no
    // longer holds.
    if (config?.is_active && !isEnterprise) {
      try {
        await svc.toggleActive(tenantId, false);
        config.is_active = false;
        config.enforcement_enabled = false;
      } catch (deactivateErr) {
        console.error("[SSO] Lazy deactivation failed for downgraded tenant:", deactivateErr);
        return {
          config,
          isEnterprise,
          error:
            "SSO could not be automatically deactivated after plan change. Please contact support.",
        };
      }
    }

    return { config, isEnterprise };
  } catch (err) {
    console.error("[SSO] getSSOConfig failed:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch SSO config";
    return { config: null, isEnterprise: false, error: message };
  }
}

export async function saveSSOConfig(
  db: SupabaseClient,
  tenantId: string,
  input: SaveSSOConfigInput,
): Promise<{ config?: SSOConfig; error?: string }> {
  try {
    const entitlementError = await checkSSOEntitlement(tenantId);
    if (entitlementError) {
      return { error: entitlementError };
    }

    const config = await getSSOConfigServiceForTenant(db).saveConfig(tenantId, input);
    return { config };
  } catch (err) {
    console.error("[SSO] saveSSOConfig failed:", err);
    const message = err instanceof Error ? err.message : "Failed to save SSO config";
    return { error: message };
  }
}

export async function toggleSSOActive(
  db: SupabaseClient,
  tenantId: string,
  active: boolean,
): Promise<{ success: boolean; error?: string }> {
  try {
    const entitlementError = await checkSSOEntitlement(tenantId);
    if (entitlementError) {
      return { success: false, error: entitlementError };
    }

    await getSSOConfigServiceForTenant(db).toggleActive(tenantId, active);
    return { success: true };
  } catch (err) {
    console.error("[SSO] toggleSSOActive failed:", err);
    const message = err instanceof Error ? err.message : "Failed to toggle SSO active state";
    return { success: false, error: message };
  }
}

export async function toggleSSOEnforcement(
  db: SupabaseClient,
  tenantId: string,
  enforced: boolean,
): Promise<{ success: boolean; error?: string }> {
  try {
    const entitlementError = await checkSSOEntitlement(tenantId);
    if (entitlementError) {
      return { success: false, error: entitlementError };
    }

    await getSSOConfigServiceForTenant(db).toggleEnforcement(tenantId, enforced);
    return { success: true };
  } catch (err) {
    console.error("[SSO] toggleSSOEnforcement failed:", err);
    const message = err instanceof Error ? err.message : "Failed to toggle SSO enforcement";
    return { success: false, error: message };
  }
}

export async function testSSOConnection(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ diagnostics?: SSODiagnostics; error?: string }> {
  try {
    const entitlementError = await checkSSOEntitlement(tenantId);
    if (entitlementError) {
      return { error: entitlementError };
    }

    const diagnostics = await getSSOConfigServiceForTenant(db).testConnection(tenantId);
    return { diagnostics };
  } catch (err) {
    console.error("[SSO] testSSOConnection failed:", err);
    const message = err instanceof Error ? err.message : "Failed to test SSO connection";
    return { error: message };
  }
}

export async function deleteSSOConfig(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const entitlementError = await checkSSOEntitlement(tenantId);
    if (entitlementError) {
      return { success: false, error: entitlementError };
    }

    await getSSOConfigServiceForTenant(db).deleteConfig(tenantId);
    return { success: true };
  } catch (err) {
    console.error("[SSO] deleteSSOConfig failed:", err);
    const message = err instanceof Error ? err.message : "Failed to delete SSO config";
    return { success: false, error: message };
  }
}

export async function getSSOMembers(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ members: SSOIdentityWithProfile[]; error?: string }> {
  try {
    const members = await getSSOConfigServiceForTenant(db).getSSOMembers(tenantId);
    return { members };
  } catch (err) {
    console.error("[SSO] getSSOMembers failed:", err);
    const message = err instanceof Error ? err.message : "Failed to fetch SSO members";
    return { members: [], error: message };
  }
}
