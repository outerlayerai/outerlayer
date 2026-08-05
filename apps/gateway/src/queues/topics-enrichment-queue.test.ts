/**
 * Unit tests for the topics-enrichment queue seam.
 *
 * Backfill enqueue: job-tagged messages for scan-discovered candidates.
 * Consumer: the ack/retry routing per enrichment outcome — the queue's whole
 * value is that transient failures redeliver instead of freezing terminal
 * error rows, so the retry classification IS the behavior under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env } from '@repo/gateway-core/types';
import type { TopicsEnrichmentQueueMessage } from '@repo/gateway-core/types/queue-messages';

const { mockLogger, mockCreateLogger } = vi.hoisted(() => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  return { mockLogger: logger, mockCreateLogger: vi.fn(() => logger) };
});

vi.mock('../services/logger', () => ({
  createLoggerFromContext: mockCreateLogger,
}));

import {
  enqueueTopicsBackfillBatch,
  handleTopicsEnrichmentQueue,
  TOPICS_MAX_RETRY_ATTEMPTS,
} from './topics-enrichment-queue';
import {
  RetryableEnrichmentError,
  resolveTopicsConfig,
} from '../services/topics-enrichment-service';

// ── Builders ─────────────────────────────────────────────────────────────────

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    CLICKHOUSE_HOST: 'clickhouse.test',
    CLICKHOUSE_PASSWORD: 'pw',
    TOPICS_ENRICHMENT_ENABLED: 'true',
    ...overrides,
  } as unknown as Env;
}

let msgCounter = 0;
function makeMessage(body: unknown, attempts = 1) {
  return {
    id: `msg-${++msgCounter}`,
    timestamp: new Date(),
    attempts,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function queueBody(overrides: Partial<TopicsEnrichmentQueueMessage> = {}): TopicsEnrichmentQueueMessage {
  return {
    tenantId: TENANT,
    appId: 'app-1',
    environment: 'production',
    traceId: 'trace-1',
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

function makeBatch(messages: ReturnType<typeof makeMessage>[]): MessageBatch<TopicsEnrichmentQueueMessage> {
  return {
    queue: 'topics-enrichment',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<TopicsEnrichmentQueueMessage>;
}

const enabledConfig = resolveTopicsConfig({ TOPICS_ENRICHMENT_ENABLED: 'true' });

/** Full service double — the handler dispatches across all three job methods. */
function stubService(
  overrides: Partial<{
    enrichQueuedTrace: ReturnType<typeof vi.fn>;
    refreshQueuedTrace: ReturnType<typeof vi.fn>;
    sweepQueuedTrace: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    enrichQueuedTrace: vi.fn().mockResolvedValue('enriched'),
    refreshQueuedTrace: vi.fn().mockResolvedValue('enriched'),
    sweepQueuedTrace: vi.fn().mockResolvedValue('enriched'),
    ...overrides,
  };
}

beforeEach(() => {
  msgCounter = 0;
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mockLogger.flush.mockReset();
});

// ── Consumer ─────────────────────────────────────────────────────────────────

