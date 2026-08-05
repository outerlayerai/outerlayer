import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveNumericLimitForAllTenants } from "@repo/entitlements";
import type { SupabaseEntitlementClient } from "@repo/entitlements";
import {
  resolveRetentionSweepConfig,
  runRetentionSweep,
  supportsBlobSweep,
  tenantOfBlobKey,
  type RetentionSweepDeps,
  type SweepableBlobBucket,
} from "./retention-sweep-service";
import {
  RETENTION_TABLES,
  type RetentionStore,
  type RetentionTable,
} from "@repo/gateway-core/stores/clickhouse/retention-store";

// The batch resolver is @repo/entitlements' own tested surface (MSW-backed
// there); here it's the seam the sweep consumes.
vi.mock("@repo/entitlements", () => ({
  resolveNumericLimitForAllTenants: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures. NOW is pinned so every cutoff below is a hand-computed literal —
// the arithmetic (days × 86 400 s subtracted from the fire time) is the
// contract under test, not something re-derived from the implementation.
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000; // nowSec = 1_700_000_000
const CUTOFF_7D = 1_699_395_200; // now − 7 × 86 400
const CUTOFF_30D = 1_697_408_000; // now − 30 × 86 400
const CUTOFF_90D = 1_692_224_000; // now − 90 × 86 400

const T_GROWTH = "11111111-1111-4111-8111-111111111111"; // 90d (tier)
const T_SHORT = "22222222-2222-4222-8222-222222222222"; // 30d (override)
const T_UNLIM = "33333333-3333-4333-8333-333333333333"; // -1 unlimited
const T_ZERO = "44444444-4444-4444-8444-444444444444"; // 0 — invalid override
const T_ORPHAN = "55555555-5555-4555-8555-555555555555"; // no billing row → 7d fallback
const T_EDGE = "66666666-6666-4666-8666-666666666666"; // 90d, oldest row AT the cutoff

function seedLimits(
  byTenant: Record<string, number> = {
    [T_GROWTH]: 90,
    [T_SHORT]: 30,
    [T_UNLIM]: -1,
    [T_ZERO]: 0,
    [T_EDGE]: 90,
  },
  fallback = 7,
) {
  vi.mocked(resolveNumericLimitForAllTenants).mockResolvedValue({
    byTenant: new Map(Object.entries(byTenant)),
    fallback,
  });
}

const supabase = { seam: "supabase" } as unknown as SupabaseEntitlementClient;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(),
};

function makeStore(overrides: Partial<RetentionStore> = {}): RetentionStore {
  return {
    oldestRowPerTenant: vi.fn().mockResolvedValue(new Map()),
    deleteExpiredRows: vi.fn().mockResolvedValue(undefined),
    pendingDeleteMutations: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<RetentionSweepDeps> = {}): RetentionSweepDeps {
  return {
    store: makeStore(),
    supabase,
    blobs: null,
    logger: logger as unknown as RetentionSweepDeps["logger"],
    config: { enabled: true, maxBlobObjectsPerRun: 50_000 },
    nowMs: NOW_MS,
    ...overrides,
  };
}

/** Restrict row data to named tables; every other table reports empty. */
function oldestByTable(data: Record<string, Map<string, number>>) {
  return vi.fn(async (table: RetentionTable) => data[table.table] ?? new Map());
}

beforeEach(() => {
  vi.clearAllMocks();
  seedLimits();
});

// ---------------------------------------------------------------------------
// runRetentionSweep — row deletion
// ---------------------------------------------------------------------------

describe("runRetentionSweep rows", () => {
  test("deletes exactly the expired tenants with their own cutoffs; unlimited, invalid, boundary, and fresh tenants excluded", async () => {
    const store = makeStore({
      oldestRowPerTenant: oldestByTable({
        otel_traces: new Map([
          [T_GROWTH, 1_600_000_000], // expired vs 90d
          [T_SHORT, 1_690_000_000], // expired vs 30d
          [T_UNLIM, 1_000_000_000], // unlimited — never deleted
          [T_ZERO, 1_000_000_000], // invalid 0 — excluded, counted
          [T_ORPHAN, 1_699_000_000], // no billing row → 7d fallback, expired
          [T_EDGE, CUTOFF_90D], // oldest row AT the cutoff — not expired (strict <)
        ]),
      }),
    });

    const result = await runRetentionSweep(makeDeps({ store }));

    expect(store.deleteExpiredRows).toHaveBeenCalledTimes(1);
    expect(store.deleteExpiredRows).toHaveBeenCalledWith(RETENTION_TABLES[0], [
      { tenantId: T_GROWTH, cutoffUnixSec: CUTOFF_90D },
      { tenantId: T_SHORT, cutoffUnixSec: CUTOFF_30D },
      { tenantId: T_ORPHAN, cutoffUnixSec: CUTOFF_7D },
    ]);
    expect(result.swept).toEqual([{ table: "otel_traces", tenants: 3 }]);
    expect(result.skipped).toEqual([]);
    expect(result.invalidTenants).toBe(1);
  });

  test("resolves the entitlement with the injected admin client and a warn bridge", async () => {
    await runRetentionSweep(makeDeps());

    expect(resolveNumericLimitForAllTenants).toHaveBeenCalledWith(
      supabase,
      "data_retention_days",
      { warn: expect.any(Function) },
    );
  });

  test("throws before touching ClickHouse when zero billing rows resolve", async () => {
    seedLimits({});
    const store = makeStore();

    await expect(runRetentionSweep(makeDeps({ store }))).rejects.toThrow(
      /zero billing rows/,
    );
    expect(store.pendingDeleteMutations).not.toHaveBeenCalled();
    expect(store.oldestRowPerTenant).not.toHaveBeenCalled();
    expect(store.deleteExpiredRows).not.toHaveBeenCalled();
  });

  test("propagates a resolver failure without touching ClickHouse", async () => {
    vi.mocked(resolveNumericLimitForAllTenants).mockRejectedValue(
      new Error("billing read failed"),
    );
    const store = makeStore();

    await expect(runRetentionSweep(makeDeps({ store }))).rejects.toThrow(
      "billing read failed",
    );
    expect(store.deleteExpiredRows).not.toHaveBeenCalled();
  });

  test("skips a table with pending delete mutations (backpressure) without even scanning it; other tables sweep", async () => {
    const oldest = oldestByTable({
      otel_traces: new Map([[T_GROWTH, 1_600_000_000]]),
      scores: new Map([[T_GROWTH, 1_600_000_000]]),
    });
    const store = makeStore({
      oldestRowPerTenant: oldest,
      pendingDeleteMutations: vi
        .fn()
        .mockResolvedValue(new Map([["otel_traces", 2]])),
    });

    const result = await runRetentionSweep(makeDeps({ store }));

    const scannedTables = vi
      .mocked(oldest)
      .mock.calls.map(([t]) => (t as RetentionTable).table);
    expect(scannedTables).not.toContain("otel_traces");
    expect(store.deleteExpiredRows).toHaveBeenCalledTimes(1);
    expect(store.deleteExpiredRows).toHaveBeenCalledWith(
      RETENTION_TABLES.find((t) => t.table === "scores"),
      [{ tenantId: T_GROWTH, cutoffUnixSec: CUTOFF_90D }],
    );
    expect(result.skipped).toEqual([
      { table: "otel_traces", reason: "pending_mutations:2" },
    ]);
    expect(result.swept).toEqual([{ table: "scores", tenants: 1 }]);
  });

  test("isolates a per-table failure: logs it, marks it skipped, still sweeps the rest", async () => {
    const boom = new Error("UNKNOWN_TABLE scores");
    const store = makeStore({
      oldestRowPerTenant: vi.fn(async (table: RetentionTable) => {
        if (table.table === "scores") throw boom;
        return table.table === "otel_traces"
          ? new Map([[T_GROWTH, 1_600_000_000]])
          : new Map();
      }),
    });

    const result = await runRetentionSweep(makeDeps({ store }));

    expect(result.skipped).toEqual([{ table: "scores", reason: "error" }]);
    expect(result.swept).toEqual([{ table: "otel_traces", tenants: 1 }]);
    expect(logger.error).toHaveBeenCalledWith(boom, {
      source: "retention-sweep",
      table: "scores",
    });
  });

  test("issues no mutation for a table where nothing expired", async () => {
    const store = makeStore({
      oldestRowPerTenant: oldestByTable({
        otel_traces: new Map([[T_GROWTH, 1_699_999_999]]), // fresh
      }),
    });

    const result = await runRetentionSweep(makeDeps({ store }));

    expect(store.deleteExpiredRows).not.toHaveBeenCalled();
    expect(result.swept).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runRetentionSweep — blob sweep
// ---------------------------------------------------------------------------

function makeBucket(
  pages: { objects: { key: string; uploaded: Date }[]; cursor?: string }[],
): SweepableBlobBucket & { list: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    list: vi.fn(async () => {
      const page = pages[call] ?? { objects: [] };
      call += 1;
      return {
        objects: page.objects,
        truncated: page.cursor !== undefined,
        cursor: page.cursor,
      };
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

const OLD = new Date((CUTOFF_30D - 1) * 1000); // expired for a 30d tenant
const FRESH = new Date((CUTOFF_30D + 1) * 1000);

describe("runRetentionSweep blobs", () => {
  test("deletes only expired, parseable, finite-retention objects — both key shapes", async () => {
    const bucket = makeBucket([
      {
        objects: [
          { key: `${T_SHORT}/app/trace/span/Output`, uploaded: OLD },
          { key: `${T_SHORT}/app/trace/span/Input`, uploaded: FRESH },
          { key: `agents/${T_SHORT}/app/abc123`, uploaded: OLD },
          { key: `${T_UNLIM}/app/trace/span/Output`, uploaded: OLD },
          { key: `not-a-uuid/app/trace/span/Output`, uploaded: OLD },
          { key: `random.txt`, uploaded: OLD },
        ],
      },
    ]);

    const result = await runRetentionSweep(makeDeps({ blobs: bucket }));

    expect(bucket.delete).toHaveBeenCalledTimes(1);
    expect(bucket.delete).toHaveBeenCalledWith([
      `${T_SHORT}/app/trace/span/Output`,
      `agents/${T_SHORT}/app/abc123`,
    ]);
    expect(result.blobsDeleted).toBe(2);
    expect(result.blobsExamined).toBe(6);
    expect(result.blobScanTruncated).toBe(false);
  });

  test("paginates with the cursor and stops at the object cap, reporting truncation", async () => {
    const objects = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        key: `${T_SHORT}/app/t/s/Output${i}`,
        uploaded: FRESH,
      }));
    const bucket = makeBucket([
      { objects: objects(2), cursor: "c1" },
      { objects: objects(2), cursor: "c2" },
      { objects: objects(2) }, // never reached — cap hits at 4
    ]);

    const result = await runRetentionSweep(
      makeDeps({
        blobs: bucket,
        config: { enabled: true, maxBlobObjectsPerRun: 4 },
      }),
    );

    expect(bucket.list.mock.calls).toEqual([
      [{ cursor: undefined, limit: 4 }],
      [{ cursor: "c1", limit: 2 }],
    ]);
    expect(result.blobsExamined).toBe(4);
    expect(result.blobScanTruncated).toBe(true);
  });

  test("a bucket without list/delete (blobs: null) sweeps rows only", async () => {
    const result = await runRetentionSweep(makeDeps({ blobs: null }));

    expect(result.blobsDeleted).toBe(0);
    expect(result.blobsExamined).toBe(0);
    expect(result.blobScanTruncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("tenantOfBlobKey", () => {
  test.each([
    [`${T_SHORT}/app/trace/span/Output`, T_SHORT],
    [`agents/${T_SHORT}/app-id/deadbeefcafe`, T_SHORT],
    [`AGENTS/${T_SHORT}/app-id/sha`, null], // prefix is case-sensitive
    [`not-a-uuid/app/trace/span/Output`, null],
    [`agents/not-a-uuid/app/sha`, null],
    [`${T_SHORT}/app/trace/span`, null], // 4 segments without agents/ prefix
    [`${T_SHORT}/app/trace/span/Field/extra`, null], // 6 segments
    ["random.txt", null],
    ["", null],
  ])("%s → %s", (key, expected) => {
    expect(tenantOfBlobKey(key)).toBe(expected);
  });
});

describe("supportsBlobSweep", () => {
  test("true only when both list and delete are functions", () => {
    expect(supportsBlobSweep({ list: () => {}, delete: () => {} })).toBe(true);
    expect(supportsBlobSweep({ put: () => {}, get: () => {} })).toBe(false);
    expect(supportsBlobSweep({ list: () => {} })).toBe(false);
    expect(supportsBlobSweep(null)).toBe(false);
    expect(supportsBlobSweep(undefined)).toBe(false);
  });
});

describe("resolveRetentionSweepConfig", () => {
  test("disabled unless the flag is exactly 'true'; blob cap defaults to 50000 and parses overrides", () => {
    expect(resolveRetentionSweepConfig({})).toEqual({
      enabled: false,
      maxBlobObjectsPerRun: 50_000,
    });
    expect(resolveRetentionSweepConfig({ RETENTION_SWEEP_ENABLED: "TRUE" })).toEqual({
      enabled: false,
      maxBlobObjectsPerRun: 50_000,
    });
    expect(
      resolveRetentionSweepConfig({
        RETENTION_SWEEP_ENABLED: "true",
        RETENTION_SWEEP_MAX_BLOB_OBJECTS: "1200",
      }),
    ).toEqual({ enabled: true, maxBlobObjectsPerRun: 1_200 });
    expect(
      resolveRetentionSweepConfig({
        RETENTION_SWEEP_ENABLED: "true",
        RETENTION_SWEEP_MAX_BLOB_OBJECTS: "-5",
      }),
    ).toEqual({ enabled: true, maxBlobObjectsPerRun: 50_000 });
  });
});
