"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { authorizedAction, ActionForbiddenError } from "@/lib/action-kit";
import { checkRequestPermission } from "@/lib/adapters";
import type { ServiceContext } from "@/lib/action-kit/service-context";
import type { DeniedContext } from "@/lib/action-kit/authorized-action";
import { databaseErrorHandlers } from "@/utils/database-error-handler";
import { GATEWAY_PERMISSIONS } from "@/lib/gateway-permissions";
import { ENV_TARGET_KINDS } from "@repo/env-kind";
import { checkApiKeyLimit, buildDeniedInfo } from "@/lib/system/api-key-limit";
import { resolveDefaultEnvironmentIdAsSystem } from "@/lib/system/resolve-default-environment";
import { mintApiKeySystem } from "@/lib/system/mint-api-key";
import { writeAuditLog, isAuditedPermission } from "@/lib/system/audit-log";

import { createApiKeyInput, deleteApiKeyInput, updateApiKeyPermissionsInput } from "./schemas";
import { apiKeysService } from "./service";
import type { CreateApiKeyOutcome, DeleteApiKeyOutcome, UpdateApiKeyOutcome } from "./types";

const VALID_PERMISSION_KEYS = new Set<string>(GATEWAY_PERMISSIONS.map((p) => p.key));
const VALID_ENV_KINDS = new Set<string>(ENV_TARGET_KINDS);

enum ApiKeyErrors {
  GenericError = "Something went wrong",
}

/** `ctx.actor` carries only `{ userId, role }`; the audit trail's `actor_label` wants a display email. */
async function resolveActorEmail(ctx: ServiceContext): Promise<string | null> {
  const {
    data: { user },
  } = await (ctx.db as SupabaseClient).auth.getUser();
  return user?.email ?? null;
}

/**
 * The permissions the CURRENT caller effectively holds on `appId`, via
 * `get_current_user_app_permissions` — the set-returning sibling of
 * `app_authorize()`, run on ctx.db so the answer is the caller's own (never
 * the service role's). Fails CLOSED: an RPC error yields an empty set, so a
 * non-empty grant request 403s rather than passing unchecked.
 *
 * Matches the gateway's own clamp (packages/gateway-core CreateApiKey,
 * `resolveCallerPermissions`) for its bearer-auth branch — the dashboard
 * only ever mints/edits as a bearer (session) caller, never api-key auth.
 */
async function resolveCallerPermissions(ctx: ServiceContext, appId: string): Promise<Set<string>> {
  const { data, error } = await (ctx.db as SupabaseClient).rpc("get_current_user_app_permissions", {
    target_app_id: appId,
  });
  if (error) return new Set();
  return new Set((Array.isArray(data) ? data : []).map(String));
}

/**
 * Reject a grant that exceeds the caller's own permissions, rather than
 * trimming it. A trim would hand back a key (or leave a key) quietly weaker
 * than requested, and the caller would discover it as a 403 somewhere
 * unrelated later; rejecting surfaces the problem at the point of request.
 */
async function clampToCaller(
  ctx: ServiceContext,
  appId: string,
  requested: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const held = await resolveCallerPermissions(ctx, appId);
  const surplus = requested.filter((p) => !held.has(p));
  if (surplus.length > 0) {
    return {
      ok: false,
      message: `Cannot grant permissions you do not hold: ${[...new Set(surplus)].sort().join(", ")}`,
    };
  }
  return { ok: true };
}

/**
 * Runs an audit write, swallowing any failure. Every audit call in this file
 * goes through this — the same "never let a recording problem change the
 * caller-visible outcome" discipline `authorizedAction` already gives
 * `onDenied` for free. Without it, a thrown error from `writeAuditLog` (or
 * `resolveActorEmail`'s `getUser()` call) propagates to the action wrapper's
 * outer catch and gets mapped to `internal_error` — turning a clean denial
 * into a false failure, or worse, a COMPLETED mutation (the key was minted
 * or deleted) into one the UI reports as a server error.
 */
async function auditQuietly(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // Deliberately empty — see the docstring above.
  }
}

/**
 * A denied create/update writes a `permission_denied` audit row, the same
 * coverage a plain permission check gets for every other mutation on this
 * table — api-key rows ARE access control, so a denied grant attempt is
 * itself audit-worthy. `onDenied` gets identifiers only, not `ctx.db` — so
 * unlike the handler-side denial audits (delete's, and every success row in
 * this file), there is no `getUser()` available to resolve a display email;
 * `actorLabel` is null here, a known, small narrowing versus every other
 * audit row in this file. `authorizedAction` already swallows a thrown
 * `onDenied`, so this doesn't need `auditQuietly` itself.
 */