describe('handleTopicsEnrichmentQueue', () => {
  it('does nothing at all for an empty batch — not even a logger', async () => {
    await handleTopicsEnrichmentQueue(makeBatch([]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace: vi.fn() }),
      config: enabledConfig,
    });
    expect(mockCreateLogger).not.toHaveBeenCalled();
    expect(mockLogger.flush).not.toHaveBeenCalled();
  });

  it('enriches one trace per message and acks, passing the exact scope', async () => {
    const enrichQueuedTrace = vi.fn().mockResolvedValue('enriched');
    const msg = makeMessage(queueBody({ traceId: 'trace-9' }));

    const env = makeEnv();
    await handleTopicsEnrichmentQueue(makeBatch([msg]), env, undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: enabledConfig,
    });

    expect(enrichQueuedTrace).toHaveBeenCalledWith(
      {
        tenantId: TENANT,
        appId: 'app-1',
        environment: 'production',
        traceId: 'trace-9',
      },
      { finalAttempt: false },
    );
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    // The logger's source tag is how BetterStack isolates this consumer.
    expect(mockCreateLogger).toHaveBeenCalledWith(env, { source: 'topics-enrichment-queue' }, undefined);
    // The enriched metric, exactly — dashboards and alerts key on it.
    expect(mockLogger.info).toHaveBeenCalledWith('[topics-queue] Trace enriched', {
      _metric: true,
      metric_name: 'topics.enriched',
      metric_value: 1,
      traceId: 'trace-9',
      tenantId: TENANT,
      attempts: 1,
      queueLatencyMs: expect.any(Number),
    });
  });

  it('builds its own service when none is injected (disabled env drains; enabled env reaches the store)', async () => {
    // No deps at all + disabled config → every message acks without any
    // service construction (config resolution must tolerate absent deps).
    const disabledMsg = makeMessage(queueBody());
    await handleTopicsEnrichmentQueue(
      makeBatch([disabledMsg]),
      makeEnv({ TOPICS_ENRICHMENT_ENABLED: 'false' }),
    );
    expect(disabledMsg.ack).toHaveBeenCalledTimes(1);

    // No deps + enabled (mock model, unreachable ClickHouse) → the REAL
    // service is constructed and the store failure routes to a retry.
    const msg = makeMessage(queueBody(), 2);
    await handleTopicsEnrichmentQueue(
      makeBatch([msg]),
      makeEnv({ TOPICS_MOCK_MODEL: 'true', CLICKHOUSE_HOST: 'http://127.0.0.1:1' }),
    );
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('acks duplicates (already_enriched) without retry', async () => {
    const enrichQueuedTrace = vi.fn().mockResolvedValue('already_enriched');
    const msg = makeMessage(queueBody());

    await handleTopicsEnrichmentQueue(makeBatch([msg]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: enabledConfig,
    });

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('redelivers a still-streaming trace after another debounce window', async () => {
    const enrichQueuedTrace = vi.fn().mockResolvedValue('trace_not_quiet');
    const msg = makeMessage(queueBody(), 3);

    await handleTopicsEnrichmentQueue(makeBatch([msg]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: enabledConfig,
    });

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('redelivers an unreadable trace with linear backoff', async () => {
    const enrichQueuedTrace = vi.fn().mockResolvedValue('trace_missing');
    const msg = makeMessage(queueBody(), 2);

    await handleTopicsEnrichmentQueue(makeBatch([msg]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: enabledConfig,
    });

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('redelivers on a transient model failure instead of acking', async () => {
    const enrichQueuedTrace = vi
      .fn()
      .mockRejectedValue(new RetryableEnrichmentError('HTTP 429: rate limited'));
    const msg = makeMessage(queueBody(), 5);

    await handleTopicsEnrichmentQueue(makeBatch([msg]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: enabledConfig,
    });

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('declares the final attempt to the service and acks whatever happens', async () => {
    const enrichQueuedTrace = vi.fn().mockResolvedValue('enriched');
    const finalMsg = makeMessage(queueBody(), TOPICS_MAX_RETRY_ATTEMPTS);

    await handleTopicsEnrichmentQueue(makeBatch([finalMsg]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: enabledConfig,
    });
    expect(enrichQueuedTrace).toHaveBeenCalledWith(expect.anything(), {
      finalAttempt: true,
    });
    expect(finalMsg.ack).toHaveBeenCalledTimes(1);

    // Even an infrastructure throw on the final attempt acks — the scan owns
    // the trace from here; parking the message forever helps nobody. The
    // error must land in the log with its routing context intact.
    const failing = vi.fn().mockRejectedValue(new Error('clickhouse down'));
    const finalFailure = makeMessage(queueBody({ traceId: 'trace-f' }), TOPICS_MAX_RETRY_ATTEMPTS);
    await handleTopicsEnrichmentQueue(makeBatch([finalFailure]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace: failing }),
      config: enabledConfig,
    });
    expect(finalFailure.ack).toHaveBeenCalledTimes(1);
    expect(finalFailure.retry).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error), {
      traceId: 'trace-f',
      tenantId: TENANT,
      attempts: TOPICS_MAX_RETRY_ATTEMPTS,
    });

    // trace_not_quiet / trace_missing on the final attempt hand the trace to
    // the scan (ack), never another redelivery.
    for (const outcome of ['trace_not_quiet', 'trace_missing'] as const) {
      const msg = makeMessage(queueBody(), TOPICS_MAX_RETRY_ATTEMPTS);
      await handleTopicsEnrichmentQueue(makeBatch([msg]), makeEnv(), undefined, {
        service: stubService({ enrichQueuedTrace: vi.fn().mockResolvedValue(outcome) }),
        config: enabledConfig,
      });
      expect(msg.ack).toHaveBeenCalledTimes(1);
      expect(msg.retry).not.toHaveBeenCalled();
    }
  });

  it('acks without work when disabled, when the tenant left the allowlist, or on an invalid body', async () => {
    const enrichQueuedTrace = vi.fn();

    const disabledMsg = makeMessage(queueBody());
    await handleTopicsEnrichmentQueue(makeBatch([disabledMsg]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: resolveTopicsConfig({}),
    });
    expect(disabledMsg.ack).toHaveBeenCalledTimes(1);

    const filteredMsg = makeMessage(queueBody({ tenantId: OTHER_TENANT }));
    await handleTopicsEnrichmentQueue(makeBatch([filteredMsg]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: resolveTopicsConfig({
        TOPICS_ENRICHMENT_ENABLED: 'true',
        TOPICS_TENANT_ALLOWLIST: TENANT,
      }),
    });
    expect(filteredMsg.ack).toHaveBeenCalledTimes(1);

    const invalidMsg = makeMessage({ nope: true });
    await handleTopicsEnrichmentQueue(makeBatch([invalidMsg]), makeEnv(), undefined, {
      service: stubService({ enrichQueuedTrace }),
      config: enabledConfig,
    });
    expect(invalidMsg.ack).toHaveBeenCalledTimes(1);
    // The drop is only diagnosable through this log line — pin its identity.
    expect(mockLogger.warn).toHaveBeenCalledWith('[topics-queue] Invalid message dropped', {
      messageId: invalidMsg.id,
      error: expect.any(String),
    });

    expect(enrichQueuedTrace).not.toHaveBeenCalled();
  });
});

describe('job dispatch + backfill enqueue', () => {
  it('messages route to the method their job names — scope and finalAttempt intact', async () => {
    const service = stubService();
    const refreshMsg = makeMessage(queueBody({ traceId: 't-r', job: 'batched_refresh' }));
    const sweepMsg = makeMessage(queueBody({ traceId: 't-s', job: 'steering_sweep' }), TOPICS_MAX_RETRY_ATTEMPTS);
    const liveMsg = makeMessage(queueBody({ traceId: 't-l' }));

    await handleTopicsEnrichmentQueue(
      makeBatch([refreshMsg, sweepMsg, liveMsg]),
      makeEnv(),
      undefined,
      { service, config: enabledConfig },
    );

    expect(service.refreshQueuedTrace).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 't-r' }),
      { finalAttempt: false },
    );
    expect(service.sweepQueuedTrace).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 't-s' }),
      { finalAttempt: true },
    );
    expect(service.enrichQueuedTrace).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 't-l' }),
      { finalAttempt: false },
    );
    // Exactly one call each — no job leaks into another method.
    expect(service.refreshQueuedTrace).toHaveBeenCalledTimes(1);
    expect(service.sweepQueuedTrace).toHaveBeenCalledTimes(1);
    expect(service.enrichQueuedTrace).toHaveBeenCalledTimes(1);
    expect(refreshMsg.ack).toHaveBeenCalledTimes(1);
    expect(sweepMsg.ack).toHaveBeenCalledTimes(1);
    expect(liveMsg.ack).toHaveBeenCalledTimes(1);
  });

  it('a transient backfill failure redelivers with backoff, same as live', async () => {
    const service = stubService({
      refreshQueuedTrace: vi.fn().mockRejectedValue(new RetryableEnrichmentError('HTTP 429')),
    });
    const msg = makeMessage(queueBody({ job: 'batched_refresh' }), 2);

    await handleTopicsEnrichmentQueue(makeBatch([msg]), makeEnv(), undefined, {
      service,
      config: enabledConfig,
    });

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('enqueueTopicsBackfillBatch sends job-tagged bodies with NO delivery delay', async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const scopes = [
      { tenantId: TENANT, appId: 'app-1', environment: 'production', traceId: 'bf-1' },
      { tenantId: TENANT, appId: 'app-1', environment: 'dev', traceId: 'bf-2' },
    ];

    await enqueueTopicsBackfillBatch({ sendBatch } as never, mockLogger as never, scopes, 'batched_refresh');

    expect(sendBatch).toHaveBeenCalledTimes(1);
    // The metric line is the only visibility a backfill enqueue has.
    expect(mockLogger.info).toHaveBeenCalledWith('[topics-queue] Backfill batch enqueued', {
      _metric: true,
      metric_name: 'topics.backfill_enqueued',
      metric_value: 2,
      job: 'batched_refresh',
    });
    expect(sendBatch).toHaveBeenCalledWith([
      {
        body: {
          tenantId: TENANT,
          appId: 'app-1',
          environment: 'production',
          traceId: 'bf-1',
          enqueuedAt: expect.any(Number),
          job: 'batched_refresh',
        },
      },
      {
        body: {
          tenantId: TENANT,
          appId: 'app-1',
          environment: 'dev',
          traceId: 'bf-2',
          enqueuedAt: expect.any(Number),
          job: 'batched_refresh',
        },
      },
    ]);
  });

  it('enqueueTopicsBackfillBatch with no scopes is silent — no send, no metric', async () => {
    const sendBatch = vi.fn();
    await enqueueTopicsBackfillBatch({ sendBatch } as never, mockLogger as never, [], 'steering_sweep');
    expect(sendBatch).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('enqueueTopicsBackfillBatch chunks at 100 and never throws on send failure', async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const many = Array.from({ length: 101 }, (_, i) => ({
      tenantId: TENANT,
      appId: 'app-1',
      environment: 'production',
      traceId: `bf-${i}`,
    }));
    await enqueueTopicsBackfillBatch({ sendBatch } as never, mockLogger as never, many, 'steering_sweep');
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(sendBatch.mock.calls[0]![0]).toHaveLength(100);
    expect(sendBatch.mock.calls[1]![0]).toHaveLength(1);

    const failing = vi.fn().mockRejectedValue(new Error('queue down'));
    await expect(
      enqueueTopicsBackfillBatch({ sendBatch: failing } as never, mockLogger as never, many.slice(0, 1), 'steering_sweep'),
    ).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[topics-queue] Backfill enqueue failed (scan will repair)',
      { job: 'steering_sweep', error: 'queue down' },
    );
  });
});
