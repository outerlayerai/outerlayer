/**
 * Storage Metering Handler — Unit Tests
 *
 * The handler does delta storage metering: query bytes ingested in the last
 * 60-second window, convert to fractional GB, and bill each customer via a
 * Stripe meter event. These tests pin the BILLING contract — the exact GB
 * value, customer id, meter key, idempotency key, window bounds, and the
 * zero-skip / continue-on-failure / cleanup behavior — so a regression that
 * mis-bills (wrong amount, wrong customer, duplicate, dropped) is caught.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  storageMeteringHandler,
  type IClickHouseClient,
  type IStripeClient,
} from "./storage-metering-handler";
import type { GatewayScheduleContext } from "@repo/gateway-core/types";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), error: vi.fn(), flush: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../services/logger", () => ({
  createLoggerFromContext: vi.fn(() => mockLogger),
}));

// scheduledTime 1_700_000_000_000 ms → jobTime 1_700_000_000 s,
// window start = jobTime - 60 = 1_699_999_940.
const SCHEDULED_TIME = 1_700_000_000_000;
const JOB_TIME = 1_700_000_000;
const WINDOW_START = JOB_TIME - 60;

function createContext(): GatewayScheduleContext {
  return {
    env: {
      CLICKHOUSE_HOST: "http://localhost:8123",
      CLICKHOUSE_PASSWORD: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_STORAGE_METER_KEY: "storage_gb_meter",
    } as GatewayScheduleContext["env"],
    ctx: { waitUntil: vi.fn() } as unknown as GatewayScheduleContext["ctx"],
    event: { cron: "* * * * *", scheduledTime: SCHEDULED_TIME } as GatewayScheduleContext["event"],
    cache: {} as GatewayScheduleContext["cache"],
  };
}

function chResult(rows: unknown[]) {
  return { json: vi.fn().mockResolvedValue(rows) };
}

function createClickHouse(...results: ReturnType<typeof chResult>[]) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  return { query, close: vi.fn().mockResolvedValue(undefined) } as IClickHouseClient & {
    query: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function createStripe(error?: Error) {
  const create = error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue({});
  const stripe: IStripeClient = { billing: { meterEvents: { create } } };
  return { stripe, create };
}

beforeEach(() => {
  mockLogger.info.mockReset();
  mockLogger.error.mockReset();
  mockLogger.flush.mockReset().mockResolvedValue(undefined);
});

describe("storageMeteringHandler", () => {
  it("bills one customer with the exact GB value, customer, meter key, and idempotency key", async () => {
    const ch = createClickHouse(chResult([{ stripeCustomerId: "cus_a", deltaBytes: "2000000000" }]));
    const { stripe, create } = createStripe();

    await storageMeteringHandler(createContext(), { clickhouse: ch, stripe });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      { event_name: "storage_gb_meter", payload: { value: "2", stripe_customer_id: "cus_a" } },
      { idempotencyKey: `storage-cus_a-${JOB_TIME}` },
    );
    expect(ch.close).toHaveBeenCalledTimes(1);
    expect(mockLogger.flush).toHaveBeenCalledTimes(1);
  });

  it("queries ClickHouse for exactly the 60-second window ending at jobTime", async () => {
    const ch = createClickHouse(chResult([]));
    const { stripe } = createStripe();

    await storageMeteringHandler(createContext(), { clickhouse: ch, stripe });

    const sql = ch.query.mock.calls[0]?.[0]?.query as string;
    expect(sql).toContain(`CreatedAt < ${JOB_TIME}`);
    expect(sql).toContain(`CreatedAt >= ${WINDOW_START}`);
    expect(ch.query).toHaveBeenCalledWith(expect.objectContaining({ format: "JSONEachRow" }));
  });

  it("sums the stored PayloadBytes column and never reads the payload columns", async () => {
    // Deriving the size in-query forces the read to pull Input, Output and
    // three Maps for every span in the window; that peaks in the GiB range
    // and intermittently exceeds the client's cap, and a metering run that
    // dies leaves that minute's storage unmetered — silent under-billing.
    const ch = createClickHouse(chResult([]));
    const { stripe } = createStripe();

    await storageMeteringHandler(createContext(), { clickhouse: ch, stripe });

    const sql = ch.query.mock.calls[0]?.[0]?.query as string;
    expect(sql).toContain("SUM(PayloadBytes)");
    for (const payloadColumn of [
      "length(Input)",
      "length(Output)",
      "SpanAttributes",
      "ResourceAttributes",
      "Metadata",
    ]) {
      expect(sql).not.toContain(payloadColumn);
    }
    // FINAL collapses retried spans; without it a redelivered span bills twice.
    expect(sql).toContain("FROM otel_traces FINAL");
  });

  it("converts bytes to fractional GB so sub-GB deltas bill correctly", async () => {
    const ch = createClickHouse(chResult([{ stripeCustomerId: "cus_b", deltaBytes: "1500000000" }]));
    const { stripe, create } = createStripe();

    await storageMeteringHandler(createContext(), { clickhouse: ch, stripe });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { value: "1.5", stripe_customer_id: "cus_b" } }),
      expect.anything(),
    );
  });

  it("skips customers with zero delta bytes (no meter event)", async () => {
    const ch = createClickHouse(chResult([{ stripeCustomerId: "cus_zero", deltaBytes: "0" }]));
    const { stripe, create } = createStripe();

    await storageMeteringHandler(createContext(), { clickhouse: ch, stripe });

    expect(create).not.toHaveBeenCalled();
    expect(ch.close).toHaveBeenCalledTimes(1);
  });

  it("bills every non-zero customer in a mixed batch and skips the zero one", async () => {
    const ch = createClickHouse(
      chResult([
        { stripeCustomerId: "cus_a", deltaBytes: "1000000000" }, // 1 GB
        { stripeCustomerId: "cus_zero", deltaBytes: "0" }, // skipped
        { stripeCustomerId: "cus_b", deltaBytes: "3000000000" }, // 3 GB
      ]),
    );
    const { stripe, create } = createStripe();

    await storageMeteringHandler(createContext(), { clickhouse: ch, stripe });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map((c) => c[0].payload)).toEqual([
      { value: "1", stripe_customer_id: "cus_a" },
      { value: "3", stripe_customer_id: "cus_b" },
    ]);
  });

  it("skips synthetic (test/fixture) customers, billing only the real one and logging no error", async () => {
    const ch = createClickHouse(
      chResult([
        { stripeCustomerId: "cus_e2e_fixture_b2c3d4e5", deltaBytes: "5000000000" },
        { stripeCustomerId: "cus_test_1783968621000_a1b2c3d4", deltaBytes: "8000000000" },
        { stripeCustomerId: "cus_real", deltaBytes: "2000000000" }, // 2 GB
      ]),
    );
    const { stripe, create } = createStripe();

    await storageMeteringHandler(createContext(), { clickhouse: ch, stripe });

    // Only the real customer is billed; the synthetic ids never reach Stripe
    // (metering them 404s), so no per-row error is logged for them either.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      { event_name: "storage_gb_meter", payload: { value: "2", stripe_customer_id: "cus_real" } },
      { idempotencyKey: `storage-cus_real-${JOB_TIME}` },
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("continues to the next customer when a Stripe meter call fails, logs it, and still closes ClickHouse", async () => {
    const ch = createClickHouse(
      chResult([
        { stripeCustomerId: "cus_fail", deltaBytes: "1000000000" },
        { stripeCustomerId: "cus_ok", deltaBytes: "2000000000" },
      ]),
    );
    const create = vi.fn().mockRejectedValueOnce(new Error("Stripe error")).mockResolvedValueOnce({});
    const stripe: IStripeClient = { billing: { meterEvents: { create } } };

    await storageMeteringHandler(createContext(), { clickhouse: ch, stripe });

    expect(create).toHaveBeenCalledTimes(2); // did not bail on the failed customer
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ stripeCustomerId: "cus_fail" }),
    );
    expect(ch.close).toHaveBeenCalledTimes(1);
  });

  it("rethrows and still closes + flushes when the ClickHouse query fails", async () => {
    const ch = createClickHouse();
    const queryError = new Error("ClickHouse down");
    ch.query.mockRejectedValueOnce(queryError);
    const { stripe, create } = createStripe();

    await expect(
      storageMeteringHandler(createContext(), { clickhouse: ch, stripe }),
    ).rejects.toThrow("ClickHouse down");

    expect(create).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(queryError, expect.objectContaining({ jobTime: JOB_TIME }));
    expect(ch.close).toHaveBeenCalledTimes(1);
    expect(mockLogger.flush).toHaveBeenCalledTimes(1);
  });
});
