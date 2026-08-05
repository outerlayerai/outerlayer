/**
 * Stripe Meter Event Handler Tests
 *
 * Tests for the billing-critical scheduled job that counts spans,
 * traces, and scores, then reports combined usage to Stripe.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { stripeMeterEventHandler } from "./stripe-meter-event-handler";
import type { GatewayScheduleContext } from "@repo/gateway-core/types";
import { createClient } from "@clickhouse/client-web";
import Stripe from "stripe";

// Mock ClickHouse client
const mockQuery = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@clickhouse/client-web", () => ({
  createClient: vi.fn(() => ({
    query: mockQuery,
    close: mockClose,
  })),
}));

// Mock Stripe
const mockMeterEventsCreate = vi.fn();

vi.mock("stripe", () => {
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        billing: {
          meterEvents: {
            create: mockMeterEventsCreate,
          },
        },
      };
    }),
  };
});

type CountRow = { stripeCustomerId: string; count: number };

/** Helper to create a mock query result */
function mockJsonResult(data: CountRow[]) {
  return { json: vi.fn().mockResolvedValue(data) };
}

/**
 * Set up mockQuery to return specific data for spans, traces, scores
 * (called in that order via Promise.all)
 */
function setupQueries(
  spans: CountRow[] = [],
  traces: CountRow[] = [],
  scores: CountRow[] = []
) {
  mockQuery
    .mockResolvedValueOnce(mockJsonResult(spans))
    .mockResolvedValueOnce(mockJsonResult(traces))
    .mockResolvedValueOnce(mockJsonResult(scores));
}

