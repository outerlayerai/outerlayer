/**
 * Usage-meter queue consumer tests.
 *
 * Bug classes guarded:
 *  - the consumer sends the EXACT meter event the message describes, with the
 *    idempotency key derived from the message's jobTime (not "now") — the
 *    exactly-once guarantee across retries hangs on this
 *  - success acks, failure retries (never the other way around)
 *  - one message's failure doesn't stop the rest of the batch
 *  - the DLQ handler logs the un-metered window and always acks (terminal)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessageBatch, Message } from "@cloudflare/workers-types";
import type { UsageMeterQueueMessage } from "@repo/gateway-core/types/queue-messages";
import Stripe from "stripe";
import { handleUsageMeterQueue, handleUsageMeterDlq } from "./usage-meter-queue";

const mockMeterEventsCreate = vi.fn();

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      billing: {
        meterEvents: {
          create: mockMeterEventsCreate,
        },
      },
    };
  }),
}));

// Logger seam (true seam per testing conventions — gateway-owned, non-HTTP).
// Captured per-instance so tests can pin the structured log CONTRACT: the
// `source` routes log search, and the DLQ's `_alert`/`_metric` fields are what
// make BetterStack page an operator — flipping them silently kills the alert.
interface CapturedLogger {
  source: string | undefined;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}
const loggerInstances: CapturedLogger[] = [];

vi.mock("../services/logger", () => ({
  createLoggerFromContext: vi.fn((_env: unknown, opts?: { source?: string }) => {
    const instance: CapturedLogger = {
      source: opts?.source,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    loggerInstances.push(instance);
    return instance;
  }),
}));

const mockEnv = {
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_SPAN_METER_KEY: "span_meter_event",
} as any;

function makeMessage(
  body: UsageMeterQueueMessage,
  attempts = 1
): Message<UsageMeterQueueMessage> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } {
  return {
    id: `msg-${body.stripeCustomerId}`,
    timestamp: new Date(0),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<UsageMeterQueueMessage> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}

function makeBatch(
  messages: Message<UsageMeterQueueMessage>[],
  queue = "usage-meter"
): MessageBatch<UsageMeterQueueMessage> {
  return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<UsageMeterQueueMessage>;
}

const METER_A: UsageMeterQueueMessage = {
  stripeCustomerId: "cus_a",
  totalValue: 125,
  spans: 100,
  traces: 5,
  scores: 20,
  jobTime: 1700000000,
};

const METER_B: UsageMeterQueueMessage = {
  stripeCustomerId: "cus_b",
  totalValue: 7,
  spans: 7,
  traces: 0,
  scores: 0,
  jobTime: 1700000000,
};

// Mirrors the real Sentry payload that motivated the guard: a staging seed
// fixture (cus_e2e_fixture_<tenantId>) whose usage reached the meter queue.
const METER_SYNTHETIC: UsageMeterQueueMessage = {
  stripeCustomerId: "cus_e2e_fixture_b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  totalValue: 50,
  spans: 10,
  traces: 10,
  scores: 30,
  jobTime: 1783968621,
};

beforeEach(() => {
  vi.clearAllMocks();
  loggerInstances.length = 0;
  mockMeterEventsCreate.mockResolvedValue({ id: "meter_event_123" });
});

describe("handleUsageMeterQueue", () => {
  it("creates the meter event from the message and acks — idempotency key from the message jobTime", async () => {
    const msg = makeMessage(METER_A);

    await handleUsageMeterQueue(makeBatch([msg]), mockEnv);

    expect(mockMeterEventsCreate.mock.calls).toEqual([
      [
        {
          event_name: "span_meter_event",
          payload: { value: "125", stripe_customer_id: "cus_a" },
        },
        { idempotencyKey: "cus_a-1700000000" },
      ],
    ]);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();

    // Stripe client built with bounded network retries — same resilience the
    // inline cron path has (a dropped option object would retry nothing).
    expect(vi.mocked(Stripe)).toHaveBeenCalledWith("sk_test_123", { maxNetworkRetries: 3 });

    // Logger routed under the queue's source, and the success log carries the
    // full metering context (the idempotency key is what an operator greps).
    const logger = loggerInstances[0]!;
    expect(logger.source).toBe("usage-meter-queue");
    expect(logger.info).toHaveBeenCalledWith("stripe meter event sent", {
      stripeCustomerId: "cus_a",
      spans: 100,
      traces: 5,
      scores: 20,
      totalValue: 125,
      idempotencyKey: "cus_a-1700000000",
      attemptNumber: 1,
    });
  });

  it("retries (not acks) a message whose Stripe call fails, logging the retry context", async () => {
    mockMeterEventsCreate.mockRejectedValue(new Error("stripe down"));
    const msg = makeMessage(METER_A, 2);

    await handleUsageMeterQueue(makeBatch([msg]), mockEnv);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();

    // The failure log carries the fields an operator needs to correlate the
    // eventual DLQ entry: customer, window, key, and which attempt this was.
    const logger = loggerInstances[0]!;
    expect(logger.error).toHaveBeenCalledWith(expect.any(Error), {
      stripeCustomerId: "cus_a",
      totalValue: 125,
      jobTime: 1700000000,
      idempotencyKey: "cus_a-1700000000",
      attemptNumber: 2,
    });
  });

  it("processes the rest of the batch when one message fails", async () => {
    mockMeterEventsCreate.mockImplementation(
      (body: { payload: { stripe_customer_id: string } }) =>
        body.payload.stripe_customer_id === "cus_a"
          ? Promise.reject(new Error("stripe rejected cus_a"))
          : Promise.resolve({ id: "meter_event_123" })
    );
    const failing = makeMessage(METER_A);
    const healthy = makeMessage(METER_B);

    await handleUsageMeterQueue(makeBatch([failing, healthy]), mockEnv);

    expect(failing.retry).toHaveBeenCalledTimes(1);
    expect(healthy.ack).toHaveBeenCalledTimes(1);
    expect(mockMeterEventsCreate).toHaveBeenCalledWith(
      {
        event_name: "span_meter_event",
        payload: { value: "7", stripe_customer_id: "cus_b" },
      },
      { idempotencyKey: "cus_b-1700000000" }
    );
  });

  it("acks a synthetic (test/fixture) customer as a no-op without calling Stripe", async () => {
    const msg = makeMessage(METER_SYNTHETIC);

    await handleUsageMeterQueue(makeBatch([msg]), mockEnv);

    // No Stripe call (the create would 404), acked terminally so it never
    // retries into the DLQ + fires the critical false page.
    expect(mockMeterEventsCreate).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();

    const logger = loggerInstances[0]!;
    expect(logger.info).toHaveBeenCalledWith("skipped synthetic customer meter event", {
      stripeCustomerId: METER_SYNTHETIC.stripeCustomerId,
      totalValue: 50,
      jobTime: 1783968621,
      attemptNumber: 1,
    });
  });

  it("skips the synthetic customer but still meters the real one in the same batch", async () => {
    const synthetic = makeMessage(METER_SYNTHETIC);
    const real = makeMessage(METER_A);

    await handleUsageMeterQueue(makeBatch([synthetic, real]), mockEnv);

    expect(synthetic.ack).toHaveBeenCalledTimes(1);
    expect(real.ack).toHaveBeenCalledTimes(1);
    // The only Stripe call is the real customer's — the synthetic id never reaches it.
    expect(mockMeterEventsCreate.mock.calls).toEqual([
      [
        {
          event_name: "span_meter_event",
          payload: { value: "125", stripe_customer_id: "cus_a" },
        },
        { idempotencyKey: "cus_a-1700000000" },
      ],
    ]);
  });

  it("derives distinct idempotency keys for distinct windows of the same customer", async () => {
    const window1 = makeMessage({ ...METER_A, jobTime: 1700000000 });
    const window2 = makeMessage({ ...METER_A, jobTime: 1700000060 });

    await handleUsageMeterQueue(makeBatch([window1, window2]), mockEnv);

    const keys = mockMeterEventsCreate.mock.calls.map((call) => call[1].idempotencyKey);
    expect(keys).toEqual(["cus_a-1700000000", "cus_a-1700000060"]);
  });
});

describe("handleUsageMeterDlq", () => {
  it("acks every dead-lettered message (terminal) without calling Stripe", async () => {
    const msg1 = makeMessage(METER_A, 5);
    const msg2 = makeMessage(METER_B, 5);

    await handleUsageMeterDlq(makeBatch([msg1, msg2], "usage-meter-dlq"), mockEnv);

    expect(msg1.ack).toHaveBeenCalledTimes(1);
    expect(msg2.ack).toHaveBeenCalledTimes(1);
    expect(msg1.retry).not.toHaveBeenCalled();
    expect(mockMeterEventsCreate).not.toHaveBeenCalled();
  });

  it("logs each dead-lettered window as a critical alert with the full metering context", async () => {
    const msg = makeMessage(METER_A, 5);

    await handleUsageMeterDlq(makeBatch([msg], "usage-meter-dlq"), mockEnv);

    const logger = loggerInstances[0]!;
    expect(logger.source).toBe("usage-meter-dlq");

    const [error, context] = logger.error.mock.calls[0] as [Error, Record<string, unknown>];
    // The message names the customer, window, and un-metered value — what a
    // human reads first when paged.
    expect(error.message).toBe(
      "Stripe meter event failed permanently: cus_a window 1700000000 (125 units un-metered)"
    );
    // Exact context, incl. the alert/metric routing flags: `_alert: true` is
    // what makes BetterStack page an operator, `_metric: true` is what feeds
    // the billing.usage_meter.dlq counter. A flipped flag = a silent
    // under-metering incident, so both are pinned exactly.
    expect(context).toEqual({
      _alert: true,
      severity: "critical",
      alert_type: "usage_meter_failure",
      _metric: true,
      metric_name: "billing.usage_meter.dlq",
      metric_value: 1,
      stripeCustomerId: "cus_a",
      totalValue: 125,
      spans: 100,
      traces: 5,
      scores: 20,
      jobTime: 1700000000,
      idempotencyKey: "cus_a-1700000000",
      attemptCount: 5,
    });
  });

  it("does NOT page for a synthetic customer — logs it at info with no alert/metric flags", async () => {
    const msg = makeMessage(METER_SYNTHETIC, 5);

    await handleUsageMeterDlq(makeBatch([msg], "usage-meter-dlq"), mockEnv);

    expect(msg.ack).toHaveBeenCalledTimes(1);

    const logger = loggerInstances[0]!;
    // logger.error is the ONLY thing carrying _alert/_metric — never called for
    // a synthetic id, so BetterStack never pages and the DLQ counter stays flat.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "dead-lettered synthetic customer meter event (no alert)",
      {
        stripeCustomerId: METER_SYNTHETIC.stripeCustomerId,
        totalValue: 50,
        jobTime: 1783968621,
        idempotencyKey: `${METER_SYNTHETIC.stripeCustomerId}-1783968621`,
        attemptCount: 5,
      }
    );
  });

  it("still fires the critical alert for a real customer sharing a batch with a synthetic one", async () => {
    const synthetic = makeMessage(METER_SYNTHETIC, 5);
    const real = makeMessage(METER_A, 5);

    await handleUsageMeterDlq(
      makeBatch([synthetic, real], "usage-meter-dlq"),
      mockEnv
    );

    expect(synthetic.ack).toHaveBeenCalledTimes(1);
    expect(real.ack).toHaveBeenCalledTimes(1);

    // Exactly one critical alert, and it belongs to the real customer — the
    // guard suppresses only synthetic ids, never a genuine under-metering page.
    const logger = loggerInstances[0]!;
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [error, context] = logger.error.mock.calls[0] as [
      Error,
      Record<string, unknown>,
    ];
    expect(error.message).toBe(
      "Stripe meter event failed permanently: cus_a window 1700000000 (125 units un-metered)"
    );
    expect(context).toEqual(
      expect.objectContaining({ _alert: true, stripeCustomerId: "cus_a" })
    );
  });
});
