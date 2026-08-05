import "server-only";

/**
 * The context authoring read surface. Two tiers live here:
 *
 * - `ContextReadService` — Supabase mirror reads (tree + file). Takes an
 *   AUTHENTICATED server client (never service_role): every SELECT is gated by
 *   the `context.read` RLS policy on the mirror tables, so a caller lacking the
 *   permission transparently sees zero rows — the same shape as "no context
 *   yet". Steady-state browsing issues ZERO git-provider calls: the connected
 *   repo/branch and every file's content come from the mirror.
 * - `getSkillAdoption` / `getSkillDrilldown` — ClickHouse usage telemetry that
 *   overlays the tree's installed skills. Read through the tenant row-policy
 *   client, so ClickHouse itself enforces `TenantId = SQL_tenant_id`. With no
 *   analytics backend configured the overlay degrades to empty rather than
 *   erroring: the tree is the product, adoption is a bonus annotation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError } from "@repo/observability-service";
import {
  buildSkillAdoptionQuery,
  buildSkillSessionsQuery,
  buildSkillTopicsQuery,
  buildSkillTrendQuery,
  buildMcpAdoptionQuery,
  buildMcpServerSessionsQuery,
  buildMcpServerToolsQuery,
  buildMcpServerTrendQuery,
  type SkillAdoptionRow,
  type SkillSessionRow,
  type SkillTopicRow,
  type SkillTrendRow,
  type McpServerRow,
  type McpSessionRow,
  type McpToolRow,
  type McpTrendRow,
} from "@repo/observability-service";
import type { ContextKind } from "@repo/context-core";
import { createTenantReadClient } from "@/lib/analytics/client";
import type { Database } from "../../types/db";
import {
  deriveFileResponse,
  deriveTreeResponse,
  type RawTreeRow,
} from "./read-model";
import type {
  ContextExcludedCount,
  ContextFileResponse,
  ContextGitConnection,
  ContextHead,
  ContextSyncHistoryResponse,
  ContextTreeResponse,
  McpAdoptionResponse,
  McpDrilldownResponse,
  SkillAdoptionResponse,
  SkillDrilldownResponse,
} from "./types";

/** Recent-activity window separating "active" from "gone quiet". */
const SKILL_RECENT_DAYS = 14;
/** Total scan window — the horizon past which a skill counts as never used. */
const SKILL_LOOKBACK_DAYS = 90;
/** Sessions listed in a skill's drill-down (most recent first). */
const SKILL_SESSION_LIMIT = 20;

/** Recent-activity window separating an "active" server from one that has gone quiet. */
const MCP_RECENT_DAYS = 14;
/** Total scan window — the horizon past which a server counts as never used. */
const MCP_LOOKBACK_DAYS = 90;
/** Sessions listed in a server's drill-down (most recent first). */
const MCP_SESSION_LIMIT = 20;

/** Thrown when a file path is not part of the resolved snapshot — mapped to 404 by the caller. */
function fileNotFound(path: string): NotFoundError {
  return new NotFoundError(`context file not found in snapshot: ${path}`);
}

export class ContextReadService {
  constructor(private readonly supabase: SupabaseClient<Database>) {}

  /**
   * The app's git connection (repository + connected branch), or `null` when
   * the app has no connection. Read straight from the mirror-adjacent tables —
   * no provider call.
   */
  private async loadGitConnection(appId: string): Promise<ContextGitConnection | null> {
    const { data: connection } = await this.supabase
      .from("git_connection")
      .select("repository, provider")
      .match({ app_id: appId })
      .maybeSingle();
    if (!connection?.repository) return null;

    const { data: branch } = await this.supabase
      .from("git_branch")
      .select("branch_name")
      .match({ app_id: appId })
      .maybeSingle();
    if (!branch?.branch_name) return null;

    return { repository: connection.repository, branch: branch.branch_name, provider: connection.provider };
  }

