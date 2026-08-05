/**
 * Unit coverage for the skill- and MCP-adoption ClickHouse reads: the service
 * builds the tenant row-policy client scoped to `{ tenantId, appId }` (so
 * ClickHouse enforces `SQL_tenant_id`), maps the rollup rows to the wire shape
 * (coercing UInt64 strings to numbers, normalizing empty timestamps to null),
 * and degrades to an empty payload when no analytics backend is configured.
 * Cross-tenant isolation of the row-policy client itself is proven in the
 * analytics slice; the assertion here is the scope wiring.
 */
vi.mock("server-only", () => ({}));

const { chState } = vi.hoisted(() => ({
  chState: {
    rows: [] as Record<string, unknown>[],
    // Per-fanned-out-query rows, keyed by a stable substring of that query's SQL
    // (its table / GROUP BY). A drill-down runs three builders through the same
    // client; keying on the query — not call order — means a builder-to-slot
    // swap feeds the WRONG-shaped rows into a slot and changes the output.
    rowsByToken: null as Record<string, Record<string, unknown>[]> | null,
    queries: [] as { query: string; params: Record<string, unknown> }[],
    scopes: [] as { tenantId: string; appId?: string }[],
    configured: true,
    rejectQuery: false,
  },
}));

vi.mock("@/lib/analytics/client", () => ({
  createTenantReadClient: (scope: { tenantId: string; appId?: string }) => {
    chState.scopes.push(scope);
    if (!chState.configured) return null;
    return {
      query: (args: { query: string; query_params: Record<string, unknown> }) => {
        chState.queries.push({ query: args.query, params: args.query_params });
        if (chState.rejectQuery) return Promise.reject(new Error("clickhouse unavailable"));
        let rows = chState.rows;
        if (chState.rowsByToken) {
          const hit = Object.entries(chState.rowsByToken).find(([token]) => args.query.includes(token));
          rows = hit ? hit[1] : [];
        }
        return Promise.resolve({ json: async () => rows });
      },
    };
  },
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ContextReadService,
  getMcpAdoption,
  getMcpDrilldown,
  getSkillAdoption,
  getSkillDrilldown,
  load,
} from "./service";
import type { Database } from "../../types/db";

beforeEach(() => {
  chState.rows = [];
  chState.rowsByToken = null;
  chState.queries = [];
  chState.scopes = [];
  chState.configured = true;
  chState.rejectQuery = false;
});

/**
 * A canned RLS-client stub for `ContextReadService`. Each mirror read is
 * `from(table).select(cols)...` ending in `.maybeSingle()` (one row) or awaited
 * directly (an array); the service issues a fixed, distinguishable
 * `${table}|${cols}` per read, so responses keyed that way answer each call
 * exactly — no chainable-query faking beyond match/eq/in/order/limit no-ops.
 */
function makeSupabase(responses: Record<string, unknown>): SupabaseClient<Database> {
  const build = (table: string) => {
    let cols = "";
    const b: Record<string, unknown> = {
      select: (c: string) => {
        cols = c;
        return b;
      },
      match: () => b,
      eq: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: responses[`${table}|${cols}`] ?? null }),
      then: (resolve: (v: { data: unknown }) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: responses[`${table}|${cols}`] ?? [] }).then(resolve, reject),
    };
    return b;
  };
  return { from: (table: string) => build(table) } as unknown as SupabaseClient<Database>;
}

describe("getSkillAdoption", () => {
  it("builds the row-policy client scoped to the tenant + app and maps rows to numbers", async () => {
    chState.rows = [
      { skill: "writing", recentActivations: "12", totalActivations: "40", totalSessions: "6", lastActivatedAt: "2026-07-16 09:00:00" },
      { skill: "deploy", recentActivations: "0", totalActivations: "3", totalSessions: "2", lastActivatedAt: "" },
    ];

    const result = await getSkillAdoption({ tenantId: "t1", appId: "app-1" });

    expect(chState.scopes).toEqual([{ tenantId: "t1", appId: "app-1" }]);
    expect(chState.queries[0]!.params).toEqual({ tenantId: "t1", appId: "app-1", lookbackDays: 90, recentDays: 14 });
    expect(result).toEqual({
      skills: [
        { skillName: "writing", recentActivations: 12, totalActivations: 40, totalSessions: 6, lastActivatedAt: "2026-07-16 09:00:00" },
        { skillName: "deploy", recentActivations: 0, totalActivations: 3, totalSessions: 2, lastActivatedAt: null },
      ],
      recentDays: 14,
      lookbackDays: 90,
    });
  });

  it("degrades to an empty overlay (never a query) when no analytics backend is configured", async () => {
    chState.configured = false;

    const result = await getSkillAdoption({ tenantId: "t1", appId: "app-1" });

    expect(result).toEqual({ skills: [], recentDays: 14, lookbackDays: 90 });
    expect(chState.queries).toEqual([]);
  });
});

