import { beforeEach, describe, expect, test, vi } from "vitest";
import { topicsEnrichmentHandler } from "./topics-enrichment-handler";
import { enqueueTopicsBackfillBatch } from "../queues/topics-enrichment-queue";
import { createTopicsStore } from "../stores/clickhouse/topics-store";
import { createLoggerFromContext } from "../services/logger";
import {
  TopicsEnrichmentService,
  createTopicsModelClients,
} from "../services/topics-enrichment-service";
import type { GatewayScheduleContext } from "@repo/gateway-core/types";

vi.mock("../stores/clickhouse/topics-store", () => ({
  createTopicsStore: vi.fn().mockReturnValue({ store: true }),
}));

vi.mock("../services/logger", () => ({
  createLoggerFromContext: vi.fn(),
}));

vi.mock("../queues/topics-enrichment-queue", () => ({
  enqueueTopicsBackfillBatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/topics-enrichment-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/topics-enrichment-service")>();
  return {
    ...actual,
    TopicsEnrichmentService: vi.fn(),
    createTopicsModelClients: vi.fn().mockReturnValue({
      structured: { generateObject: vi.fn() },
      embedding: { embed: vi.fn() },
      mode: "mock",
    }),
  };
});

const logger = {
  info: vi.fn(),
  error: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
};

function makeContext(envOverrides: Record<string, string> = {}): GatewayScheduleContext {
  return {
    env: {
      CLICKHOUSE_HOST: "http://ch.test:8123",
      CLICKHOUSE_PASSWORD: "pw",
      ...envOverrides,
    },
    event: { cron: "* * * * *", scheduledTime: 1_700_000_000_000 },
    ctx: { waitUntil: vi.fn() },
    cache: {},
  } as unknown as GatewayScheduleContext;
}

function mockServiceRun(
  result: unknown,
  error?: Error,
  backfillResult: unknown = { scanned: 0, enriched: 0, failed: 0 },
  refreshResult: unknown = { scanned: 0, enriched: 0, failed: 0 },
) {
  const run = error
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue(result);
  const runSteeringBackfill = vi.fn().mockResolvedValue(backfillResult);
  const runBatchedRefresh = vi.fn().mockResolvedValue(refreshResult);
  const findSweepCandidateScopes = vi.fn().mockResolvedValue([]);
  const findRefreshCandidateScopes = vi.fn().mockResolvedValue([]);
  // Regular function (not arrow): the handler `new`s the service, and a
  // constructor returning an object substitutes it for `this`.
  vi.mocked(TopicsEnrichmentService).mockImplementation(function () {
    return {
      run,
      runSteeringBackfill,
      runBatchedRefresh,
      findSweepCandidateScopes,
      findRefreshCandidateScopes,
    } as unknown as TopicsEnrichmentService;
  } as unknown as () => TopicsEnrichmentService);
  return {
    run,
    runSteeringBackfill,
    runBatchedRefresh,
    findSweepCandidateScopes,
    findRefreshCandidateScopes,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createLoggerFromContext).mockReturnValue(
    logger as unknown as ReturnType<typeof createLoggerFromContext>,
  );
  logger.flush.mockResolvedValue(undefined);
});