  /**
   * App publish policy (`app.require_pull_request`) — read the same way the
   * save-service policy port does, so the publish dialog's forced-PR default
   * matches what a commit would actually do. Missing/unreadable → false.
   */
  private async loadRequirePullRequest(appId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from("app")
      .select("require_pull_request")
      .eq("id", appId)
      .maybeSingle();
    return data?.require_pull_request ?? false;
  }

  /** The synced head for the connected branch, or `null` when never synced. */
  private async loadHead(appId: string, branch: string): Promise<ContextHead | null> {
    const { data } = await this.supabase
      .from("context_head")
      .select("commit_sha, snapshot_id, synced_at")
      .match({ app_id: appId, branch })
      .maybeSingle();
    if (!data) return null;
    return { commitSha: data.commit_sha, snapshotId: data.snapshot_id, syncedAt: data.synced_at };
  }

  /** Commit sha a snapshot was built from — needed for the file response when a snapshot is pinned explicitly. */
  private async loadSnapshotCommit(appId: string, snapshotId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from("context_snapshot")
      .select("commit_sha")
      .match({ app_id: appId, id: snapshotId })
      .maybeSingle();
    return data?.commit_sha ?? null;
  }

  /**
   * Tree at head (default) or at an explicit snapshot. Always returns a
   * well-formed response: empty entries with `head: null` / `gitConnection: null`
   * drives the correct empty state in the UI.
   */
  async getTree(appId: string, snapshotId?: string): Promise<ContextTreeResponse> {
    // Independent reads — one round-trip instead of two serial ones.
    const [requirePullRequest, gitConnection] = await Promise.all([
      this.loadRequirePullRequest(appId),
      this.loadGitConnection(appId),
    ]);
    if (!gitConnection) {
      return deriveTreeResponse({ gitConnection: null, head: null, rows: [], requirePullRequest });
    }

    const head = await this.loadHead(appId, gitConnection.branch);
    const resolvedSnapshotId = snapshotId ?? head?.snapshotId ?? null;
    if (!resolvedSnapshotId) {
      return deriveTreeResponse({ gitConnection, head: null, rows: [], requirePullRequest });
    }

    const { data } = await this.supabase
      .from("context_tree_entry")
      .select("path, blob_sha")
      .match({ app_id: appId, snapshot_id: resolvedSnapshotId });

    const rows: RawTreeRow[] = (data ?? []).map((r) => ({ path: r.path, blobSha: r.blob_sha }));
    const mcpContents = await this.loadMcpContents(appId, rows);
    // Excluded counts are computed from the FULL git tree at sync time and
    // stored on the snapshot — the asset paths that feed them are never
    // mirrored, so they cannot be re-derived from tree entries at read time.
    const excludedCounts = await this.loadExcludedCounts(appId, resolvedSnapshotId);
    return deriveTreeResponse({
      gitConnection,
      head,
      rows,
      mcpContents,
      excludedCounts,
      requirePullRequest,
    });
  }

  /** The snapshot's stored per-skill excluded-file counts (jsonb blob, camelCase shape). */
  private async loadExcludedCounts(
    appId: string,
    snapshotId: string,
  ): Promise<ContextExcludedCount[]> {
    const { data } = await this.supabase
      .from("context_snapshot")
      .select("excluded_counts")
      .match({ app_id: appId, id: snapshotId })
      .maybeSingle();
    return (data?.excluded_counts as ContextExcludedCount[] | null) ?? [];
  }

  /**
   * Fetches the (small, few) `mcp.json` blobs so the tree can annotate each with
   * its server count. Bounded — typically 0–2 per repo — and mirror-served, so
   * it keeps browsing free of git-provider calls.
   */
  private async loadMcpContents(appId: string, rows: RawTreeRow[]): Promise<Map<string, string>> {
    const mcpRows = rows.filter((r) => r.path.endsWith("/mcp.json") || r.path === "mcp.json");
    if (mcpRows.length === 0) return new Map();

    const shas = [...new Set(mcpRows.map((r) => r.blobSha))];
    const { data } = await this.supabase
      .from("context_blob")
      .select("blob_sha, content")
      .match({ app_id: appId })
      .in("blob_sha", shas);

    const contentBySha = new Map((data ?? []).map((b) => [b.blob_sha, b.content]));
    const out = new Map<string, string>();
    for (const row of mcpRows) {
      const content = contentBySha.get(row.blobSha);
      if (content !== undefined) out.set(row.path, content);
    }
    return out;
  }