describe("getSkillDrilldown", () => {
  it("maps each fanned-out query into its own slot with distinct per-query rows", async () => {
    // DISTINCT rows per builder (keyed by the query's own table), with values
    // that differ across slots — so a builder-to-slot swap or a field-mapping
    // slip changes the asserted output rather than passing on a shared row.
    chState.rowsByToken = {
      // Tokens unique to ONE query each: the topics query references
      // skill_activation_sessions in a subquery, so the sessions rows key on the
      // agent_session_summary join that only the sessions query carries.
      skill_activation_by_day: [{ day: "2026-07-19", activations: "3", sessions: "2" }],
      agent_session_summary: [
        { traceId: "tr-1", title: "Fix flaky test", activations: "5", lastActivatedAt: "2026-07-19 09:00:00" },
        { traceId: "tr-2", title: "", activations: "1", lastActivatedAt: "" },
      ],
      trace_facets: [{ topicId: "topic-9", name: "CI debugging", sessions: "7" }],
    };

    const result = await getSkillDrilldown({ tenantId: "t1", appId: "app-1", skill: "writing" });

    expect(chState.scopes).toEqual([{ tenantId: "t1", appId: "app-1" }]);
    // Slot order is pinned: trend, then sessions (with its row cap), then topics.
    expect(chState.queries).toHaveLength(3);
    expect(chState.queries[0]!.query).toContain("skill_activation_by_day");
    expect(chState.queries[1]!.query).toContain("skill_activation_sessions");
    expect(chState.queries[1]!.params).toMatchObject({ skill: "writing", lookbackDays: 90, limit: 20 });
    expect(chState.queries[2]!.query).toContain("trace_facets");
    expect(result.trend).toEqual([{ day: "2026-07-19", activations: 3, sessions: 2 }]);
    expect(result.sessions).toEqual([
      { traceId: "tr-1", title: "Fix flaky test", activations: 5, lastActivatedAt: "2026-07-19 09:00:00" },
      // Empty title / timestamp normalize to null (the `|| null` guards).
      { traceId: "tr-2", title: null, activations: 1, lastActivatedAt: null },
    ]);
    expect(result.topics).toEqual([{ topicId: "topic-9", name: "CI debugging", sessions: 7 }]);
    expect(result.lookbackDays).toBe(90);
  });

  it("degrades to an empty payload when no analytics backend is configured", async () => {
    chState.configured = false;

    const result = await getSkillDrilldown({ tenantId: "t1", appId: "app-1", skill: "writing" });

    expect(result).toEqual({ trend: [], sessions: [], topics: [], lookbackDays: 90 });
    expect(chState.queries).toEqual([]);
  });
});

describe("getMcpAdoption", () => {
  it("builds the row-policy client scoped to the tenant + app and maps rows to numbers", async () => {
    chState.rows = [
      { server: "playwright", recentCalls: "40", totalCalls: "120", totalSessions: "15", lastUsedAt: "2026-07-16 09:00:00" },
      { server: "old-crm", recentCalls: "0", totalCalls: "3", totalSessions: "2", lastUsedAt: "" },
    ];

    const result = await getMcpAdoption({ tenantId: "t1", appId: "app-1" });

    expect(chState.scopes).toEqual([{ tenantId: "t1", appId: "app-1" }]);
    expect(chState.queries[0]!.params).toEqual({ tenantId: "t1", appId: "app-1", lookbackDays: 90, recentDays: 14 });
    expect(result).toEqual({
      servers: [
        { serverName: "playwright", recentCalls: 40, totalCalls: 120, totalSessions: 15, lastUsedAt: "2026-07-16 09:00:00" },
        { serverName: "old-crm", recentCalls: 0, totalCalls: 3, totalSessions: 2, lastUsedAt: null },
      ],
      recentDays: 14,
      lookbackDays: 90,
    });
  });

  it("degrades to an empty overlay (never a query) when no analytics backend is configured", async () => {
    chState.configured = false;

    const result = await getMcpAdoption({ tenantId: "t1", appId: "app-1" });

    expect(result).toEqual({ servers: [], recentDays: 14, lookbackDays: 90 });
    expect(chState.queries).toEqual([]);
  });
});

