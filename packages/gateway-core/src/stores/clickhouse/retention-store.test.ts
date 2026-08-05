import { beforeEach, describe, expect, test, vi } from "vitest";
import { createClient } from "@clickhouse/client-web";
import { createRetentionStore, RETENTION_TABLES } from "./retention-store";

const mockQuery = vi.fn();
const mockCommand = vi.fn();

vi.mock("@clickhouse/client-web", () => ({
  createClient: vi.fn(() => ({
    query: mockQuery,
    command: mockCommand,
  })),
}));

function queueRows(rows: unknown[]) {
  mockQuery.mockResolvedValueOnce({ json: vi.fn().mockResolvedValue(rows) });
}

/** Collapse whitespace so SQL assertions survive formatting-only edits. */
function sql(call: { query: string }): string {
  return call.query.replace(/\s+/g, " ").trim();
}

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RETENTION_TABLES", () => {
  test("covers every tenant-keyed per-row table with its insert-time column", () => {
    // Positional pin: adding a tenant-keyed ClickHouse table without deciding
    // its retention story should fail THIS test, not silently skip the table.
    expect(RETENTION_TABLES).toEqual([
      { table: "otel_traces", timeColumn: "CreatedAt" },
      { table: "otel_traces_trace_id_ts", timeColumn: "CreatedAt" },
      { table: "scores", timeColumn: "CreatedAt" },
      { table: "trace_facets", timeColumn: "CreatedAt" },
      { table: "agent_session_summary", timeColumn: "InsertedAt" },
      { table: "agent_blobs", timeColumn: "InsertedAt" },
    ]);
  });
});

