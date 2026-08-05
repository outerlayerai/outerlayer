/**
 * Unit tests for the pure push router. A hand-rolled Supabase stub returns
 * per-table fixtures so we can pin the branch-filtered fan-out and the app-name
 * resolution without a live database.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/db";
import { resolveWatchingApps } from "./resolve-watching-apps";

type TableData = {
  git_connection?: Array<{ app_id: string }>;
  git_branch?: Array<{ app_id: string; tenant_id: string; branch_name: string | null }>;
  app?: Array<{ id: string; name: string }>;
};

type TableErrors = Partial<Record<keyof TableData, { message: string }>>;

/** Build a Supabase stub whose `.from(table)` chain resolves to that table's
 *  fixture (or a seeded PostgREST-style error). `.select/.eq` are chainable
 *  no-ops; `.in(column, values)` genuinely filters the fixture rows by
 *  `row[column] ∈ values` (the real PostgREST semantics) so a broken id
 *  extraction upstream — e.g. `.map(() => undefined)` instead of
 *  `.map(c => c.app_id)` — changes what comes back, not just what's *asked*
 *  for. `.eq` stays a no-op: fixtures already carry only the pre-filtered rows
 *  for the column it's applied to (e.g. `repository`), so real `.eq`
 *  filtering would reject rows that never had that field set at all. Awaiting
 *  the chain yields `{ data, error }`. Records every table queried, in order. */
function makeAdmin(data: TableData, queried: string[] = [], errors: TableErrors = {}) {
  const from = vi.fn((table: keyof TableData) => {
    queried.push(table);
    let inFilter: { column: string; values: unknown[] } | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      in: (column: string, values: unknown[]) => {
        inFilter = { column, values };
        return builder;
      },
    };
    builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
      if (errors[table]) return resolve({ data: null, error: errors[table] });
      let rows = data[table] ?? null;
      if (rows && inFilter) {
        const { column, values } = inFilter;
        rows = (rows as Array<Record<string, unknown>>).filter((row) =>
          values.includes(row[column]),
        ) as typeof rows;
      }
      return resolve({ data: rows, error: null });
    };
    return builder;
  });
  return { from } as unknown as SupabaseClient<Database>;
}