describe("getMcpDrilldown", () => {
  it("maps each fanned-out query into its own slot with distinct per-query rows", async () => {
    // Tools and trend both read mcp_tool_use, so the token keys on the GROUP BY
    // that separates them; sessions joins agent_session_summary. Distinct
    // per-slot values catch a builder-to-slot swap or a field-mapping slip.
    chState.rowsByToken = {
      "GROUP BY Tool": [
        { tool: "browser_click", recentCalls: "30", totalCalls: "90", sessions: "12", lastUsedAt: "2026-07-19 09:00:00" },
        { tool: "browser_drag", recentCalls: "0", totalCalls: "2", sessions: "1", lastUsedAt: "" },
      ],
      "GROUP BY Day": [{ day: "2026-07-19", calls: "8", sessions: "4" }],
      agent_session_summary: [
        { traceId: "tr-1", title: "Fix flaky e2e", calls: "6", lastUsedAt: "2026-07-19 09:00:00" },
        { traceId: "tr-2", title: "", calls: "1", lastUsedAt: "" },
      ],
    };

    const result = await getMcpDrilldown({ tenantId: "t1", appId: "app-1", server: "playwright" });

    expect(chState.scopes).toEqual([{ tenantId: "t1", appId: "app-1" }]);
    // Slot order is pinned: tools (with recentDays), then trend, then sessions.
    expect(chState.queries).toHaveLength(3);
    expect(chState.queries[0]!.query).toContain("GROUP BY Tool");
    expect(chState.queries[0]!.params).toMatchObject({ server: "playwright", lookbackDays: 90, recentDays: 14 });
    expect(chState.queries[1]!.query).toContain("GROUP BY Day");
    expect(chState.queries[2]!.params).toMatchObject({ limit: 20 });
    expect(result.tools).toEqual([
      { tool: "browser_click", recentCalls: 30, totalCalls: 90, sessions: 12, lastUsedAt: "2026-07-19 09:00:00" },
      { tool: "browser_drag", recentCalls: 0, totalCalls: 2, sessions: 1, lastUsedAt: null },
    ]);
    expect(result.trend).toEqual([{ day: "2026-07-19", calls: 8, sessions: 4 }]);
    expect(result.sessions).toEqual([
      { traceId: "tr-1", title: "Fix flaky e2e", calls: 6, lastUsedAt: "2026-07-19 09:00:00" },
      { traceId: "tr-2", title: null, calls: 1, lastUsedAt: null },
    ]);
    expect(result.lookbackDays).toBe(90);
    expect(result.recentDays).toBe(14);
  });

  it("degrades to an empty payload when no analytics backend is configured", async () => {
    chState.configured = false;

    const result = await getMcpDrilldown({ tenantId: "t1", appId: "app-1", server: "playwright" });

    expect(result).toEqual({ tools: [], trend: [], sessions: [], lookbackDays: 90, recentDays: 14 });
    expect(chState.queries).toEqual([]);
  });
});

