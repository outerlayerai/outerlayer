import { beforeEach, describe, expect, test, vi } from "vitest";
import { retentionSweepHandler, RETENTION_SWEEP_CRON } from "./retention-sweep-handler";
import { createRetentionStore } from "@repo/gateway-core/stores/clickhouse/retention-store";
import { createLoggerFromContext } from "../services/logger";
import { createSystemAdminClient } from "@repo/gateway-core/lib/system-client";
import { runRetentionSweep } from "../services/retention-sweep-service";
import type { GatewayScheduleContext } from "@repo/gateway-core/types";

vi.mock("@repo/gateway-core/stores/clickhouse/retention-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/gateway-core/stores/clickhouse/retention-store")>();
  return {
    ...actual,
    createRetentionStore: vi.fn().mockReturnValue({ store: true }),
  };
});

vi.mock("../services/logger", () => ({
  createLoggerFromContext: vi.fn(),
}));

vi.mock("@repo/gateway-core/lib/system-client", () => ({
  createSystemAdminClient: vi.fn().mockReturnValue({ admin: true }),
}));

// Keep the real config resolver + blob-capability guard; mock only the sweep.
vi.mock("../services/retention-sweep-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/retention-sweep-service")>();
  return {
    ...actual,
    runRetentionSweep: vi.fn(),
  };
});

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
};

const SWEEPABLE_BUCKET = { list: vi.fn(), delete: vi.fn(), put: vi.fn(), get: vi.fn() };

function makeContext(envOverrides: Record<string, unknown> = {}): GatewayScheduleContext {
  return {
    env: {
      CLICKHOUSE_HOST: "http://ch.test:8123",
      CLICKHOUSE_PASSWORD: "pw",
      TRACE_BLOBS: SWEEPABLE_BUCKET,
      ...envOverrides,
    },
    event: { cron: RETENTION_SWEEP_CRON, scheduledTime: 1_700_000_000_000 },
    ctx: { waitUntil: vi.fn() },
    cache: {},
  } as unknown as GatewayScheduleContext;
}

const SWEEP_RESULT = {
  swept: [{ table: "otel_traces", tenants: 2 }],
  skipped: [],
  invalidTenants: 0,
  blobsDeleted: 3,
  blobsExamined: 40,
  blobScanTruncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createLoggerFromContext).mockReturnValue(
    logger as unknown as ReturnType<typeof createLoggerFromContext>,
  );
  logger.flush.mockResolvedValue(undefined);
  vi.mocked(runRetentionSweep).mockResolvedValue(SWEEP_RESULT);
});

describe("retentionSweepHandler", () => {
  test("disabled (default): returns without touching the store, admin client, or logger", async () => {
    await retentionSweepHandler(makeContext());

    expect(createRetentionStore).not.toHaveBeenCalled();
    expect(createSystemAdminClient).not.toHaveBeenCalled();
    expect(createLoggerFromContext).not.toHaveBeenCalled();
    expect(runRetentionSweep).not.toHaveBeenCalled();
  });

  test("enabled: composes store, admin client, R2 bucket, and the cron fire time into the sweep, then logs the summary", async () => {
    const context = makeContext({ RETENTION_SWEEP_ENABLED: "true" });

    await retentionSweepHandler(context);

    expect(createRetentionStore).toHaveBeenCalledWith({
      url: "http://ch.test:8123",
      password: "pw",
    });
    expect(createSystemAdminClient).toHaveBeenCalledWith(context.env);
    expect(runRetentionSweep).toHaveBeenCalledWith({
      store: { store: true },
      supabase: { admin: true },
      blobs: SWEEPABLE_BUCKET,
      logger,
      config: { enabled: true, maxBlobObjectsPerRun: 50_000 },
      nowMs: 1_700_000_000_000,
    });
    expect(createLoggerFromContext).toHaveBeenCalledWith(context.env, {
      source: "scheduled:retention-sweep",
    });
    expect(logger.info).toHaveBeenCalledWith("retention sweep completed", {
      cron: RETENTION_SWEEP_CRON,
      swept: [{ table: "otel_traces", tenants: 2 }],
      skipped: [],
      invalidTenants: 0,
      blobsDeleted: 3,
      blobsExamined: 40,
      blobScanTruncated: false,
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.flush).toHaveBeenCalledTimes(1);
  });

  test("a blob store without list/delete (node self-host seam) passes blobs: null", async () => {
    await retentionSweepHandler(
      makeContext({
        RETENTION_SWEEP_ENABLED: "true",
        TRACE_BLOBS: { put: vi.fn(), get: vi.fn() },
      }),
    );

    expect(runRetentionSweep).toHaveBeenCalledWith(
      expect.objectContaining({ blobs: null }),
    );
  });

  test("sweep failure: swallowed (no rethrow), logged with cron metadata, flushed", async () => {
    const failure = new Error("zero billing rows resolved");
    vi.mocked(runRetentionSweep).mockRejectedValue(failure);

    await expect(
      retentionSweepHandler(makeContext({ RETENTION_SWEEP_ENABLED: "true" })),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(failure, { cron: RETENTION_SWEEP_CRON });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.flush).toHaveBeenCalledTimes(1);
  });
});
