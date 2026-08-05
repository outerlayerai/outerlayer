// @vitest-environment node
//
// Dispatch wiring for the `pull_request_review` event through the signed
// webhook route: the review handler receives the parsed body exactly once,
// only for its own event type — and the `pull_request` branch stays
// untouched by review events (and vice versa).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

const prHandler = vi.hoisted(() => vi.fn());
const reviewHandler = vi.hoisted(() => vi.fn());
vi.mock('../handle-pull-request-event', () => ({
  handlePullRequestEvent: prHandler,
}));
vi.mock('../handle-pull-request-review-event', () => ({
  handlePullRequestReviewEvent: reviewHandler,
}));

beforeAll(() => {
  if (typeof (globalThis.Response as unknown as { json?: unknown }).json !== 'function') {
    (globalThis.Response as unknown as { json: unknown }).json = (
      body: unknown,
      init?: ResponseInit,
    ) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
  }
});

const WEBHOOK_SECRET = 'test-webhook-secret';

function signPayload(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function buildRequest(event: string, payload: object): NextRequest {
  const body = JSON.stringify(payload);
  return new NextRequest('http://localhost:3002/api/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': signPayload(body),
    },
    body,
  });
}

const REVIEW_PAYLOAD = {
  action: 'submitted',
  review: { state: 'approved', submitted_at: '2026-07-02T10:00:00Z', user: { id: 7 } },
  pull_request: { number: 5, user: { id: 8 } },
  repository: { full_name: 'acme/repo' },
};

describe('POST /api/webhooks/github — pull_request_review dispatch', () => {
  beforeEach(() => {
    prHandler.mockReset();
    prHandler.mockResolvedValue(undefined);
    reviewHandler.mockReset();
    reviewHandler.mockResolvedValue(undefined);
  });

  it('routes pull_request_review to the review handler with the parsed body', async () => {
    const { POST } = await import('../route');
    const res = await POST(buildRequest('pull_request_review', REVIEW_PAYLOAD));

    expect(res.status).toBe(200);
    expect(reviewHandler).toHaveBeenCalledTimes(1);
    expect(reviewHandler).toHaveBeenCalledWith(REVIEW_PAYLOAD);
    expect(prHandler).not.toHaveBeenCalled();
  });

  it('a pull_request event never reaches the review handler', async () => {
    const { POST } = await import('../route');
    const payload = { action: 'opened', pull_request: { number: 5 } };
    const res = await POST(buildRequest('pull_request', payload));

    expect(res.status).toBe(200);
    expect(prHandler).toHaveBeenCalledWith(payload);
    expect(reviewHandler).not.toHaveBeenCalled();
  });

  it('rejects an unsigned pull_request_review delivery before any handler runs', async () => {
    const { POST } = await import('../route');
    const body = JSON.stringify(REVIEW_PAYLOAD);
    const res = await POST(
      new NextRequest('http://localhost:3002/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request_review',
          'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
        },
        body,
      }),
    );

    expect(res.status).toBe(401);
    expect(reviewHandler).not.toHaveBeenCalled();
  });
});
