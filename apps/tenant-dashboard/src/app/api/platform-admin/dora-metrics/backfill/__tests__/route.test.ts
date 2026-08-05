/**
 * Tests: POST /api/platform-admin/dora-metrics/backfill
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
import {
  getSupabaseMswState,
  seedPlatformAdminAccess,
  seedSupabaseMswState,
} from '@/test-helpers/msw-handlers';

const SUCCESS_RESULT = {
  betterstack_incidents: { collected: 7, errors: [] },
  ok: true,
};

const ERROR_RESULT = {
  betterstack_incidents: { collected: 0, errors: ['BetterStack API error: 401 Unauthorized'] },
  ok: false,
};

function createRequest(): Request {
  return new Request('http://localhost/api/platform-admin/dora-metrics/backfill', {
    method: 'POST',
  });
}

function makePlatformAdmin() {
  return {
    ...mockUser,
    id: 'user-123',
    email: 'admin@outerlayer.ai',
  };
}

describe('POST /api/platform-admin/dora-metrics/backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedPlatformAdminAccess(makePlatformAdmin() as any);
  });

  it('should return 409 when backfill has already succeeded', async () => {
    seedSupabaseMswState({
      platformDoraCollectionStates: [
        {
          source: 'backfill',
          last_collected_at: '2026-02-01T00:00:00.000Z',
          last_run_at: '2026-02-01T00:00:00.000Z',
          last_run_status: 'success',
          last_error: null,
        },
      ],
    });

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Historical data has already been loaded');
    expect(mockRunCollection).not.toHaveBeenCalled();
  });

  it('should allow retry when previous backfill errored', async () => {
    seedSupabaseMswState({
      platformDoraCollectionStates: [
        {
          source: 'backfill',
          last_collected_at: null,
          last_run_at: '2026-02-01T00:00:00.000Z',
          last_run_status: 'error',
          last_error: 'network',
        },
      ],
    });
    mockRunCollection.mockResolvedValue(SUCCESS_RESULT);

    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(mockRunCollection).toHaveBeenCalledWith({
      backfill: true,
      backfillMonths: 1,
    });
  });

  it('should persist successful backfill state', async () => {
    mockRunCollection.mockResolvedValue(SUCCESS_RESULT);

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'completed', results: SUCCESS_RESULT });
    expect(getSupabaseMswState().platformDoraCollectionStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'backfill',
          last_run_status: 'success',
          last_error: null,
        }),
      ]),
    );
  });

  it('should NOT mark success when collection reports errors — records retryable error instead', async () => {
    // Marking 'success' whenever the service merely resolves permanently
    // locks out retries (409) after a backfill that collected nothing
    // because of a bad token.
    mockRunCollection.mockResolvedValue(ERROR_RESULT);

    const response = await POST(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Backfill failed');
    expect(getSupabaseMswState().platformDoraCollectionStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'backfill',
          last_run_status: 'error',
          last_error: 'BetterStack API error: 401 Unauthorized',
        }),
      ]),
    );

    // A retry after the error state must be allowed (not 409)
    mockRunCollection.mockResolvedValue(SUCCESS_RESULT);
    const retry = await POST(createRequest());
    expect(retry.status).toBe(200);
  });
});
