/**
 * Unit tests for the PR-session-comment queue consumer.
 *
 * The whole point of this consumer is coalescing: several messages naming
 * the same (tenant, repository, prNumber) must produce exactly ONE POST to
 * the internal refresh endpoint, and the resulting ack/retry decision must
 * apply identically to every message that shared the target.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageBatch } from '@cloudflare/workers-types';
import type { Env } from '@repo/gateway-core/types';
import type { PrCommentQueueMessage } from '@repo/gateway-core/types/queue-messages';

const { mockLogger, mockCreateLogger } = vi.hoisted(() => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
  return { mockLogger: logger, mockCreateLogger: vi.fn(() => logger) };
});

vi.mock('../services/logger', () => ({
  createLoggerFromContext: mockCreateLogger,
}));

import { handlePrCommentQueue, PR_COMMENT_MAX_RETRY_ATTEMPTS } from './pr-comment-queue';

// ── Builders ─────────────────────────────────────────────────────────────────

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    DASHBOARD_BASE_URL: 'https://app.example.test',
    PR_COMMENT_REFRESH_SECRET: 'shh-secret',
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

function queueBody(overrides: Partial<PrCommentQueueMessage> = {}): PrCommentQueueMessage {
  return {
    tenantId: TENANT,
    repository: 'owner/repo',
    prNumber: 42,
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

function makeBatch(messages: ReturnType<typeof makeMessage>[]): MessageBatch<PrCommentQueueMessage> {
  return {
    queue: 'pr-comment-refresh',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<PrCommentQueueMessage>;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  msgCounter = 0;
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mockLogger.flush.mockReset();
});

describe('handlePrCommentQueue', () => {
  it('does nothing at all for an empty batch — not even a logger', async () => {
    const fetchImpl = vi.fn();
    await handlePrCommentQueue(makeBatch([]), makeEnv(), undefined, { fetchImpl });
    expect(mockCreateLogger).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // AC-057-10 — the queue half of the criterion's STRUCTURAL claim: the
  // consumer turns queued messages into the internal POST that makes the
  // comment appear, purely off queue delivery, with no scheduled batch
  // process in the path. The webhook half is covered in
  // handle-pull-request-event-comment.test.ts. The criterion's p50/p90
  // numbers are an SLO tracked against production telemetry, not asserted
  // here — a unit test claiming to prove them would be worse than none.
  it('coalesces one message per PR into a single POST and acks on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ tenantId: TENANT, repository: 'owner/repo', prNumber: 42, status: 'updated' }],
      }),
    );
    const msg = makeMessage(queueBody());

    const env = makeEnv();
    await handlePrCommentQueue(makeBatch([msg]), env, undefined, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://app.example.test/api/internal/pr-comment-refresh');
    expect(init.method).toBe('POST');
    // Exact, not `toMatchObject`: this request carries the internal shared
    // secret, so an EXTRA header appearing here is exactly the kind of thing
    // a test should fail on rather than tolerate.
    expect(init.headers).toEqual({
      Authorization: 'Bearer shh-secret',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ tenantId: TENANT, repository: 'owner/repo', prNumber: 42 }],
    });
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(mockCreateLogger).toHaveBeenCalledWith(env, { source: 'pr-comment-queue' }, undefined);
  });

  it('coalesces several messages naming the same PR into ONE POST item', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ tenantId: TENANT, repository: 'owner/repo', prNumber: 42, status: 'unchanged' }],
      }),
    );
    const msgA = makeMessage(queueBody());
    const msgB = makeMessage(queueBody());
    const msgC = makeMessage(queueBody());

    await handlePrCommentQueue(makeBatch([msgA, msgB, msgC]), makeEnv(), undefined, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init.body as string).items).toHaveLength(1);
    // Coalescing means one refresh call — but every message that named the
    // same PR still gets acked, not just the first.
    expect(msgA.ack).toHaveBeenCalledTimes(1);
    expect(msgB.ack).toHaveBeenCalledTimes(1);
    expect(msgC.ack).toHaveBeenCalledTimes(1);
  });

  it('coalesces distinct PRs into distinct POST items and routes results independently', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          { tenantId: TENANT, repository: 'owner/repo', prNumber: 1, status: 'updated' },
          { tenantId: TENANT, repository: 'owner/repo', prNumber: 2, status: 'failed', reason: 'boom' },
        ],
      }),
    );
    const okMsg = makeMessage(queueBody({ prNumber: 1 }));
    const failMsg = makeMessage(queueBody({ prNumber: 2 }));

    await handlePrCommentQueue(makeBatch([okMsg, failMsg]), makeEnv(), undefined, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string).items).toHaveLength(2);
    expect(okMsg.ack).toHaveBeenCalledTimes(1);
    expect(okMsg.retry).not.toHaveBeenCalled();
    expect(failMsg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(failMsg.ack).not.toHaveBeenCalled();
  });

  it('acks a message whose PR the response marks failed, once max attempts is hit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ tenantId: TENANT, repository: 'owner/repo', prNumber: 42, status: 'failed', reason: 'no installation' }],
      }),
    );
    const msg = makeMessage(queueBody(), PR_COMMENT_MAX_RETRY_ATTEMPTS);

    await handlePrCommentQueue(makeBatch([msg]), makeEnv(), undefined, { fetchImpl });

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[pr-comment-queue] Giving up after max attempts (sweep will repair)',
      { attempts: PR_COMMENT_MAX_RETRY_ATTEMPTS, error: 'no installation' },
    );
  });

  it('retries the WHOLE batch on a non-2xx response — no per-item result to route by', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    const msgA = makeMessage(queueBody({ prNumber: 1 }), 1);
    const msgB = makeMessage(queueBody({ prNumber: 2 }), 1);

    await handlePrCommentQueue(makeBatch([msgA, msgB]), makeEnv(), undefined, { fetchImpl });

    expect(msgA.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msgB.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msgA.ack).not.toHaveBeenCalled();
    expect(msgB.ack).not.toHaveBeenCalled();
  });

  it('retries the whole batch on a network throw, and gives up past max attempts', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const msg = makeMessage(queueBody(), PR_COMMENT_MAX_RETRY_ATTEMPTS);

    await handlePrCommentQueue(makeBatch([msg]), makeEnv(), undefined, { fetchImpl });

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('drops an invalid message (acked, never retried) without calling fetch for it', async () => {
    const fetchImpl = vi.fn();
    const invalidMsg = makeMessage({ nope: true });

    await handlePrCommentQueue(makeBatch([invalidMsg]), makeEnv(), undefined, { fetchImpl });

    expect(invalidMsg.ack).toHaveBeenCalledTimes(1);
    expect(invalidMsg.retry).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith('[pr-comment-queue] Invalid message dropped', {
      messageId: invalidMsg.id,
      error: expect.any(String),
    });
  });

  it('a batch of only invalid messages never calls fetch', async () => {
    const fetchImpl = vi.fn();
    const invalidMsg = makeMessage({ nope: true });
    const otherInvalidMsg = makeMessage({ tenantId: OTHER_TENANT });

    await handlePrCommentQueue(makeBatch([invalidMsg, otherInvalidMsg]), makeEnv(), undefined, { fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(invalidMsg.ack).toHaveBeenCalledTimes(1);
    expect(otherInvalidMsg.ack).toHaveBeenCalledTimes(1);
  });

  it('retries when the response omits a result for a coalesced target', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const msg = makeMessage(queueBody(), 1);

    await handlePrCommentQueue(makeBatch([msg]), makeEnv(), undefined, { fetchImpl });

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('uses the coalesced group MAX attempts to decide give-up, not any single message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ tenantId: TENANT, repository: 'owner/repo', prNumber: 42, status: 'failed', reason: 'x' }],
      }),
    );
    // One message is fresh, one has already hit the cap — the whole group
    // must give up together so a fresh redelivery doesn't extend retries
    // past the point the sweep already owns this PR.
    const freshMsg = makeMessage(queueBody(), 1);
    const exhaustedMsg = makeMessage(queueBody(), PR_COMMENT_MAX_RETRY_ATTEMPTS);

    await handlePrCommentQueue(makeBatch([freshMsg, exhaustedMsg]), makeEnv(), undefined, { fetchImpl });

    expect(freshMsg.ack).toHaveBeenCalledTimes(1);
    expect(freshMsg.retry).not.toHaveBeenCalled();
    expect(exhaustedMsg.ack).toHaveBeenCalledTimes(1);
    expect(exhaustedMsg.retry).not.toHaveBeenCalled();
  });

  it('strips a trailing slash from DASHBOARD_BASE_URL before building the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ tenantId: TENANT, repository: 'owner/repo', prNumber: 42, status: 'updated' }],
      }),
    );
    const msg = makeMessage(queueBody());

    await handlePrCommentQueue(
      makeBatch([msg]),
      makeEnv({ DASHBOARD_BASE_URL: 'https://app.example.test/' }),
      undefined,
      { fetchImpl },
    );

    expect(fetchImpl.mock.calls[0]![0]).toBe('https://app.example.test/api/internal/pr-comment-refresh');
  });

  it('skips the fetch entirely and retries every coalesced message when PR_COMMENT_REFRESH_SECRET is unset', async () => {
    const fetchImpl = vi.fn();
    const msgA = makeMessage(queueBody({ prNumber: 1 }), 1);
    const msgB = makeMessage(queueBody({ prNumber: 2 }), 1);

    await handlePrCommentQueue(
      makeBatch([msgA, msgB]),
      makeEnv({ PR_COMMENT_REFRESH_SECRET: undefined }),
      undefined,
      { fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(msgA.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msgB.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msgA.ack).not.toHaveBeenCalled();
    expect(msgB.ack).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[pr-comment-queue] PR_COMMENT_REFRESH_SECRET is unset — skipping refresh POST',
      { targetCount: 2 },
    );
  });

  it('gives up (acks) on a missing secret once every coalesced message has hit max attempts', async () => {
    const fetchImpl = vi.fn();
    const msg = makeMessage(queueBody(), PR_COMMENT_MAX_RETRY_ATTEMPTS);

    await handlePrCommentQueue(
      makeBatch([msg]),
      makeEnv({ PR_COMMENT_REFRESH_SECRET: undefined }),
      undefined,
      { fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('defaults to the real global fetch when no fetchImpl is injected', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ tenantId: TENANT, repository: 'owner/repo', prNumber: 42, status: 'updated' }],
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const msg = makeMessage(queueBody());
      await handlePrCommentQueue(makeBatch([msg]), makeEnv(), undefined, {});
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(msg.ack).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
