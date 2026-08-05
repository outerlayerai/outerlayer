/**
 * Request-layer glue for the Sessions list Outcome column. The tenant clients
 * and the batched read are mocked (they have their own tests); this pins the
 * WIRING the route depends on: a lookup that returns each trace's outcomes,
 * [] for a trace with none, [] everywhere when ClickHouse is absent, and []
 * everywhere (never a throw) when the read fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mockTenantChQuery = vi.fn();
const mockFetchOutcomes = vi.fn();

vi.mock("@/lib/system/pr-session-reconciler/ch-query", () => ({
  tenantChQuery: (scope: unknown) => mockTenantChQuery(scope),
}));
vi.mock("../session-outcome-read", () => ({
  fetchOutcomesForTraces: (...args: unknown[]) => mockFetchOutcomes(...args),
}));

import { getSessionListOutcomes } from "../session-list-outcomes";

const SCOPE = { tenantId: "t-1", appId: "app-1" };
// The Supabase client is injected and only forwarded to the (mocked) batched
// read — a bare stand-in is all the glue needs.
const SUPA = {} as unknown as SupabaseClient;
const merged = { prNumber: 7, ciGreen: null, merged: { score: 1, label: "merged" }, reverted: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantChQuery.mockReturnValue(vi.fn()); // a usable ChQueryFn by default
});

describe("getSessionListOutcomes", () => {
  it("extracts trace ids from the page's rows and gives each its outcomes, [] for a trace with none", async () => {
    mockFetchOutcomes.mockResolvedValue(new Map([["trace-a", [merged]]]));

    const outcomeOf = await getSessionListOutcomes(SCOPE, SUPA, [{ traceId: "trace-a" }, { traceId: "trace-b" }]);

    expect(outcomeOf("trace-a")).toEqual([merged]);
    expect(outcomeOf("trace-b")).toEqual([]); // linked to nothing scored
    // The batched read got the tenant scope + the exact trace ids pulled off
    // the rows (proves the extraction, not a passed-through array).
    expect(mockFetchOutcomes).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      tenantId: "t-1",
      appId: "app-1",
      traceIds: ["trace-a", "trace-b"],
    });
  });

  it("returns a []-for-everything lookup when ClickHouse is not configured — and never runs the read", async () => {
    mockTenantChQuery.mockReturnValue(null);

    const outcomeOf = await getSessionListOutcomes(SCOPE, SUPA, [{ traceId: "trace-a" }]);

    expect(outcomeOf("trace-a")).toEqual([]);
    expect(mockFetchOutcomes).not.toHaveBeenCalled();
  });

  it("degrades to []-for-everything (never throws) when the batched read fails", async () => {
    mockFetchOutcomes.mockRejectedValue(new Error("clickhouse timeout"));

    const outcomeOf = await getSessionListOutcomes(SCOPE, SUPA, [{ traceId: "trace-a" }]);

    expect(outcomeOf("trace-a")).toEqual([]);
  });
});