async function auditApiKeyDenied(
  permission: string,
  appId: string,
  denied: DeniedContext,
): Promise<void> {
  if (!isAuditedPermission(permission)) return;
  await writeAuditLog({
    tenantId: denied.tenantId,
    actorId: denied.actorId,
    actorLabel: null,
    actionType: "permission_denied",
    targetType: "permission",
    targetIdentifier: permission,
    details: { scope: "app", app_id: appId },
  });
}

/**
 * `deleteApiKeyAction` declares the ORG-scoped `api_key.delete` at the
 * wrapper as a coarse pre-check — an ordinary member holding the permission
 * nowhere at all (the most common denial) is refused here, before the row
 * lookup that would supply an app id. No `app_id` is available yet, so this
 * audits at org scope; the app-scoped denial inside the handler (below, once
 * the target app is known) audits separately at app scope.
 */
async function auditApiKeyDeleteDeniedAtWrapper(denied: DeniedContext): Promise<void> {
  if (!isAuditedPermission("api_key.delete")) return;
  await writeAuditLog({
    tenantId: denied.tenantId,
    actorId: denied.actorId,
    actorLabel: null,
    actionType: "permission_denied",
    targetType: "permission",
    targetIdentifier: "api_key.delete",
    details: { scope: "org" },
  });
}

export const createApiKeyAction = authorizedAction({
  input: createApiKeyInput,
  permission: "api_key.insert",
  appId: (input) => input.appId,
  onDenied: (input, denied) => auditApiKeyDenied("api_key.insert", input.appId, denied),
  handler: async (ctx, input): Promise<CreateApiKeyOutcome> => {
    if (input.permissions?.length) {
      const invalid = input.permissions.filter((p) => !VALID_PERMISSION_KEYS.has(p));
      if (invalid.length > 0) {
        return { ok: false, errorCode: "invalid_permissions", message: `Invalid permissions: ${invalid.join(", ")}` };
      }

      // Clamp to the CALLER's own permissions — an unclamped mint is a direct
      // privilege escalation (a `write` member picking "Full Access" would
      // receive a key that outranks them). See packages/gateway-core's
      // CreateApiKey clamp for the same authorization model on the API side.
      const clamp = await clampToCaller(ctx, input.appId, input.permissions);
      if (!clamp.ok) {
        return { ok: false, errorCode: "permissions_exceed_caller", message: clamp.message };
      }
    }

    if (input.allowedEnvKinds?.length) {
      const invalid = input.allowedEnvKinds.filter((k) => !VALID_ENV_KINDS.has(k));
      if (invalid.length > 0) {
        return { ok: false, errorCode: "invalid_env_kinds", message: `Invalid env kinds: ${invalid.join(", ")}` };
      }
    }

    // Existing-key count runs service-role, alongside the limit read — a
    // custom role holding only api_key.insert need not hold api_key.read,
    // and a user-scoped count would resolve to zero under RLS.
    const limitResult = await checkApiKeyLimit(ctx.tenantId);
    if (!limitResult.allowed) {
      return {
        ok: false,
        errorCode: "entitlement_denied",
        message: "API key limit reached",
        entitlement: buildDeniedInfo("max_api_keys", limitResult),
      };
    }

    try {
      // A kind-scoped key carries NO env pin (environment_id stays NULL) —
      // the gateway resolves + authorizes each request's selected env
      // against allowed_env_kinds. A legacy key (no kinds) pins to the
      // chosen env, or the app default when the caller isn't env-aware.
      const isKindScoped = !!input.allowedEnvKinds && input.allowedEnvKinds.length > 0;
      const resolvedEnvironmentId = isKindScoped
        ? (input.environmentId ?? null)
        : (input.environmentId ?? (await resolveDefaultEnvironmentIdAsSystem(input.appId)));

      const { plaintext, row } = await mintApiKeySystem({
        rowClient: ctx.db as SupabaseClient,
        tenantId: ctx.tenantId,
        appId: input.appId,
        name: input.name,
        environmentId: resolvedEnvironmentId,
        allowedEnvKinds: isKindScoped ? (input.allowedEnvKinds ?? null) : null,
        permissions: input.permissions ?? [],
      });

      // API keys ARE access control (a Full Access key is a shadow admin),
      // so their lifecycle belongs in the tenant audit trail. NEVER the
      // plaintext or digest — only the grant surface. Quietly: the key is
      // already minted at this point, so an audit hiccup must not turn a
      // completed mutation into a reported failure (it would otherwise land
      // in this function's own catch below and map to database_error/mint_failed).
      await auditQuietly(async () =>
        writeAuditLog({
          tenantId: ctx.tenantId,
          actorId: ctx.actor.userId,
          actorLabel: await resolveActorEmail(ctx),
          actionType: "api_key_created",
          targetType: "api_key",
          targetId: row.id,
          targetIdentifier: input.name,
          details: {
            app_id: input.appId,
            environment_id: resolvedEnvironmentId,
            allowed_env_kinds: isKindScoped ? input.allowedEnvKinds : null,
          },
          afterState: { permissions: input.permissions ?? [] },
        }),
      );

      revalidatePath("/", "layout");

      return { ok: true, apiKey: plaintext };
    } catch (error: any) {
      // uc_api_key (name, app_id) duplicate + other PostgREST errors surface
      // from the row insert inside mintApiKeySystem.
      if (error?.code) {
        const mapped = databaseErrorHandlers.apiKey(error, input.name);
        return { ok: false, errorCode: "database_error", message: mapped.error };
      }
      return { ok: false, errorCode: "mint_failed", message: error.message ?? ApiKeyErrors.GenericError };
    }
  },
});

