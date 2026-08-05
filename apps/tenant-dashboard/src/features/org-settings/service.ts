import "server-only";

/**
 * OrgSettingsService — the org-general settings read/write (`public.tenant`,
 * supabase/schemas/10-tenant.sql). Every query runs through the caller's
 * RLS-scoped `ctx.db`: the `tenant.read` / `tenant.update` policies plus the
 * `tenant_id()` match are the enforcement boundary, so a denied write is
 * indistinguishable from any other DB error here — the caller (the action)
 * surfaces it rather than assuming success.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";

import type { OrgSettings } from "./types";
import type { UpdateOrganizationInput } from "./schemas";

class OrgSettingsService {
  async getTenant(ctx: ServiceContext): Promise<OrgSettings | null> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("tenant")
      .select("tenant_id, company_name")
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (error) throw new Error(`tenant read failed: ${error.message}`);
    if (!data) return null;
    return { tenantId: data.tenant_id, companyName: data.company_name };
  }

  /**
   * Updates the tenant's company name and returns the row actually written.
   * `.select().single()` after the update means an RLS-denied write (which
   * matches zero rows) surfaces as a real error here instead of a silent
   * no-op success — the caller must inspect the result to know a write
   * landed, it can never assume so.
   */
  async updateCompanyName(
    ctx: ServiceContext,
    input: UpdateOrganizationInput,
  ): Promise<OrgSettings> {
    const db = ctx.db as SupabaseClient;
    const { data, error } = await db
      .from("tenant")
      .update({ company_name: input.companyName })
      .eq("tenant_id", ctx.tenantId)
      .select("tenant_id, company_name")
      .single();
    if (error) throw new Error(`tenant update failed: ${error.message}`);
    return { tenantId: data.tenant_id, companyName: data.company_name };
  }
}

/** The domain's single service instance; consumers pass a per-request `ctx`. */
export const orgSettingsService = new OrgSettingsService();