  /**
   * One file at head (default) or at an explicit snapshot. Throws a
   * `NotFoundError` (→ 404) when the path is absent from the resolved
   * snapshot. Oversize blobs (>1 MB, not mirrored) resolve with
   * `content: null` + `oversize: true`.
   */
  async getFile(appId: string, path: string, snapshotId?: string): Promise<ContextFileResponse> {
    const gitConnection = await this.loadGitConnection(appId);
    if (!gitConnection) throw fileNotFound(path);

    const head = await this.loadHead(appId, gitConnection.branch);
    const resolvedSnapshotId = snapshotId ?? head?.snapshotId ?? null;
    if (!resolvedSnapshotId) throw fileNotFound(path);

    const { data: entry } = await this.supabase
      .from("context_tree_entry")
      .select("kind, blob_sha")
      .match({ app_id: appId, snapshot_id: resolvedSnapshotId, path })
      .maybeSingle();
    if (!entry) throw fileNotFound(path);
    // A `folder` entry is a `.gitkeep` keeper — it anchors an empty directory in
    // the tree and has no viewable content. Refuse to open it as a file.
    if ((entry.kind as ContextKind) === "folder") throw fileNotFound(path);

    const commitSha =
      snapshotId && snapshotId !== head?.snapshotId
        ? ((await this.loadSnapshotCommit(appId, snapshotId)) ?? "")
        : (head?.commitSha ?? "");

    const { data: blob } = await this.supabase
      .from("context_blob")
      .select("content")
      .match({ app_id: appId, blob_sha: entry.blob_sha })
      .maybeSingle();

    return deriveFileResponse({
      path,
      kind: entry.kind as ContextKind,
      blobSha: entry.blob_sha,
      commitSha,
      // Blob row absent ⇒ oversize (indexed but not content-mirrored).
      content: blob ? blob.content : null,
    });
  }

  /**
   * One page of the `context_sync_event` ledger for the app, newest-first,
   * with an exact total for the pager. Same RLS-scoped client as the tree/file
   * reads — a caller lacking `context.read` sees an empty page, not an error.
   */
  async getSyncHistory(
    appId: string,
    page: number,
    pageSize: number,
  ): Promise<ContextSyncHistoryResponse> {
    const from = page * pageSize;
    const { data, count } = await this.supabase
      .from("context_sync_event")
      .select("*", { count: "exact" })
      .eq("app_id", appId)
      .order("created_at", { ascending: false })
      .range(from, from + pageSize - 1);
    return { rows: data ?? [], total: count ?? 0 };
  }
}

/** The seed the context React Server Component (RSC) hands its client subsystem for first paint. */
interface ContextLoad {
  tree: ContextTreeResponse;
  /** The initially-selected file (from the `?file=` param), or `null` when none is selected or it 404s. */
  file: ContextFileResponse | null;
  skillAdoption: SkillAdoptionResponse;
  mcpAdoption: McpAdoptionResponse;
}

/**
 * Composes the reads the context page needs for its first server render: the
 * tree, the skill- and MCP-adoption overlays, and — when a file is selected via
 * `?file=` — that file. A selected path absent from the snapshot resolves to `null`
 * (a stale deep-link must not crash the page) rather than propagating the
 * not-found; the client re-reads through the read actions after hydration.
 */