describe("stripeMeterEventHandler", () => {
  const mockEnv = {
    CLICKHOUSE_HOST: "https://clickhouse.example.com",
    CLICKHOUSE_PASSWORD: "test-password",
    STRIPE_SECRET_KEY: "sk_test_123",
    STRIPE_SPAN_METER_KEY: "span_meter_event",
  };

  const createContext = (
    scheduledTime: number,
    envExtra: Record<string, unknown> = {}
  ): GatewayScheduleContext => ({
    env: { ...mockEnv, ...envExtra } as any,
    ctx: { waitUntil: vi.fn() },
    event: {
      cron: "* * * * *",
      type: "scheduled",
      scheduledTime,
    },
    cache: {} as any,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockMeterEventsCreate.mockResolvedValue({ id: "meter_event_123" });
  });

  describe("ClickHouse query construction", () => {
    it("should run 3 parallel queries for spans, traces, and scores", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it("should query spans with correct 1-minute time window", async () => {
      const scheduledTime = 1700000000000;
      const expectedJobTime = 1700000000;
      const expectedBufferTime = 1700000000 - 60;

      setupQueries();

      await stripeMeterEventHandler(createContext(scheduledTime));

      // First query = spans
      const spansQuery = mockQuery.mock.calls[0]![0].query;
      expect(spansQuery).toContain(`CreatedAt < ${expectedJobTime}`);
      expect(spansQuery).toContain(`CreatedAt >= ${expectedBufferTime}`);
      expect(spansQuery).toContain("COUNT(*) as count");
      expect(spansQuery).toContain("FROM otel_traces");
      expect(spansQuery).toContain("GROUP BY StripeCustomerId");
    });

    it("should query distinct traces", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      const tracesQuery = mockQuery.mock.calls[1]![0].query;
      expect(tracesQuery).toContain("COUNT(DISTINCT TraceId) as count");
      expect(tracesQuery).toContain("FROM otel_traces");
    });

    it("should query scores joined via TenantId", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      const scoresQuery = mockQuery.mock.calls[2]![0].query;
      expect(scoresQuery).toContain("FROM scores");
      expect(scoresQuery).toContain("INNER JOIN");
      expect(scoresQuery).toContain("s.TenantId = t.TenantId");
    });

    it("should filter out empty StripeCustomerId in all queries", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      for (let i = 0; i < 3; i++) {
        expect(mockQuery.mock.calls[i]![0].query).toContain("StripeCustomerId != ''");
      }
    });
  });

  describe("ClickHouse client lifecycle", () => {
    it("should close the ClickHouse client after querying", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("builds the ClickHouse client from the env connection details WITH the metering guardrails", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      // The guardrails are asserted because an uncapped metering query on a
      // shared instance can pin the server-wide memory ceiling and kill
      // every co-tenant workload's queries with it.
      expect(vi.mocked(createClient)).toHaveBeenCalledWith({
        url: "https://clickhouse.example.com",
        password: "test-password",
        clickhouse_settings: {
          max_memory_usage: "3000000000",
          max_bytes_before_external_group_by: "700000000",
          max_bytes_before_external_sort: "700000000",
          do_not_merge_across_partitions_select_final: 1,
        },
      });
    });

    it("should close the ClickHouse client before creating Stripe meter events", async () => {
      setupQueries(
        [{ stripeCustomerId: "cus_123", count: 10 }],
        [{ stripeCustomerId: "cus_123", count: 3 }],
        []
      );

      const callOrder: string[] = [];
      mockClose.mockImplementation(() => {
        callOrder.push("close");
        return Promise.resolve();
      });
      mockMeterEventsCreate.mockImplementation(() => {
        callOrder.push("stripe");
        return Promise.resolve({ id: "meter_event_123" });
      });

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(callOrder).toEqual(["close", "stripe"]);
    });
  });

  describe("combined metering", () => {
    it("should sum spans + traces + scores into a single meter event per customer", async () => {
      setupQueries(
        [{ stripeCustomerId: "cus_123", count: 100 }],
        [{ stripeCustomerId: "cus_123", count: 5 }],
        [{ stripeCustomerId: "cus_123", count: 20 }]
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(1);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: "125", // 100 + 5 + 20
            stripe_customer_id: "cus_123",
          }),
        }),
        expect.any(Object)
      );
      // Stripe client built with the secret key + bounded network retries.
      expect(vi.mocked(Stripe)).toHaveBeenCalledWith("sk_test_123", { maxNetworkRetries: 3 });
    });

    it("should handle customers appearing in only some queries", async () => {
      setupQueries(
        [{ stripeCustomerId: "cus_a", count: 50 }],
        [{ stripeCustomerId: "cus_b", count: 10 }],
        [{ stripeCustomerId: "cus_a", count: 5 }]
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);

      const payloads = mockMeterEventsCreate.mock.calls.map((call) => call[0].payload);
      expect(payloads).toContainEqual(
        expect.objectContaining({ value: "55", stripe_customer_id: "cus_a" }) // 50 spans + 5 scores
      );
      expect(payloads).toContainEqual(
        expect.objectContaining({ value: "10", stripe_customer_id: "cus_b" }) // 10 traces only
      );
    });

    it("should skip customers with zero total", async () => {
      setupQueries(
        [{ stripeCustomerId: "cus_zero", count: 0 }],
        [],
        []
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });

    it("should use configured meter event name from env", async () => {
      setupQueries(
        [{ stripeCustomerId: "cus_123", count: 10 }],
        [],
        []
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          event_name: "span_meter_event",
        }),
        expect.any(Object)
      );
    });
  });

  describe("idempotency", () => {
    it("should generate unique idempotency key per customer per job run", async () => {
      const scheduledTime = 1700000000000;
      const expectedJobTime = 1700000000;

      setupQueries(
        [{ stripeCustomerId: "cus_abc", count: 5 }],
        [],
        []
      );

      await stripeMeterEventHandler(createContext(scheduledTime));

      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          idempotencyKey: `cus_abc-${expectedJobTime}`,
        })
      );
    });

    it("should generate different idempotency keys for different customers", async () => {
      setupQueries(
        [
          { stripeCustomerId: "cus_first", count: 10 },
          { stripeCustomerId: "cus_second", count: 20 },
        ],
        [],
        []
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      const calls = mockMeterEventsCreate.mock.calls;
      const idempotencyKeys = calls.map((call) => call[1].idempotencyKey);

      expect(idempotencyKeys).toContain("cus_first-1700000000");
      expect(idempotencyKeys).toContain("cus_second-1700000000");
    });

    it("should generate different idempotency keys for different job runs", async () => {
      setupQueries(
        [{ stripeCustomerId: "cus_123", count: 10 }],
        [],
        []
      );
      await stripeMeterEventHandler(createContext(1700000000000));

      setupQueries(
        [{ stripeCustomerId: "cus_123", count: 10 }],
        [],
        []
      );
      await stripeMeterEventHandler(createContext(1700000060000));

      const calls = mockMeterEventsCreate.mock.calls;
      expect(calls[0]![1]!.idempotencyKey).toBe("cus_123-1700000000");
      expect(calls[1]![1]!.idempotencyKey).toBe("cus_123-1700000060");
    });
  });

  describe("empty results handling", () => {
    it("should not create meter events when no data found", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });

    it("should handle empty arrays from all queries gracefully", async () => {
      mockQuery
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      await expect(
        stripeMeterEventHandler(createContext(1700000000000))
      ).resolves.toBeUndefined();

      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should propagate Stripe API errors to the caller", async () => {
      setupQueries(
        [{ stripeCustomerId: "cus_123", count: 10 }],
        [],
        []
      );

      const stripeError = new Error("Stripe API error");
      mockMeterEventsCreate.mockRejectedValue(stripeError);

      await expect(
        stripeMeterEventHandler(createContext(1700000000000))
      ).rejects.toThrow("Stripe API error");
    });

    it("should propagate ClickHouse query errors to the caller", async () => {
      mockQuery.mockRejectedValue(new Error("ClickHouse connection failed"));

      await expect(
        stripeMeterEventHandler(createContext(1700000000000))
      ).rejects.toThrow("ClickHouse connection failed");
    });

    it("meters the remaining customers when one meter event fails (no tail abort)", async () => {
      // Without per-customer isolation, cus_b's failure aborts the loop and
      // cus_c goes silently un-metered for the window. That behavior calls
      // create only twice, which this test rejects.
      setupQueries(
        [
          { stripeCustomerId: "cus_a", count: 10 },
          { stripeCustomerId: "cus_b", count: 20 },
          { stripeCustomerId: "cus_c", count: 30 },
        ],
        [],
        []
      );
      const stripeError = new Error("Stripe API error for cus_b");
      mockMeterEventsCreate.mockImplementation((body: { payload: { stripe_customer_id: string } }) =>
        body.payload.stripe_customer_id === "cus_b"
          ? Promise.reject(stripeError)
          : Promise.resolve({ id: "meter_event_123" })
      );

      // The job still rejects — with the underlying Stripe error, so alerting
      // sees the real cause exactly as before the isolation.
      await expect(
        stripeMeterEventHandler(createContext(1700000000000))
      ).rejects.toThrow("Stripe API error for cus_b");

      // Every customer was ATTEMPTED, in order, with exact payloads and
      // per-customer idempotency keys — cus_c metered despite cus_b failing.
      expect(mockMeterEventsCreate.mock.calls).toEqual([
        [
          {
            event_name: "span_meter_event",
            payload: { value: "10", stripe_customer_id: "cus_a" },
          },
          { idempotencyKey: "cus_a-1700000000" },
        ],
        [
          {
            event_name: "span_meter_event",
            payload: { value: "20", stripe_customer_id: "cus_b" },
          },
          { idempotencyKey: "cus_b-1700000000" },
        ],
        [
          {
            event_name: "span_meter_event",
            payload: { value: "30", stripe_customer_id: "cus_c" },
          },
          { idempotencyKey: "cus_c-1700000000" },
        ],
      ]);
    });

    it("attempts every customer and rejects with the FIRST error when several fail", async () => {
      setupQueries(
        [
          { stripeCustomerId: "cus_x", count: 1 },
          { stripeCustomerId: "cus_y", count: 2 },
        ],
        [],
        []
      );
      mockMeterEventsCreate
        .mockRejectedValueOnce(new Error("first failure"))
        .mockRejectedValueOnce(new Error("second failure"));

      await expect(
        stripeMeterEventHandler(createContext(1700000000000))
      ).rejects.toThrow("first failure");

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe("multiple customers", () => {
    it("should process all customers across queries", async () => {
      setupQueries(
        Array.from({ length: 5 }, (_, i) => ({
          stripeCustomerId: `cus_${i}`,
          count: (i + 1) * 100,
        })),
        [],
        []
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(5);
    });

    it("should report accurate combined counts for each customer", async () => {
      setupQueries(
        [
          { stripeCustomerId: "cus_small", count: 1 },
          { stripeCustomerId: "cus_large", count: 999999 },
        ],
        [
          { stripeCustomerId: "cus_small", count: 1 },
          { stripeCustomerId: "cus_large", count: 1 },
        ],
        []
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      const payloads = mockMeterEventsCreate.mock.calls.map((call) => call[0].payload);

      expect(payloads).toContainEqual(
        expect.objectContaining({ value: "2", stripe_customer_id: "cus_small" })
      );
      expect(payloads).toContainEqual(
        expect.objectContaining({ value: "1000000", stripe_customer_id: "cus_large" })
      );
    });
  });

  describe("queue fan-out (USAGE_METER_QUEUE binding present)", () => {
    // With the queue bound, the cron enqueues one
    // message per customer and makes NO direct Stripe calls — the consumer
    // owns them. Absent the binding (every other test in this file), the
    // inline fallback loop runs, which those tests continue to pin.
    function makeQueue() {
      return { send: vi.fn(), sendBatch: vi.fn().mockResolvedValue(undefined) };
    }

    it("enqueues one message per customer with jobTime and makes no direct Stripe calls", async () => {
      const queue = makeQueue();
      setupQueries(
        [
          { stripeCustomerId: "cus_a", count: 10 },
          { stripeCustomerId: "cus_b", count: 20 },
        ],
        [{ stripeCustomerId: "cus_a", count: 5 }],
        []
      );

      await stripeMeterEventHandler(
        createContext(1700000000000, { USAGE_METER_QUEUE: queue })
      );

      // Exact message bodies, positionally — the consumer rebuilds the
      // `${customerId}-${jobTime}` idempotency key from these fields.
      expect(queue.sendBatch.mock.calls).toEqual([
        [
          [
            {
              body: {
                stripeCustomerId: "cus_a",
                totalValue: 15,
                spans: 10,
                traces: 5,
                scores: 0,
                jobTime: 1700000000,
              },
            },
            {
              body: {
                stripeCustomerId: "cus_b",
                totalValue: 20,
                spans: 20,
                traces: 0,
                scores: 0,
                jobTime: 1700000000,
              },
            },
          ],
        ],
      ]);
      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });

    it("chunks enqueues at 100 messages per sendBatch call", async () => {
      const queue = makeQueue();
      setupQueries(
        Array.from({ length: 250 }, (_, i) => ({
          stripeCustomerId: `cus_${i}`,
          count: i + 1,
        })),
        [],
        []
      );

      await stripeMeterEventHandler(
        createContext(1700000000000, { USAGE_METER_QUEUE: queue })
      );

      const batchSizes = queue.sendBatch.mock.calls.map(
        (call) => (call[0] as unknown[]).length
      );
      expect(batchSizes).toEqual([100, 100, 50]);
      // Ordering preserved across chunks: first of chunk 2 is customer 100.
      expect(queue.sendBatch.mock.calls[1]![0][0].body.stripeCustomerId).toBe("cus_100");
    });

    it("excludes zero-total customers from the enqueue", async () => {
      const queue = makeQueue();
      setupQueries(
        [
          { stripeCustomerId: "cus_zero", count: 0 },
          { stripeCustomerId: "cus_real", count: 7 },
        ],
        [],
        []
      );

      await stripeMeterEventHandler(
        createContext(1700000000000, { USAGE_METER_QUEUE: queue })
      );

      expect(queue.sendBatch).toHaveBeenCalledTimes(1);
      expect(queue.sendBatch.mock.calls[0]![0]).toEqual([
        {
          body: {
            stripeCustomerId: "cus_real",
            totalValue: 7,
            spans: 7,
            traces: 0,
            scores: 0,
            jobTime: 1700000000,
          },
        },
      ]);
    });

    it("propagates sendBatch failures to the caller (cron alerting path)", async () => {
      const queue = makeQueue();
      queue.sendBatch.mockRejectedValue(new Error("queue unavailable"));
      setupQueries([{ stripeCustomerId: "cus_a", count: 1 }], [], []);

      await expect(
        stripeMeterEventHandler(createContext(1700000000000, { USAGE_METER_QUEUE: queue }))
      ).rejects.toThrow("queue unavailable");
    });

    it("excludes synthetic (test/fixture) customers from the enqueue", async () => {
      const queue = makeQueue();
      setupQueries(
        [
          { stripeCustomerId: "cus_e2e_fixture_tenant-1", count: 40 },
          { stripeCustomerId: "cus_test_1783968621000_a1b2c3d4", count: 10 },
          { stripeCustomerId: "cus_real", count: 7 },
        ],
        [],
        []
      );

      await stripeMeterEventHandler(
        createContext(1700000000000, { USAGE_METER_QUEUE: queue })
      );

      // Only the real customer is enqueued — a synthetic id has no Stripe
      // customer, so enqueuing it would dead-letter and page a false alert.
      expect(queue.sendBatch).toHaveBeenCalledTimes(1);
      expect(queue.sendBatch.mock.calls[0]![0]).toEqual([
        {
          body: {
            stripeCustomerId: "cus_real",
            totalValue: 7,
            spans: 7,
            traces: 0,
            scores: 0,
            jobTime: 1700000000,
          },
        },
      ]);
    });
  });

  describe("synthetic (test/fixture) customers", () => {
    // E2E/integration fixtures seed real billing rows with synthetic
    // stripe_customer_ids (cus_e2e_fixture_*, cus_test_*) that have no Stripe
    // customer behind them. Their trace usage reaches this job, but metering it
    // always 404s → the usage-meter queue dead-letters → a CRITICAL false page.
    it("meters only the real customer on the inline path, skipping synthetic ids", async () => {
      setupQueries(
        [
          { stripeCustomerId: "cus_e2e_fixture_b2c3d4e5", count: 40 },
          { stripeCustomerId: "cus_test_1783968621000_a1b2c3d4", count: 10 },
          { stripeCustomerId: "cus_real", count: 7 },
        ],
        [],
        []
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      // Exactly one Stripe call, for the real customer only.
      expect(mockMeterEventsCreate).toHaveBeenCalledTimes(1);
      expect(mockMeterEventsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            value: "7",
            stripe_customer_id: "cus_real",
          }),
        }),
        { idempotencyKey: "cus_real-1700000000" }
      );
    });

    it("makes no Stripe call when every customer in the window is synthetic", async () => {
      setupQueries(
        [
          { stripeCustomerId: "cus_e2e_fixture_b2c3d4e5", count: 40 },
          { stripeCustomerId: "cus_test_hobby_9f8e7d6c", count: 10 },
        ],
        [],
        []
      );

      await stripeMeterEventHandler(createContext(1700000000000));

      expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    });
  });

  describe("billing accuracy", () => {
    it("should count ALL spans (not just generations) in the span query", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      const spansQuery = mockQuery.mock.calls[0]![0].query;
      expect(spansQuery).not.toContain("Type =");
      expect(spansQuery).not.toContain("Type=");
    });

    it("should use CreatedAt (server time) not Timestamp (client time) for billing window", async () => {
      setupQueries();

      await stripeMeterEventHandler(createContext(1700000000000));

      const spansQuery = mockQuery.mock.calls[0]![0].query;
      expect(spansQuery).toContain("CreatedAt");
      expect(spansQuery).not.toMatch(/WHERE.*Timestamp/);
    });
  });
});
