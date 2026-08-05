"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import type { SupabaseClient } from "@supabase/supabase-js";

import { authorizedAction } from "@/lib/action-kit";
import {
  AppsApiError,
  createAppFromServer,
  deleteAppFromServer,
  listGitBranchesFromServer,
  listGitRepositoriesFromServer,
  linkAppRepositoryFromServer,
  updateAppFromServer,
} from "@/lib/apps/server-client";
import { resolveAppGitProvider } from "@/lib/system/resolve-app-git-provider";
import {
  runContextMirrorInitialSync,
  runPullRequestBackfill,
  runPullRequestEnrichment,
} from "@/lib/adapters/link-side-effects";

import { z } from "zod";
import type { Database } from "@/types/db";

import {
  createAppInput,
  deleteAppInput,
  fetchBranchesInput,
  fetchRepositoriesInput,
  linkRepositoryInput,
  renameAppInput,
} from "./schemas";
import type {
  CreateAppOutcome,
  DeleteAppOutcome,
  FetchBranchesOutcome,
  FetchRepositoriesOutcome,
  LinkRepositoryOutcome,
  RenameAppOutcome,
} from "./types";

/** The apps-list page, re-seeded after a create/rename/delete. */
const APPS_LIST_PATH = "/orgs/[orgName]/apps";

/** Translate a thrown `AppsApiError` into the action's own result shape. The
 *  gateway `code` passes through verbatim so a caller not enumerated below
 *  (an envelope this action doesn't specifically branch on) still gets a
 *  usable message instead of a generic failure. */
function toFailure(err: AppsApiError): { ok: false; errorCode: string; message: string; field?: string; entitlement?: string; limit?: number; current?: number } {
  const entitlement = typeof err.extras.entitlement === "string" ? err.extras.entitlement : undefined;
  const limit = typeof err.extras.limit === "number" ? err.extras.limit : undefined;
  const current = typeof err.extras.current === "number" ? err.extras.current : undefined;
  return {
    ok: false,
    errorCode: err.code,
    message: err.message,
    field: err.field,
    entitlement,
    limit,
    current,
  };
}

/**
 * Create an app. The gateway performs the write (INSERT + default
 * environment) under the request tenant (`getRequestTenantId()`, threaded by
 * `createAppFromServer`) — never the browser, closing the claim-tail class:
 * no call site can omit the tenant, because there is no browser call site.
 */
export const createAppAction = authorizedAction({
  input: createAppInput,
  permission: "app.insert",
  handler: async (_ctx, input): Promise<CreateAppOutcome> => {
    try {
      const app = await createAppFromServer({
        name: input.name,
        display_name: input.displayName,
      });
      revalidatePath(APPS_LIST_PATH, "page");
      return { ok: true, app: { id: app.id, name: app.name, display_name: app.display_name } };
    } catch (err) {
      if (err instanceof AppsApiError) return toFailure(err);
      throw err;
    }
  },
});

/**
 * Rename edits only `display_name` — the URL-stable `name` slug never
 * changes here. `displayName: null` clears the override (falls back to the
 * identifier); this is distinct from omitting the field.
 */
export const renameAppAction = authorizedAction({
  input: renameAppInput,
  permission: "app.update",
  appId: (input) => input.appId,
  handler: async (_ctx, input): Promise<RenameAppOutcome> => {
    try {
      const app = await updateAppFromServer(input.appId, { display_name: input.displayName });
      revalidatePath(APPS_LIST_PATH, "page");
      return { ok: true, app: { id: app.id, display_name: app.display_name } };
    } catch (err) {
      if (err instanceof AppsApiError) return toFailure(err);
      throw err;
    }
  },
});

/**
 * Delete: the gateway DELETE removes the `app` row (DB cascade fans out to
 * every child table), then the `api_key` sweep runs on `ctx.db` — the
 * caller's RLS-scoped, request-tenant client. One declared permission
 * (`app.delete`, ruling: mirrors the door being collapsed) rather than two;
 * `api_key.delete` RLS is the backstop for the sweep, matching the
 * dashboard's existing api-key delete gate. A wrong-tenant scope has RLS
 * match no rows for the sweep — it reports success while revoking nothing,
 * the same fail-silent shape the standalone action always had.
 *
 * A 404 from the gateway delete (already gone) is treated as success — the
 * modal's own established behavior for a stale row.
 */
export const deleteAppAction = authorizedAction({
  input: deleteAppInput,
  permission: "app.delete",
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<DeleteAppOutcome> => {
    try {
      await deleteAppFromServer(input.appId);
    } catch (err) {
      if (err instanceof AppsApiError) {
        return toFailure(err);
      }
      throw err;
    }

    const { error } = await (ctx.db as SupabaseClient)
      .from("api_key")
      .delete()
      .eq("app_id", input.appId);

    revalidatePath(APPS_LIST_PATH, "page");

    if (error) {
      return { ok: false, errorCode: "api_key_sweep_failed", message: error.message };
    }
    return { ok: true };
  },
});