export async function load(
  supabase: SupabaseClient<Database>,
  tenantId: string,
  appId: string,
  filePath?: string | null,
): Promise<ContextLoad> {
  const service = new ContextReadService(supabase);
  const [tree, skillAdoption, mcpAdoption, file] = await Promise.all([
    service.getTree(appId),
    // The adoption overlays are annotations on the tree, not the tree itself: a
    // failed analytics read degrades to a blank overlay (logged) instead of
    // taking down the whole context render.
    getSkillAdoption({ tenantId, appId }).catch((err) => {
      console.error("[context] skill-adoption overlay read failed:", err);
      return { skills: [], recentDays: SKILL_RECENT_DAYS, lookbackDays: SKILL_LOOKBACK_DAYS };
    }),
    getMcpAdoption({ tenantId, appId }).catch((err) => {
      console.error("[context] mcp-adoption overlay read failed:", err);
      return { servers: [], recentDays: MCP_RECENT_DAYS, lookbackDays: MCP_LOOKBACK_DAYS };
    }),
    filePath
      ? service.getFile(appId, filePath).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { tree, file, skillAdoption, mcpAdoption };
}

/** Tenant+app scope for a ClickHouse skill-adoption read. */
interface SkillReadScope {
  tenantId: string;
  appId: string;
}

/**
 * Per-skill activation counts overlaying the tree's installed skills. Reads the
 * skill_activated rollup through the tenant row-policy client; no analytics
 * backend configured → an empty overlay (with the window bounds) rather than an
 * error, so the tree still renders without adoption annotations.
 */
export async function getSkillAdoption(scope: SkillReadScope): Promise<SkillAdoptionResponse> {
  const meta = { recentDays: SKILL_RECENT_DAYS, lookbackDays: SKILL_LOOKBACK_DAYS };
  const ch = createTenantReadClient({ tenantId: scope.tenantId, appId: scope.appId });
  if (!ch) return { skills: [], ...meta };

  const { query, params } = buildSkillAdoptionQuery({
    tenantId: scope.tenantId,
    appId: scope.appId,
    lookbackDays: SKILL_LOOKBACK_DAYS,
    recentDays: SKILL_RECENT_DAYS,
  });
  const rows = await ch
    .query({ query, query_params: params, format: "JSONEachRow" })
    .then((r) => r.json<SkillAdoptionRow>());

  return {
    skills: rows.map((row) => ({
      skillName: row.skill,
      recentActivations: Number(row.recentActivations),
      totalActivations: Number(row.totalActivations),
      totalSessions: Number(row.totalSessions),
      lastActivatedAt: row.lastActivatedAt || null,
    })),
    ...meta,
  };
}

/**
 * Per-skill drill-down: the day-grain activation trend, the sessions that
 * activated the skill, and the task topics those sessions cluster under. Same
 * read posture as the overlay — rollup tables only, empty payload when no
 * analytics backend is configured.
 */
export async function getSkillDrilldown(
  scope: SkillReadScope & { skill: string },
): Promise<SkillDrilldownResponse> {
  const meta = { lookbackDays: SKILL_LOOKBACK_DAYS };
  const ch = createTenantReadClient({ tenantId: scope.tenantId, appId: scope.appId });
  if (!ch) return { trend: [], sessions: [], topics: [], ...meta };

  const queryScope = {
    tenantId: scope.tenantId,
    appId: scope.appId,
    skill: scope.skill,
    lookbackDays: SKILL_LOOKBACK_DAYS,
  };
  const run = <T>(built: { query: string; params: Record<string, unknown> }) =>
    ch
      .query({ query: built.query, query_params: built.params, format: "JSONEachRow" })
      .then((r) => r.json<T>());

  const [trend, sessions, topics] = await Promise.all([
    run<SkillTrendRow>(buildSkillTrendQuery(queryScope)),
    run<SkillSessionRow>(buildSkillSessionsQuery({ ...queryScope, limit: SKILL_SESSION_LIMIT })),
    run<SkillTopicRow>(buildSkillTopicsQuery(queryScope)),
  ]);

  return {
    trend: trend.map((row) => ({
      day: row.day,
      activations: Number(row.activations),
      sessions: Number(row.sessions),
    })),
    sessions: sessions.map((row) => ({
      traceId: row.traceId,
      title: row.title || null,
      activations: Number(row.activations),
      lastActivatedAt: row.lastActivatedAt || null,
    })),
    topics: topics.map((row) => ({
      topicId: row.topicId,
      name: row.name,
      sessions: Number(row.sessions),
    })),
    ...meta,
  };
}

/** Tenant+app scope for a ClickHouse MCP-adoption read. */
interface McpReadScope {
  tenantId: string;
  appId: string;
}

/**
 * Per-server call counts overlaying the tree's mcp.json rows. Same read posture
 * as the skill overlay: reads the mcp-usage rollup through the tenant row-policy
 * client, and no analytics backend configured → an empty overlay (with the
 * window bounds) rather than an error.
 */
export async function getMcpAdoption(scope: McpReadScope): Promise<McpAdoptionResponse> {
  const meta = { recentDays: MCP_RECENT_DAYS, lookbackDays: MCP_LOOKBACK_DAYS };
  const ch = createTenantReadClient({ tenantId: scope.tenantId, appId: scope.appId });
  if (!ch) return { servers: [], ...meta };

  const { query, params } = buildMcpAdoptionQuery({
    tenantId: scope.tenantId,
    appId: scope.appId,
    lookbackDays: MCP_LOOKBACK_DAYS,
    recentDays: MCP_RECENT_DAYS,
  });
  const rows = await ch
    .query({ query, query_params: params, format: "JSONEachRow" })
    .then((r) => r.json<McpServerRow>());

  return {
    servers: rows.map((row) => ({
      serverName: row.server,
      recentCalls: Number(row.recentCalls),
      totalCalls: Number(row.totalCalls),
      totalSessions: Number(row.totalSessions),
      lastUsedAt: row.lastUsedAt || null,
    })),
    ...meta,
  };
}

/**
 * Per-server drill-down: the per-tool usage split, the day-grain call trend, and
 * the sessions that called the server. Same read posture as the overlay —
 * rollup tables only, empty payload when no analytics backend is configured.
 */
export async function getMcpDrilldown(
  scope: McpReadScope & { server: string },
): Promise<McpDrilldownResponse> {
  const meta = { lookbackDays: MCP_LOOKBACK_DAYS, recentDays: MCP_RECENT_DAYS };
  const ch = createTenantReadClient({ tenantId: scope.tenantId, appId: scope.appId });
  if (!ch) return { tools: [], trend: [], sessions: [], ...meta };

  const queryScope = {
    tenantId: scope.tenantId,
    appId: scope.appId,
    server: scope.server,
    lookbackDays: MCP_LOOKBACK_DAYS,
  };
  const run = <T>(built: { query: string; params: Record<string, unknown> }) =>
    ch
      .query({ query: built.query, query_params: built.params, format: "JSONEachRow" })
      .then((r) => r.json<T>());

  const [tools, trend, sessions] = await Promise.all([
    run<McpToolRow>(buildMcpServerToolsQuery({ ...queryScope, recentDays: MCP_RECENT_DAYS })),
    run<McpTrendRow>(buildMcpServerTrendQuery(queryScope)),
    run<McpSessionRow>(buildMcpServerSessionsQuery({ ...queryScope, limit: MCP_SESSION_LIMIT })),
  ]);

  return {
    tools: tools.map((row) => ({
      tool: row.tool,
      recentCalls: Number(row.recentCalls),
      totalCalls: Number(row.totalCalls),
      sessions: Number(row.sessions),
      lastUsedAt: row.lastUsedAt || null,
    })),
    trend: trend.map((row) => ({
      day: row.day,
      calls: Number(row.calls),
      sessions: Number(row.sessions),
    })),
    sessions: sessions.map((row) => ({
      traceId: row.traceId,
      title: row.title || null,
      calls: Number(row.calls),
      lastUsedAt: row.lastUsedAt || null,
    })),
    ...meta,
  };
}