describe("resolveWatchingApps", () => {
  it("returns the branch-matched apps with their names, tenant, and branch", async () => {
    const admin = makeAdmin({
      git_connection: [{ app_id: "app-1" }],
      git_branch: [{ app_id: "app-1", tenant_id: "tenant-1", branch_name: "main" }],
      app: [{ id: "app-1", name: "acme-prompts" }],
    });

    const result = await resolveWatchingApps(admin, {
      repository: "acme/prompts",
      branch: "main",
    });

    expect(result).toEqual([
      { appId: "app-1", appName: "acme-prompts", tenantId: "tenant-1", branch: "main" },
    ]);
  });

  it("returns empty (and skips the branch/app queries) when the repo is not connected", async () => {
    const queried: string[] = [];
    const admin = makeAdmin({ git_connection: [] }, queried);

    const result = await resolveWatchingApps(admin, {
      repository: "acme/prompts",
      branch: "main",
    });

    expect(result).toEqual([]);
    // Short-circuits after git_connection — no branch/app lookups.
    expect(queried).toEqual(["git_connection"]);
  });

  it("returns empty when the repo is connected but no app tracks the pushed branch, without querying app", async () => {
    const queried: string[] = [];
    const admin = makeAdmin(
      { git_connection: [{ app_id: "app-1" }], git_branch: [] },
      queried,
    );

    const result = await resolveWatchingApps(admin, {
      repository: "acme/prompts",
      branch: "feature/x",
    });

    expect(result).toEqual([]);
    // Short-circuits after git_branch comes back empty — no point resolving
    // app names for zero watching apps.
    expect(queried).toEqual(["git_connection", "git_branch"]);
  });

  it("short-circuits (no branch/app lookups) when git_connection resolves no data at all", async () => {
    // A defensive `connections ?? []` guard — PostgREST never actually returns
    // a null body for a list query, but the code guards for it anyway. Omit
    // the fixture key entirely so the stub resolves `data: null`.
    const queried: string[] = [];
    const admin = makeAdmin({}, queried);

    const result = await resolveWatchingApps(admin, {
      repository: "acme/prompts",
      branch: "main",
    });

    expect(result).toEqual([]);
    expect(queried).toEqual(["git_connection"]);
  });

  it("resolves gracefully (not a crash) when git_branch resolves no data at all", async () => {
    // Same defensive-guard shape as above, one query later: `branches?.length`
    // must tolerate `branches` itself being nullish, not just empty.
    const admin = makeAdmin({ git_connection: [{ app_id: "app-1" }] });

    const result = await resolveWatchingApps(admin, {
      repository: "acme/prompts",
      branch: "main",
    });

    expect(result).toEqual([]);
  });

  it("fans out to every app that tracks the branch (shared repo)", async () => {
    const admin = makeAdmin({
      git_connection: [{ app_id: "app-1" }, { app_id: "app-2" }],
      git_branch: [
        { app_id: "app-1", tenant_id: "t1", branch_name: "main" },
        { app_id: "app-2", tenant_id: "t2", branch_name: "main" },
      ],
      app: [
        { id: "app-1", name: "one" },
        { id: "app-2", name: "two" },
      ],
    });

    const result = await resolveWatchingApps(admin, {
      repository: "acme/prompts",
      branch: "main",
    });

    expect(result).toEqual([
      { appId: "app-1", appName: "one", tenantId: "t1", branch: "main" },
      { appId: "app-2", appName: "two", tenantId: "t2", branch: "main" },
    ]);
  });

  it("throws on a query error instead of reading it as zero apps", async () => {
    // An infra fault must NOT silently resolve to [] — that would skip the sync
    // and complete the check neutral. It throws so the caller fails the check.
    const connectionDown = makeAdmin(
      {},
      [],
      { git_connection: { message: "connection refused" } },
    );
    await expect(
      resolveWatchingApps(connectionDown, { repository: "acme/prompts", branch: "main" }),
    ).rejects.toThrow(/git_connection query failed: connection refused/);

    // Same for a downstream query error (branch lookup) after a healthy connection read.
    const branchDown = makeAdmin(
      { git_connection: [{ app_id: "app-1" }] },
      [],
      { git_branch: { message: "timeout" } },
    );
    await expect(
      resolveWatchingApps(branchDown, { repository: "acme/prompts", branch: "main" }),
    ).rejects.toThrow(/git_branch query failed: timeout/);

    // Same for the final query (app-name resolution) after healthy reads on
    // both prior tables.
    const appDown = makeAdmin(
      {
        git_connection: [{ app_id: "app-1" }],
        git_branch: [{ app_id: "app-1", tenant_id: "t1", branch_name: "main" }],
      },
      [],
      { app: { message: "app table unreachable" } },
    );
    await expect(
      resolveWatchingApps(appDown, { repository: "acme/prompts", branch: "main" }),
    ).rejects.toThrow(/app query failed: app table unreachable/);
  });

  it("falls back to the app id for the display name when the app row is missing", async () => {
    const admin = makeAdmin({
      git_connection: [{ app_id: "app-1" }],
      git_branch: [{ app_id: "app-1", tenant_id: "t1", branch_name: "main" }],
      app: [],
    });

    const [watching] = await resolveWatchingApps(admin, {
      repository: "acme/prompts",
      branch: "main",
    });

    expect(watching!.appName).toBe("app-1");
  });

  // NOT KILLED (accepted survivor, documented for the patch-mutation gate):
  // Stryker's `apps ?? []` -> `apps ?? ["Stryker was here"]` mutant at
  // resolve-watching-apps.ts:68. `apps` is null-only when the fixture key is
  // entirely omitted (mirroring "PostgREST never actually returns null for a
  // list query" above); either replacement value maps to a `nameById` Map
  // whose ONLY key is not a real app id ([] -> empty map; ["Stryker was
  // here"] -> a map keyed by `undefined`), so `nameById.get(appId)` is
  // `undefined` and falls back to the raw app id identically either way. No
  // observable-output test can distinguish them without asserting on the
  // literal string "Stryker was here", which would be pinning the mutant
  // itself rather than a behavior.
});