describe("ContextReadService.getTree", () => {
  const CONNECTED = {
    "git_connection|repository, provider": { repository: "acme/app", provider: "github" },
    "git_branch|branch_name": { branch_name: "main" },
    "app|require_pull_request": { require_pull_request: true },
    "context_head|commit_sha, snapshot_id, synced_at": {
      commit_sha: "sha-head",
      snapshot_id: "snap-1",
      synced_at: "2026-07-19T00:00:00Z",
    },
    "context_tree_entry|path, blob_sha": [
      { path: ".outerlayer/AGENTS.md", blob_sha: "sha-agents" },
      { path: ".outerlayer/mcp.json", blob_sha: "sha-mcp" },
    ],
    "context_blob|blob_sha, content": [
      { blob_sha: "sha-mcp", content: '{"mcpServers":{"alpha":{},"beta":{}}}' },
    ],
    "context_snapshot|excluded_counts": {
      excluded_counts: [{ scopePath: "", skillName: "deploy", count: 3 }],
    },
  };

  it("assembles connection, head, entries, mcp server counts, excluded counts, and the PR policy", async () => {
    const service = new ContextReadService(makeSupabase(CONNECTED));

    const result = await service.getTree("app-1");

    expect(result.gitConnection).toEqual({ repository: "acme/app", branch: "main", provider: "github" });
    expect(result.head).toEqual({ commitSha: "sha-head", snapshotId: "snap-1", syncedAt: "2026-07-19T00:00:00Z" });
    // `require_pull_request: true` flows through unchanged (the `?? false` only bites on null).
    expect(result.requirePullRequest).toBe(true);
    expect(result.excludedCounts).toEqual([{ scopePath: "", skillName: "deploy", count: 3 }]);
    // The mcp.json blob is parsed to its installed server list; the count is its length.
    expect(result.mcpServerCounts).toEqual([
      { path: ".outerlayer/mcp.json", count: 2, servers: ["alpha", "beta"] },
    ]);
    // Each tree row carries its own blob sha through (path → blob_sha mapping).
    expect(result.entries.find((e) => e.path === ".outerlayer/mcp.json")?.blobSha).toBe("sha-mcp");
    expect(result.entries.find((e) => e.path === ".outerlayer/AGENTS.md")?.blobSha).toBe("sha-agents");
  });

  it("returns the connect-a-repo empty shape when the app has no git connection", async () => {
    const service = new ContextReadService(makeSupabase({ "app|require_pull_request": null }));

    const result = await service.getTree("app-1");

    expect(result.gitConnection).toBeNull();
    expect(result.head).toBeNull();
    expect(result.entries).toEqual([]);
    // A missing app row degrades the PR policy to false, never true.
    expect(result.requirePullRequest).toBe(false);
  });

  it("returns connected-but-empty when a connection exists but the branch was never synced", async () => {
    const service = new ContextReadService(
      makeSupabase({
        "git_connection|repository, provider": { repository: "acme/app", provider: "github" },
        "git_branch|branch_name": { branch_name: "main" },
        "app|require_pull_request": { require_pull_request: false },
        "context_head|commit_sha, snapshot_id, synced_at": null,
      }),
    );

    const result = await service.getTree("app-1");

    // Connection surfaces, but with no head there is no snapshot → no entries.
    expect(result.gitConnection).toEqual({ repository: "acme/app", branch: "main", provider: "github" });
    expect(result.head).toBeNull();
    expect(result.entries).toEqual([]);
  });
});

describe("ContextReadService.getFile", () => {
  const base = {
    "git_connection|repository, provider": { repository: "acme/app", provider: "github" },
    "git_branch|branch_name": { branch_name: "main" },
    "context_head|commit_sha, snapshot_id, synced_at": {
      commit_sha: "sha-head",
      snapshot_id: "snap-1",
      synced_at: "2026-07-19T00:00:00Z",
    },
  };

  it("returns the file at head with its blob content and the head commit sha", async () => {
    const service = new ContextReadService(
      makeSupabase({
        ...base,
        "context_tree_entry|kind, blob_sha": { kind: "reference", blob_sha: "sha-file" },
        "context_blob|content": { content: "# Agents" },
      }),
    );

    const result = await service.getFile("app-1", ".outerlayer/AGENTS.md");

    expect(result.path).toBe(".outerlayer/AGENTS.md");
    expect(result.kind).toBe("reference");
    expect(result.blobSha).toBe("sha-file");
    expect(result.commitSha).toBe("sha-head");
    expect(result.content).toBe("# Agents");
    expect(result.oversize).toBe(false);
  });

  it("marks a file oversize with null content when the blob row is absent (not mirrored)", async () => {
    const service = new ContextReadService(
      makeSupabase({
        ...base,
        "context_tree_entry|kind, blob_sha": { kind: "reference", blob_sha: "sha-big" },
        "context_blob|content": null,
      }),
    );

    const result = await service.getFile("app-1", ".outerlayer/AGENTS.md");

    expect(result.content).toBeNull();
    expect(result.oversize).toBe(true);
  });

  it("throws not-found when the path is absent from the snapshot", async () => {
    const service = new ContextReadService(
      makeSupabase({ ...base, "context_tree_entry|kind, blob_sha": null }),
    );

    await expect(service.getFile("app-1", "gone.md")).rejects.toThrow(/not found in snapshot/);
  });

  it("refuses a folder-keeper entry as a file", async () => {
    const service = new ContextReadService(
      makeSupabase({
        ...base,
        "context_tree_entry|kind, blob_sha": { kind: "folder", blob_sha: "sha-keep" },
      }),
    );

    await expect(service.getFile("app-1", ".outerlayer/skills/x")).rejects.toThrow(/not found in snapshot/);
  });

  it("uses the pinned snapshot's own commit sha when reading a non-head snapshot", async () => {
    const service = new ContextReadService(
      makeSupabase({
        ...base,
        "context_tree_entry|kind, blob_sha": { kind: "reference", blob_sha: "sha-file" },
        "context_blob|content": { content: "# old" },
        "context_snapshot|commit_sha": { commit_sha: "sha-pinned" },
      }),
    );

    const result = await service.getFile("app-1", ".outerlayer/AGENTS.md", "snap-old");

    // Explicit snapshot ≠ head → the commit sha comes from the pinned snapshot.
    expect(result.commitSha).toBe("sha-pinned");
    expect(result.content).toBe("# old");
  });
});

