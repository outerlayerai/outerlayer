/**
 * Tests: POST /api/platform-admin/dora-metrics/collect
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const mockRunCollection = vi.fn();

vi.mock('@/lib/dora-metrics/collection-service', () => ({
  DoraCollectionService: class MockDoraCollectionService {
    runCollection = mockRunCollection;
  },
}));

import { POST } from '../route';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';
import { seedPlatformAdminAccess } from '@/test-helpers/msw-handlers';

const SUCCESS_RESULT = {
  betterstack_incidents: { collected: 5, errors: [] },
  ok: true,
};

const ERROR_RESULT = {
  betterstack_incidents: { collected: 0, errors: ['BetterStack API 503'] },
  ok: false,
};

function createRequest(body: unknown): Request {
  return new Request('http://localhost/api/platform-admin/dora-metrics/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makePlatformAdmin() {
  return {
    ...mockUser,
    id: 'user-123',
    email: 'admin@outerlayer.ai',
  };
}

describe('POST /api/platform-admin/dora-metrics/collect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedPlatformAdminAccess(makePlatformAdmin() as any);
  });

  it('should return 200 with results when collection succeeds', async () => {
    mockRunCollection.mockResolvedValue(SUCCESS_RESULT);

    const response = await POST(createRequest({ backfill: false }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'completed',
      results: SUCCESS_RESULT,
    });
  });

  it('should pass correct options to DoraCollectionService.runCollection', async () => {
    mockRunCollection.mockResolvedValue(SUCCESS_RESULT);

    await POST(
      createRequest({
        backfill: true,
        backfill_months: 3,
      }),
    );

    expect(mockRunCollection).toHaveBeenCalledWith({
      backfill: true,
      backfillMonths: 3,
    });
  });

  it('should return 400 when body is not valid JSON', async () => {
    const response = await POST(
      new Request('http://localhost/api/platform-admin/dora-metrics/collect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"backfill":',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid JSON body');
  });

  it('should return 400 when the body fails validation', async () => {
    const response = await POST(createRequest({ backfill: 'not-a-boolean-at-all' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Validation error');
  });

  it('should return 500 with the failed results when collection reports errors (no silent partials)', async () => {
    mockRunCollection.mockResolvedValue(ERROR_RESULT);

    const response = await POST(createRequest({ backfill: false }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ status: 'failed', results: ERROR_RESULT });
  });
});
