import "server-only";

/**
 * ApiKeysService — every `api_key` row read/write this slice runs on the
 * caller's RLS-scoped `ctx.db`. The four `api_key` policies
 * (`23-api-key.sql:104-110`) are uniform: `app_id IN
 * private.authorized_app_ids('api_key.<verb>') AND public.tenant_id() =
 * tenant_id` — so every method here runs under an RLS-scoped client that
 * permits it for the actor holding the corresponding write verb.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ServiceContext } from "@/lib/action-kit/service-context";
import { resolveEnvIdForStorage } from "@/lib/environments/env-scope";

import type { ApiKeyRow, DeleteApiKeyLookup, UpdateApiKeyLookup } from "./types";

class ApiKeysService {
  private table(ctx: ServiceContext) {
    return (ctx.db as SupabaseClient).from("api_key");
  }

  /** App lookup for the list read, scoped by name (the route param). */
  async resolveAppIdByName(ctx: ServiceContext, appName: string): Promise<string | null> {
    const { data } = await (ctx.db as SupabaseClient)
      .from("app")
      .select("id")
      .eq("name", appName)
      .single();
    return data?.id ?? null;
  }

  /**
   * Pinned keys for the resolved env, plus every kind-scoped key
   * (`environment_id` NULL — app-level, not tied to any one env). Fails
   * closed (`unresolved: true`) rather than listing every env's keys when the
   * selected env cannot be resolved.
   */
  async listForEnv(
    ctx: ServiceContext,
    appId: string,
    envName: string | undefined,
  ): Promise<{ apiKeys: ApiKeyRow[]; environmentName: string } | { unresolved: true }> {
    const scope = await resolveEnvIdForStorage(ctx.db as SupabaseClient, appId, {
      envName: envName ?? null,
    });
    if (!scope) {
      return { unresolved: true };
    }

    const { data } = await this.table(ctx)
      .select("*, created_by(name)")
      .eq("app_id", appId)
      .or(`environment_id.eq.${scope.envId},allowed_env_kinds.not.is.null`);

    return { apiKeys: (data as unknown as ApiKeyRow[]) ?? [], environmentName: scope.envName };
  }

  /** Pre-delete lookup: the app id for the permission check, the pre-image for the audit row. */
  async lookupForDelete(ctx: ServiceContext, id: string): Promise<DeleteApiKeyLookup | null> {
    const { data } = await this.table(ctx)
      .select("app_id, tenant_id, name, permissions")
      .eq("id", id)
      .single();
    if (!data) return null;
    return {
      appId: data.app_id,
      tenantId: data.tenant_id,
      name: data.name,
      permissions: data.permissions ?? null,
    };
  }

  /** Pre-update lookup: the pre-image for the audit row. */
  async lookupForUpdate(
    ctx: ServiceContext,
    apiKeyId: string,
    appId: string,
  ): Promise<UpdateApiKeyLookup | null> {
    const { data } = await this.table(ctx)
      .select("id, tenant_id, name, permissions")
      .eq("api_key_id", apiKeyId)
      .eq("app_id", appId)
      .single();
    if (!data) return null;
    return {
      id: data.id,
      tenantId: data.tenant_id,
      name: data.name,
      permissions: data.permissions ?? null,
    };
  }

  /**
   * A denied write matches zero rows under RLS and returns no `error` — so
   * every write here re-selects and treats a zero-row result as failure
   * rather than trusting an absent `error` alone.
   */
  async deleteRow(ctx: ServiceContext, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const { data, error } = await this.table(ctx).delete().eq("id", id).select("id");
    if (error) return { ok: false, error: error.message };
    if (!data || data.length === 0) return { ok: false, error: "Delete matched no rows" };
    return { ok: true };
  }

  async updatePermissions(
    ctx: ServiceContext,
    apiKeyId: string,
    appId: string,
    permissions: string[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const { data, error } = await this.table(ctx)
      .update({ permissions: permissions as never })
      .eq("api_key_id", apiKeyId)
      .eq("app_id", appId)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (!data || data.length === 0) return { ok: false, error: "Update matched no rows" };
    return { ok: true };
  }
}

export const apiKeysService = new ApiKeysService();