/**
 * The org-scoped declaration at the wrapper is a coarse pre-check; the
 * app-scoped check inside the handler (below) is the authoritative one. The
 * id-only input means there is no app id to narrow the wrapper's check to
 * before the row lookup runs.
 */
export const deleteApiKeyAction = authorizedAction({
  input: deleteApiKeyInput,
  permission: "api_key.delete",
  onDenied: (_input, denied) => auditApiKeyDeleteDeniedAtWrapper(denied),
  handler: async (ctx, input): Promise<DeleteApiKeyOutcome> => {
    const lookup = await apiKeysService.lookupForDelete(ctx, input.id);
    if (!lookup) {
      return { ok: false, message: ApiKeyErrors.GenericError };
    }

    const allowed = await checkRequestPermission(ctx.actor, "api_key.delete", lookup.appId);
    if (!allowed) {
      if (isAuditedPermission("api_key.delete")) {
        await auditQuietly(async () =>
          writeAuditLog({
            tenantId: lookup.tenantId,
            actorId: ctx.actor.userId,
            actorLabel: await resolveActorEmail(ctx),
            actionType: "permission_denied",
            targetType: "permission",
            targetIdentifier: "api_key.delete",
            details: { scope: "app", app_id: lookup.appId },
          }),
        );
      }
      throw new ActionForbiddenError(`Permission denied: api_key.delete`);
    }

    // Deleting the row IS revocation — the private.api_key_secret digest
    // cascades, so the key stops verifying. No external provider to also delete.
    const del = await apiKeysService.deleteRow(ctx, input.id);
    if (!del.ok) {
      return { ok: false, message: del.error };
    }

    await auditQuietly(async () =>
      writeAuditLog({
        tenantId: lookup.tenantId,
        actorId: ctx.actor.userId,
        actorLabel: await resolveActorEmail(ctx),
        actionType: "api_key_deleted",
        targetType: "api_key",
        targetId: input.id,
        targetIdentifier: lookup.name,
        details: { app_id: lookup.appId },
        beforeState: { permissions: lookup.permissions ?? [] },
      }),
    );

    revalidatePath("/", "layout");
    return { ok: true };
  },
});

export const updateApiKeyPermissionsAction = authorizedAction({
  input: updateApiKeyPermissionsInput,
  permission: "api_key.update",
  appId: (input) => input.appId,
  onDenied: (input, denied) => auditApiKeyDenied("api_key.update", input.appId, denied),
  handler: async (ctx, input): Promise<UpdateApiKeyOutcome> => {
    const invalid = input.permissions.filter((p) => !VALID_PERMISSION_KEYS.has(p));
    if (invalid.length > 0) {
      return { ok: false, message: `Invalid permissions: ${invalid.join(", ")}` };
    }

    // Clamp to the CALLER's own permissions — the gateway has no update route
    // to mirror (this is dashboard-only), but the escalation shape is the
    // same one closed on create above: a caller must not be able to grant an
    // EXISTING key more than they themselves hold.
    const clamp = await clampToCaller(ctx, input.appId, input.permissions);
    if (!clamp.ok) {
      return { ok: false, message: clamp.message };
    }

    const before = await apiKeysService.lookupForUpdate(ctx, input.apiKeyId, input.appId);
    if (!before) {
      return { ok: false, message: ApiKeyErrors.GenericError };
    }

    const updated = await apiKeysService.updatePermissions(
      ctx,
      input.apiKeyId,
      input.appId,
      input.permissions,
    );
    if (!updated.ok) {
      return { ok: false, message: updated.error };
    }

    await auditQuietly(async () =>
      writeAuditLog({
        tenantId: before.tenantId,
        actorId: ctx.actor.userId,
        actorLabel: await resolveActorEmail(ctx),
        actionType: "api_key_updated",
        targetType: "api_key",
        targetId: before.id,
        targetIdentifier: before.name,
        details: { app_id: input.appId },
        beforeState: { permissions: before.permissions ?? [] },
        afterState: { permissions: input.permissions },
      }),
    );

    revalidatePath("/", "layout");
    return { ok: true };
  },
});