describe("ContextReadService.getSyncHistory", () => {
  /**
   * Captures the exact query chain — the projection, the app_id filter, the
   * DESC ordering, and the `.range` pagination bounds — instead of a canned
   * fixed-shape stub: this is the boundary the read action re-homes the
   * client-side ledger query onto, so its args are the behavior under test.
   */
  function makeHistorySupabase(rows: unknown[], count: number) {
    const calls: {
      table?: string;
      select?: string;
      selectOpts?: unknown;
      eq?: [string, unknown];
      order?: [string, unknown];
      range?: [number, number];
    } = {};
    const chain = {
      select: (cols: string, opts?: unknown) => {
        calls.select = cols;
        calls.selectOpts = opts;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        calls.eq = [col, val];
        return chain;
      },
      order: (col: string, opts: unknown) => {
        calls.order = [col, opts];
        return chain;
      },
      range: (from: number, to: number) => {
        calls.range = [from, to];
        return Promise.resolve({ data: rows, count });
      },
    };
    const supabase = {
      from: (table: string) => {
        calls.table = table;
        return chain;
      },
    } as unknown as SupabaseClient<Database>;
    return { supabase, calls };
  }

  it("queries the ledger scoped to app_id, newest-first, with the page's exact range bounds", async () => {
    const rows = [{ id: "evt-1" }];
    const { supabase, calls } = makeHistorySupabase(rows, 47);
    const service = new ContextReadService(supabase);

    const result = await service.getSyncHistory("app-1", 2, 20);

    expect(calls.table).toBe("context_sync_event");
    expect(calls.select).toBe("*");
    expect(calls.selectOpts).toEqual({ count: "exact" });
    expect(calls.eq).toEqual(["app_id", "app-1"]);
    expect(calls.order).toEqual(["created_at", { ascending: false }]);
    // Page 2 (0-based) at pageSize 20 → rows 40..59.
    expect(calls.range).toEqual([40, 59]);
    expect(result).toEqual({ rows, total: 47 });
  });

  it("defaults total to 0 and rows to [] when the query returns no count/data", async () => {
    const { supabase } = makeHistorySupabase(
      undefined as unknown as unknown[],
      undefined as unknown as number,
    );
    const service = new ContextReadService(supabase);

    const result = await service.getSyncHistory("app-1", 0, 10);

    expect(result).toEqual({ rows: [], total: 0 });
  });
});

describe("load", () => {
  // Minimal RLS client: every mirror read resolves empty, so getTree returns
  // the no-git-connection tree without needing the full table graph. The
  // overlays run against the (mocked) ClickHouse client, which is what this
  // test drives.
  const emptyMaybe = { maybeSingle: async () => ({ data: null }) };
  const supabaseStub = {
    from: () => ({ select: () => ({ eq: () => emptyMaybe, match: () => emptyMaybe }) }),
  } as unknown as SupabaseClient<Database>;

  it("degrades a failed adoption-overlay read to an empty overlay (logged) without failing the tree", async () => {
    chState.rejectQuery = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await load(supabaseStub, "t1", "app-1");

    // The tree still resolves — a rejected analytics read must not take the
    // whole context render down with it.
    expect(result.tree.gitConnection).toBeNull();
    expect(result.tree.entries).toEqual([]);
    expect(result.file).toBeNull();
    // Both overlays fall back to their empty (window-bounded) shape.
    expect(result.skillAdoption).toEqual({ skills: [], recentDays: 14, lookbackDays: 90 });
    expect(result.mcpAdoption).toEqual({ servers: [], recentDays: 14, lookbackDays: 90 });
    // The failures are logged for operators, with the stable domain prefix.
    expect(errorSpy).toHaveBeenCalledWith("[context] skill-adoption overlay read failed:", expect.any(Error));
    expect(errorSpy).toHaveBeenCalledWith("[context] mcp-adoption overlay read failed:", expect.any(Error));

    errorSpy.mockRestore();
  });
});
