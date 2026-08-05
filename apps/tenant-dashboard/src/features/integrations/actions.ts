"use server";

import { revalidatePath } from "next/cache";

import { authorizedAction } from "@/lib/action-kit";

import { EnvVarService } from "./env-var-service";
import {
  deleteEnvVarInput,
  revealEnvVarInput,
  setEnvVarForTargetsInput,
  setEnvVarInput,
} from "./schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";

/** The settings route each action re-seeds after a write. The bracketed
 *  segments revalidate the route type across every org/app/env — the action
 *  receives no org context to target a single instance. */
const ENV_VARS_PATH = "/orgs/[orgName]/apps/[appName]/env/[envName]/settings/env-vars";

function db(ctx: { db: unknown }): SupabaseClient<Database> {
  return ctx.db as SupabaseClient<Database>;
}

/**
 * Set an env var's value for one scope. `EnvVarService.set` is an upsert
 * (update if the key already exists for the scope, insert otherwise) — the
 * UI only reaches this action from an Edit affordance, so in practice the
 * row already exists, but the service itself doesn't require that. Changes
 * take effect on the next deployment. Gates on `env_var.update`:
 * the insert/update permission split mirrors the UI affordance (Edit vs.
 * Create) rather than which DB statement the service happens to run: RLS on
 * `env_var` is the actual enforcement boundary, and
 * `EnvVarService.set`'s update leg verifies the row it updates via
 * `.select()` so an RLS-filtered write surfaces as an error rather than a
 * silent no-op.
 */
export const setEnvVar = authorizedAction({
  input: setEnvVarInput,
  permission: "env_var.update",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const service = new EnvVarService({ supabase: db(ctx) });
    const result = await service.set(input.appId, input.scope, ctx.tenantId, input.key, input.value);
    revalidatePath(ENV_VARS_PATH, "page");
    return result;
  },
});

/**
 * Set the same key+value across several scopes at once (the Vercel-style
 * multi-target add). Applies sequentially; on the first failure the
 * already-applied scopes persist and the error is returned. Like
 * `setEnvVar`, this calls the same `EnvVarService.set` upsert per scope — the
 * `env_var.insert` gate reflects that the UI only reaches this
 * action from a Create affordance, not that the service is insert-only.
 */
export const setEnvVarForTargets = authorizedAction({
  input: setEnvVarForTargetsInput,
  permission: "env_var.insert",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const service = new EnvVarService({ supabase: db(ctx) });
    for (const scope of input.scopes) {
      await service.set(input.appId, scope, ctx.tenantId, input.key, input.value);
    }
    revalidatePath(ENV_VARS_PATH, "page");
    return { count: input.scopes.length };
  },
});

/** Delete an env var and its vault secret by row id. */
export const deleteEnvVar = authorizedAction({
  input: deleteEnvVarInput,
  permission: "env_var.delete",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const service = new EnvVarService({ supabase: db(ctx) });
    await service.delete(input.appId, input.envVarId);
    revalidatePath(ENV_VARS_PATH, "page");
  },
});

/**
 * Read a single env var's secret value from vault (for the UI "reveal"
 * feature), by row id. A deliberate, audited, permission-gated action-read:
 * reveal cannot be a React Server Component (RSC) read, since secrets must not render into the page
 * payload, and it is not a route.
 */
export const revealEnvVarValue = authorizedAction({
  input: revealEnvVarInput,
  permission: "env_var.read",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const service = new EnvVarService({ supabase: db(ctx) });
    const value = await service.getValue(input.appId, input.envVarId);
    return { value };
  },
});
