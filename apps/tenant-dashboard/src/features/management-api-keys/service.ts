import "server-only";

/**
 * ManagementApiKeysService — every `management_api_key` row read/write runs on the
 * caller's RLS-scoped `ctx.db`. The four `management_api_key` policies
 * (`24-management-api-key.sql`) are tenant-scoped mirrors of `api_key`'s:
 * `private.authorize('management_api_key.<verb>') AND tenant_id() = tenant_id`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";

import type { ManagementApiKeyRow } from "./types";

const LIST_COLUMNS =
  "id, name, management_api_key_id, key_prefix, permissions, expires_at, last_used_at, revoked_at, created_at, created_by, updated_at, updated_by";

class ManagementApiKeysService {
  private table(ctx: ServiceContext) {
    return (ctx.db as SupabaseClient).from("management_api_key");
  }

  async list(ctx: ServiceContext): Promise<ManagementApiKeyRow[]> {
    const { data, error } = await this.table(ctx)
      .select(LIST_COLUMNS)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`management_api_key list failed: ${error.message}`);
    return (data as unknown as ManagementApiKeyRow[]) ?? [];
  }

  /**
   * Revocation is a timestamp write, not a delete — the key's grant history
   * stays visible in the list. `.is('revoked_at', null)` makes a
   * double-revoke a no-op match (reported as a failure below) rather than a
   * silent success that could mislead an audit reader about when the key was
   * actually revoked.
   */
  async revoke(ctx: ServiceContext, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const { data, error } = await this.table(ctx)
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .is("revoked_at", null)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (!data || data.length === 0) {
      return { ok: false, error: "Revoke matched no rows (already revoked, or not found)" };
    }
    return { ok: true };
  }
}

export const managementApiKeysService = new ManagementApiKeysService();