describe("topicsEnrichmentHandler", () => {
  test("disabled (default): returns without touching the store, clients, or logger", async () => {
    await topicsEnrichmentHandler(makeContext());

    expect(createTopicsStore).not.toHaveBeenCalled();
    expect(createTopicsModelClients).not.toHaveBeenCalled();
    expect(createLoggerFromContext).not.toHaveBeenCalled();
  });

  test("enabled: wires store from env, tags the logger source, runs the service, logs a tick summary when work happened", async () => {
    const { run } = mockServiceRun({ scanned: 7, enriched: 6, failed: 1 });
    const context = makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" });

    await topicsEnrichmentHandler(context);

    expect(createLoggerFromContext).toHaveBeenCalledWith(context.env, {
      source: "scheduled:topics-enrichment",
    });
    expect(createTopicsStore).toHaveBeenCalledWith({
      url: "http://ch.test:8123",
      password: "pw",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("topics enrichment tick", {
      cron: "* * * * *",
      mode: "mock",
      scanned: 7,
      enriched: 6,
      failed: 1,
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.flush).toHaveBeenCalledTimes(1);
  });

  test("idle tick (scanned 0): no log line, still flushes", async () => {
    mockServiceRun({ scanned: 0, enriched: 0, failed: 0 });

    await topicsEnrichmentHandler(makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" }));

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.flush).toHaveBeenCalledTimes(1);
  });

  test("service failure: swallowed (no rethrow), logged with cron metadata, flushed", async () => {
    const failure = new Error("clickhouse down");
    mockServiceRun(undefined, failure);

    await expect(
      topicsEnrichmentHandler(makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" })),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(failure, { cron: "* * * * *" });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.flush).toHaveBeenCalledTimes(1);
  });

  test("constructs the service with the resolved config and both model clients", async () => {
    mockServiceRun({ scanned: 0, enriched: 0, failed: 0 });
    const clients = vi.mocked(createTopicsModelClients).getMockImplementation()!(
      {},
    );
    void clients;

    await topicsEnrichmentHandler(
      makeContext({
        TOPICS_ENRICHMENT_ENABLED: "true",
        TOPICS_BATCH_LIMIT: "50",
      }),
    );

    const [storeArg, clientsArg, configArg] = vi.mocked(TopicsEnrichmentService)
      .mock.calls[0] as unknown[];
    expect(storeArg).toEqual({ store: true });
    expect(clientsArg).toEqual({
      structured: expect.objectContaining({ generateObject: expect.any(Function) }),
      embedding: expect.objectContaining({ embed: expect.any(Function) }),
    });
    expect(configArg).toEqual(
      expect.objectContaining({ enabled: true, batchLimit: 50 }),
    );
  });
});

describe("topicsEnrichmentHandler steering backfill", () => {
  test("the backfill runs after the live pass on the same tick and logs its own summary", async () => {
    const { run, runSteeringBackfill } = mockServiceRun(
      { scanned: 0, enriched: 0, failed: 0 },
      undefined,
      { scanned: 25, enriched: 24, failed: 1 },
    );
    await topicsEnrichmentHandler(makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(runSteeringBackfill).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "steering backfill tick",
      expect.objectContaining({ scanned: 25, backfilled: 24, failed: 1 }),
    );
  });

  test("a drained backfill (zero candidates) logs nothing", async () => {
    mockServiceRun({ scanned: 0, enriched: 0, failed: 0 });
    await topicsEnrichmentHandler(makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" }));
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("topicsEnrichmentHandler queue-mode backfills", () => {
  test("with TOPICS_QUEUE bound: candidates are enqueued job-tagged and the inline passes never run", async () => {
    const mocks = mockServiceRun({ scanned: 0, enriched: 0, failed: 0 });
    const sweepScopes = [
      { tenantId: "t", appId: "a", environment: "prod", traceId: "s1" },
    ];
    const refreshScopes = [
      { tenantId: "t", appId: "a", environment: "prod", traceId: "r1" },
      { tenantId: "t", appId: "a", environment: "prod", traceId: "r2" },
    ];
    mocks.findSweepCandidateScopes.mockResolvedValue(sweepScopes);
    mocks.findRefreshCandidateScopes.mockResolvedValue(refreshScopes);
    const queue = { sendBatch: vi.fn() };
    const context = makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" });
    (context.env as Record<string, unknown>)["TOPICS_QUEUE"] = queue;

    await topicsEnrichmentHandler(context);

    // Discovery is bounded per tick so queue depth stays ~one tick of work.
    expect(mocks.findSweepCandidateScopes).toHaveBeenCalledWith(250);
    expect(mocks.findRefreshCandidateScopes).toHaveBeenCalledWith(250);
    expect(enqueueTopicsBackfillBatch).toHaveBeenCalledWith(
      queue,
      logger,
      sweepScopes,
      "steering_sweep",
    );
    expect(enqueueTopicsBackfillBatch).toHaveBeenCalledWith(
      queue,
      logger,
      refreshScopes,
      "batched_refresh",
    );
    expect(mocks.runSteeringBackfill).not.toHaveBeenCalled();
    expect(mocks.runBatchedRefresh).not.toHaveBeenCalled();
    // The live pass still runs inline — it is the gap-repair scan.
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  test("without the binding: inline passes run and nothing is enqueued (self-host path)", async () => {
    const mocks = mockServiceRun({ scanned: 0, enriched: 0, failed: 0 });

    await topicsEnrichmentHandler(makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" }));

    expect(mocks.runSteeringBackfill).toHaveBeenCalledTimes(1);
    expect(mocks.runBatchedRefresh).toHaveBeenCalledTimes(1);
    expect(enqueueTopicsBackfillBatch).not.toHaveBeenCalled();
    expect(mocks.findSweepCandidateScopes).not.toHaveBeenCalled();
    expect(mocks.findRefreshCandidateScopes).not.toHaveBeenCalled();
  });
});

describe("topicsEnrichmentHandler inline pass deadlines and refresh log", () => {
  test("inline passes receive ABSOLUTE tick deadlines: live +20s, sweep +35s, refresh +50s", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const mocks = mockServiceRun({ scanned: 0, enriched: 0, failed: 0 });
      await topicsEnrichmentHandler(makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" }));

      expect(mocks.run).toHaveBeenCalledWith(undefined, 1_020_000);
      expect(mocks.runSteeringBackfill).toHaveBeenCalledWith(undefined, 1_035_000);
      expect(mocks.runBatchedRefresh).toHaveBeenCalledWith(undefined, 1_050_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a working refresh pass logs its own tick summary", async () => {
    mockServiceRun(
      { scanned: 0, enriched: 0, failed: 0 },
      undefined,
      { scanned: 0, enriched: 0, failed: 0 },
      { scanned: 12, enriched: 11, failed: 1 },
    );
    await topicsEnrichmentHandler(makeContext({ TOPICS_ENRICHMENT_ENABLED: "true" }));

    expect(logger.info).toHaveBeenCalledWith(
      "batched refresh tick",
      expect.objectContaining({ scanned: 12, refreshed: 11, failed: 1 }),
    );
  });
});