/**
 * A legacy `git_connection` row with `provider: 'gitlab'` still exists in the
 * schema; every git route the gateway serves for it (repo-list, branch-list,
 * link, connect) rejects with 409 `unsupported_git_provider`. Translated here
 * to a message the link dialog can render as-is, distinguishing it from a
 * generic gateway failure.
 */
function toGitFailure(err: AppsApiError): ReturnType<typeof toFailure> {
  if (err.code === "unsupported_git_provider") {
    return {
      ok: false,
      errorCode: err.code,
      message: "This app's git connection uses a provider that's no longer supported. Reconnect with GitHub to continue.",
    };
  }
  return toFailure(err);
}

/**
 * Repository + branch discovery lives in the gateway; these are thin
 * authorized reads (a dialog-interaction fetch can't be a React Server
 * Component read) gated `app.read`, mirroring the gateway's own route
 * permissions.
 */
export const fetchRepositoriesForApp = authorizedAction({
  input: fetchRepositoriesInput,
  permission: "app.read",
  appId: (input) => input.appId,
  handler: async (_ctx, input): Promise<FetchRepositoriesOutcome> => {
    try {
      const repos = await listGitRepositoriesFromServer(input.appId);
      return { ok: true, repositories: repos.map((r) => r.full_name) };
    } catch (err) {
      if (err instanceof AppsApiError) return toGitFailure(err);
      throw err;
    }
  },
});

export const fetchBranchesForRepository = authorizedAction({
  input: fetchBranchesInput,
  permission: "app.read",
  appId: (input) => input.appId,
  handler: async (_ctx, input): Promise<FetchBranchesOutcome> => {
    try {
      const branches = await listGitBranchesFromServer(input.appId, input.repository);
      return { ok: true, branches };
    } catch (err) {
      if (err instanceof AppsApiError) return toGitFailure(err);
      throw err;
    }
  },
});

/**
 * Link a repository + branch to the app. The gateway link route owns
 * `git_connection.repository`, the `git_branch` upsert, and a best-effort
 * `app.commit_sha` seed; this action's remaining job is calling that route,
 * then driving the context mirror's initial sync, the PR-history backfill,
 * and (deferred past the response) PR enrichment — each non-fatal to the
 * link itself, per the named adapters' own contracts.
 */
export const linkRepositoryAction = authorizedAction({
  input: linkRepositoryInput,
  permission: "git_connection.update",
  appId: (input) => input.appId,
  handler: async (ctx, input): Promise<LinkRepositoryOutcome> => {
    try {
      await linkAppRepositoryFromServer(input.appId, {
        repository: input.repository,
        branch: input.branch,
      });
    } catch (err) {
      if (err instanceof AppsApiError) return toGitFailure(err);
      throw err;
    }

    // The context mirror needs a GitFileProvider to stream the repo's files
    // into content-addressed blobs.
    //
    // Resolved through the system-layer admin helper, not `ctx.db`: the
    // connection row is system-layer state rather than tenant data. This action
    // is already gated on `git_connection.update` for `input.appId`, so the
    // authorization decision is made above; `resolveAppGitProvider` is the
    // named, confined path for the read itself.
    const gitProvider = await resolveAppGitProvider(input.appId);
    if (!gitProvider) {
      return {
        ok: false,
        errorCode: "git_provider_unavailable",
        message: "Git connection not found or invalid credentials",
      };
    }

    await runContextMirrorInitialSync({
      appId: input.appId,
      tenantId: ctx.tenantId,
      repo: input.repository,
      branch: input.branch,
      gitProvider,
    });

    await runPullRequestBackfill({
      appId: input.appId,
      tenantId: ctx.tenantId,
      repository: input.repository,
      provider: gitProvider,
    });

    // Deferred past the response: the per-PR reads are the slow part of
    // linking (up to 2 API calls per candidate, sequential), the user is
    // sitting in the link modal, and every write is guarded + idempotent —
    // a run cut short by the function window leaves no damage.
    after(async () => {
      await runPullRequestEnrichment({
        appId: input.appId,
        repository: input.repository,
        provider: gitProvider,
      });
    });

    revalidatePath(APPS_LIST_PATH, "page");
    return { ok: true };
  },
});

const setAppPolicyInput = z.object({
  appId: z.string(),
  policy: z.literal("require_pull_request"),
  value: z.boolean(),
});

/**
 * Toggle a per-app publish policy (`policy` is a fixed column union, not free
 * text, so the dynamic update key is safe): validate → resolve the URL-tenant
 * context → check the app-scoped app_policy.update permission → one
 * tenant-scoped UPDATE through the header-scoped RLS client. The row is
 * reachable only within the header tenant's scope, so a spoofed tenant
 * matches no row; `enforce_app_policy_permission` is the authoritative DB
 * backstop.
 */
export const setAppPolicyAction = authorizedAction({
  input: setAppPolicyInput,
  permission: "app_policy.update",
  appId: (input) => input.appId,
  handler: async (ctx, input) => {
    const db = ctx.db as SupabaseClient<Database>;
    const patch: { require_pull_request?: boolean } = { [input.policy]: input.value };
    const { error } = await db.from("app").update(patch).eq("id", input.appId);
    if (error) {
      throw new Error(error.message);
    }
  },
});