describe("oldestRowPerTenant", () => {
  test("groups the table's insert-time column by tenant and coerces numerics", async () => {
    queueRows([
      { TenantId: T1, oldest: "1600000000" }, // ClickHouse JSON may stringify
      { TenantId: T2, oldest: 1700000000 },
    ]);
    const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

    const result = await store.oldestRowPerTenant(RETENTION_TABLES[4]); // agent_session_summary

    expect(sql(mockQuery.mock.calls[0]![0])).toBe(
      "SELECT TenantId, toUnixTimestamp(min(InsertedAt)) AS oldest FROM agent_session_summary GROUP BY TenantId",
    );
    expect(mockQuery.mock.calls[0]![0]).toMatchObject({ format: "JSONEachRow" });
    expect([...result.entries()].sort()).toEqual([
      [T1, 1_600_000_000],
      [T2, 1_700_000_000],
    ]);
  });

  test("bounds the scan: in-order aggregation, capped threads/memory/time", async () => {
    queueRows([]);
    const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

    await store.oldestRowPerTenant(RETENTION_TABLES[0]); // otel_traces

    // The exact resource envelope matters: this cron aggregates the busiest
    // tables on a shared server, and each setting bounds a different way the
    // query could tip total server memory over its ceiling.
    expect(mockQuery.mock.calls[0]![0].clickhouse_settings).toEqual({
      optimize_aggregation_in_order: 1,
      max_threads: 2,
      max_memory_usage: "1000000000",
      max_execution_time: 300,
    });
  });

  test("retries once after a delay when the first attempt fails", async () => {
    vi.useFakeTimers();
    try {
      mockQuery.mockRejectedValueOnce(new Error("(total) memory limit exceeded"));
      queueRows([{ TenantId: T1, oldest: 1_600_000_000 }]);
      const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

      const pending = store.oldestRowPerTenant(RETENTION_TABLES[0]);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await pending).toEqual(new Map([[T1, 1_600_000_000]]));
      expect(mockQuery).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failure of the retry propagates — exactly two attempts, never more", async () => {
    vi.useFakeTimers();
    try {
      mockQuery
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("second"));
      const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

      const outcome = store.oldestRowPerTenant(RETENTION_TABLES[0]).catch((e) => e);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await outcome).toEqual(new Error("second"));
      expect(mockQuery).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deleteExpiredRows", () => {
  test("issues one ALTER DELETE with tenant and cutoff arrays aligned by index", async () => {
    mockCommand.mockResolvedValue(undefined);
    const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

    await store.deleteExpiredRows(RETENTION_TABLES[0], [
      { tenantId: T1, cutoffUnixSec: 1_692_224_000 },
      { tenantId: T2, cutoffUnixSec: 1_699_395_200 },
    ]);

    expect(mockCommand).toHaveBeenCalledTimes(1);
    const call = mockCommand.mock.calls[0]![0];
    // The predicate contract: rows delete only for listed tenants, each
    // against ITS OWN cutoff (transform), on the table's insert-time column.
    expect(sql(call)).toBe(
      "ALTER TABLE otel_traces DELETE WHERE TenantId IN ({tenants:Array(String)}) " +
        "AND toUnixTimestamp(CreatedAt) < transform( TenantId, {tenants:Array(String)}, {cutoffs:Array(UInt32)}, toUInt32(0) )",
    );
    // Index alignment is what keeps tenant A from getting tenant B's cutoff.
    expect(call.query_params).toEqual({
      tenants: [T1, T2],
      cutoffs: [1_692_224_000, 1_699_395_200],
    });
    // Tenant ids travel as bound params, never spliced into the SQL.
    expect(call.query).not.toContain(T1);
  });

  test("uses the InsertedAt column for the tables that have one", async () => {
    mockCommand.mockResolvedValue(undefined);
    const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

    await store.deleteExpiredRows(RETENTION_TABLES[5], [
      { tenantId: T1, cutoffUnixSec: 1_692_224_000 },
    ]);

    expect(sql(mockCommand.mock.calls[0]![0])).toContain(
      "ALTER TABLE agent_blobs DELETE WHERE",
    );
    expect(sql(mockCommand.mock.calls[0]![0])).toContain("toUnixTimestamp(InsertedAt)");
  });

  test("a failed mutation is never retried", async () => {
    // Retrying an ALTER DELETE whose response was lost would stack a second
    // identical mutation and double the part-rewrite work.
    mockCommand.mockRejectedValueOnce(new Error("socket hang up"));
    const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

    await expect(
      store.deleteExpiredRows(RETENTION_TABLES[0], [
        { tenantId: T1, cutoffUnixSec: 1_692_224_000 },
      ]),
    ).rejects.toEqual(new Error("socket hang up"));
    expect(mockCommand).toHaveBeenCalledTimes(1);
  });

  test("no cutoffs → no mutation at all", async () => {
    const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

    await store.deleteExpiredRows(RETENTION_TABLES[0], []);

    expect(mockCommand).not.toHaveBeenCalled();
  });
});

describe("pendingDeleteMutations", () => {
  test("counts unfinished DELETE mutations across exactly the retention tables", async () => {
    queueRows([
      { table: "otel_traces", pending: "2" },
      { table: "scores", pending: 1 },
    ]);
    const store = createRetentionStore({ url: "http://ch:8123", password: "pw" });

    const result = await store.pendingDeleteMutations();

    const call = mockQuery.mock.calls[0]![0];
    const q = sql(call);
    expect(q).toContain("FROM system.mutations");
    expect(q).toContain("is_done = 0");
    expect(q).toContain("command LIKE '%DELETE%'");
    expect(call.query_params).toEqual({
      tables: [
        "otel_traces",
        "otel_traces_trace_id_ts",
        "scores",
        "trace_facets",
        "agent_session_summary",
        "agent_blobs",
      ],
    });
    expect([...result.entries()].sort()).toEqual([
      ["otel_traces", 2],
      ["scores", 1],
    ]);
  });
});

describe("createRetentionStore", () => {
  test("connects with the configured url and password", () => {
    createRetentionStore({ url: "http://ch:8123", password: "pw" });

    expect(createClient).toHaveBeenCalledWith({ url: "http://ch:8123", password: "pw" });
  });
});
