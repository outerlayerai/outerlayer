"use client";

/**
 * Data hooks for the context surface. The tree/file/skill reads are seeded by
 * the page React Server Component (RSC) (`fallbackData`) so first paint needs no client fetch; the hooks
 * present that seed and re-read live server state only on demand — a file
 * switch, the post-commit mirror-head poll, a resync, or a skill drill-down
 * that opens on expand — through the context read actions (no UI-serving API
 * route). `mutate()` on any hook revalidates through the same action.
 */
import useSWR from "swr";
import {
  getContextFile,
  getContextMcpAdoption,
  getContextMcpDrilldown,
  getContextSkillAdoption,
  getContextSkillDrilldown,
  getContextTree,
} from "./read-actions";
import type {
  ContextFileResponse,
  ContextTreeResponse,
  McpAdoptionResponse,
  SkillAdoptionResponse,
} from "./types";

/**
 * The read actions gate on `context.read` and so return the action-kit result
 * envelope. Unwrap it to the plain payload SWR expects, turning a denial or
 * read error into a rejection so the hook surfaces its error state.
 */
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } };
function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export function useContextTree(
  appId: string,
  opts: { fallbackData?: ContextTreeResponse; snapshotId?: string } = {},
) {
  // `fallbackData` paints instantly from the RSC seed; SWR then revalidates
  // once in the background (matching the previous fetch-on-mount) and on every
  // explicit `mutate()`. Not `revalidateOnMount:false` — with fallbackData that
  // leaves the key "never loaded" and re-derives `isLoading:true` on a later
  // re-render, blanking the surface behind the loading skeleton.
  // live: background-revalidates the RSC-seeded tree once after mount and on every mutate() (a commit, resync, or mirror-head poll) — the seed alone can't reflect a change that lands after the page rendered.
  return useSWR(
    appId ? (["context-tree", appId, opts.snapshotId] as const) : null,
    () => getContextTree({ appId, snapshotId: opts.snapshotId }).then(unwrap),
    { revalidateOnFocus: false, fallbackData: opts.fallbackData },
  );
}

export function useContextFile(
  appId: string,
  path: string | null,
  opts: { fallbackData?: ContextFileResponse; snapshotId?: string } = {},
) {
  // live: background-revalidates the RSC-seeded file content on every file switch and mutate() — the seed alone reflects only the file selected at initial load, not a later switch.
  return useSWR(
    appId && path ? (["context-file", appId, path, opts.snapshotId] as const) : null,
    () => getContextFile({ appId, path: path as string, snapshotId: opts.snapshotId }).then(unwrap),
    { revalidateOnFocus: false, fallbackData: opts.fallbackData },
  );
}

/**
 * Per-skill activation counts overlaying the tree's installed skills. Seeded
 * with the tree from the RSC; a slow or absent analytics backend never blocks
 * the tree because the seed already carries the overlay. `mutate()` re-reads it
 * independently of the (heavier) tree.
 */
export function useContextSkillAdoption(
  appId: string,
  opts: { fallbackData?: SkillAdoptionResponse } = {},
) {
  // live: background-revalidates the skill-adoption overlay independently of the tree, via mutate() — the seed alone can't reflect activation counts the (heavier, separately-loaded) analytics backend updates after the page rendered.
  return useSWR(
    appId ? (["context-skill-adoption", appId] as const) : null,
    () => getContextSkillAdoption({ appId }).then(unwrap),
    { revalidateOnFocus: false, fallbackData: opts.fallbackData },
  );
}

/**
 * Per-skill drill-down (trend, activating sessions, topic breakdown). Loads
 * when its panel expands (not on page load), keyed on the skill so each open
 * panel fetches once and expanding another skill doesn't refetch the first;
 * `skill` null = panel closed, no request.
 */
export function useContextSkillDrilldown(appId: string, skill: string | null) {
  // live: loads only when the skill panel expands, a user action, not page load — there is no RSC seed for a drill-down the page never rendered.
  return useSWR(
    appId && skill ? (["context-skill-drilldown", appId, skill] as const) : null,
    () => getContextSkillDrilldown({ appId, skill: skill as string }).then(unwrap),
    { revalidateOnFocus: false },
  );
}

/**
 * Per-server MCP usage overlaying the tree's mcp.json rows. Seeded with the
 * tree from the RSC, same non-blocking posture as the skill overlay: a slow or
 * absent analytics backend never blocks the tree because the seed already
 * carries the overlay. `mutate()` re-reads it independently of the tree.
 */
export function useContextMcpAdoption(
  appId: string,
  opts: { fallbackData?: McpAdoptionResponse } = {},
) {
  // live: background-revalidates the mcp-adoption overlay independently of the tree, via mutate() — the seed alone can't reflect usage counts the (heavier, separately-loaded) analytics backend updates after the page rendered.
  return useSWR(
    appId ? (["context-mcp-adoption", appId] as const) : null,
    () => getContextMcpAdoption({ appId }).then(unwrap),
    { revalidateOnFocus: false, fallbackData: opts.fallbackData },
  );
}

/**
 * Per-server drill-down (tool breakdown, trend, calling sessions). Loads when
 * its panel expands (not on page load), keyed on the server so each open panel
 * fetches once and expanding another server doesn't refetch the first;
 * `server` null = panel closed, no request.
 */
export function useContextMcpDrilldown(appId: string, server: string | null) {
  // live: loads only when the mcp-server panel expands, a user action, not page load — there is no RSC seed for a drill-down the page never rendered.
  return useSWR(
    appId && server ? (["context-mcp-drilldown", appId, server] as const) : null,
    () => getContextMcpDrilldown({ appId, server: server as string }).then(unwrap),
    { revalidateOnFocus: false },
  );
}
