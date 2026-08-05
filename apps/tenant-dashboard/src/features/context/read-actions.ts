"use server";
import "server-only";

/**
 * Context read actions — the door through which the client subsystem re-reads
 * live server state after the first paint, which a React Server Component
 * (RSC) seeds.
 *
 * The page renders from an RSC that seeds the tree/file/skill/mcp reads as
 * `fallbackData`; there is no UI-serving tenant API route. But the editor still
 * needs to RE-READ on demand — the post-commit mirror-head poll, a resync, a
 * file switch, a skill or MCP-server drill-down that opens on expand. These
 * actions are the `// live:` revalidation fetchers the SWR hooks call for
 * exactly that: each resolves the request tenant from the URL org (the same ctx
 * every read uses) and returns plain serializable data.
 *
 * They gate on `context.read` — the same permission the context nav and the
 * sibling context actions (resync, remote-file read, skill-deletion enumerate)
 * require — so a caller who reaches the page without it is denied here too,
 * rather than the reads being the one ungated seam on the surface. RLS on the
 * mirror tables is the second line: it returns an empty shape to a caller the
 * gate somehow let through.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizedAction } from "@/lib/action-kit";
import { Permissions } from "@/utils/permissions";
import type { Database } from "../../types/db";
import {
  ContextReadService,
  getMcpAdoption,
  getMcpDrilldown,
  getSkillAdoption,
  getSkillDrilldown,
} from "./service";

/** The context tree at head (or an explicit snapshot), scoped to the URL tenant. */
export const getContextTree = authorizedAction({
  input: z.object({ appId: z.string().min(1), snapshotId: z.string().optional() }),
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: (ctx, input) => {
    const service = new ContextReadService(ctx.db as SupabaseClient<Database>);
    return service.getTree(input.appId, input.snapshotId);
  },
});

/**
 * One file at head (or an explicit snapshot). A path absent from the snapshot
 * throws a `NotFoundError`, which the wrapper maps to a failed result and the
 * SWR hook surfaces as its error state — the same signal the deleted route
 * returned as a 404.
 */
export const getContextFile = authorizedAction({
  input: z.object({
    appId: z.string().min(1),
    path: z.string().min(1),
    snapshotId: z.string().optional(),
  }),
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: (ctx, input) => {
    const service = new ContextReadService(ctx.db as SupabaseClient<Database>);
    return service.getFile(input.appId, input.path, input.snapshotId);
  },
});

/** The per-skill activation overlay for the tree, scoped to the URL tenant. */
export const getContextSkillAdoption = authorizedAction({
  input: z.object({ appId: z.string().min(1) }),
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: (ctx, input) => getSkillAdoption({ tenantId: ctx.tenantId, appId: input.appId }),
});

/** The per-skill drill-down, loaded when its panel expands. */
export const getContextSkillDrilldown = authorizedAction({
  input: z.object({ appId: z.string().min(1), skill: z.string().min(1) }),
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: (ctx, input) =>
    getSkillDrilldown({ tenantId: ctx.tenantId, appId: input.appId, skill: input.skill }),
});

/** The per-server MCP usage overlay for the tree, scoped to the URL tenant. */
export const getContextMcpAdoption = authorizedAction({
  input: z.object({ appId: z.string().min(1) }),
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: (ctx, input) => getMcpAdoption({ tenantId: ctx.tenantId, appId: input.appId }),
});

/** The per-server MCP drill-down, loaded when its panel expands. */
export const getContextMcpDrilldown = authorizedAction({
  input: z.object({ appId: z.string().min(1), server: z.string().min(1) }),
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: (ctx, input) =>
    getMcpDrilldown({ tenantId: ctx.tenantId, appId: input.appId, server: input.server }),
});

/** One page of the `context_sync_event` ledger for the app, newest-first. */
export const getContextSyncHistory = authorizedAction({
  input: z.object({
    appId: z.string().min(1),
    page: z.number().int().min(0),
    pageSize: z.number().int().min(1),
  }),
  permission: Permissions.CONTEXT_READ,
  appId: (input) => input.appId,
  handler: (ctx, input) => {
    const service = new ContextReadService(ctx.db as SupabaseClient<Database>);
    return service.getSyncHistory(input.appId, input.page, input.pageSize);
  },
});
