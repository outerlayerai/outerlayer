/**
 * Tests: GET /api/platform-admin/dora-metrics/trends
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

const mockGetTrends = vi.fn();

vi.mock('@/lib/dora-metrics/service', () => ({
  getDoraMetricsService: vi.fn(() => ({
    getTrends: mockGetTrends,
  })),
}));

import { GET } from '../route';
import { getDoraMetricsService } from '@/lib/dora-metrics/service';
import { seedPlatformAdminAccess } from '@/test-helpers/msw-handlers';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';

const MOCK_TRENDS_RESPONSE = {
  trends: {
    deploymentFrequency: { series: [{ x: '2026-02-10', y: 2.1 }, { x: '2026-02-11', y: 2.5 }], granularity: 'day' },
    leadTime: { series: [{ x: '2026-02-10', y: 4.5 }, { x: '2026-02-11', y: 3.8 }], granularity: 'day' },
    changeFailureRate: { series: [{ x: '2026-02-10', y: 10 }, { x: '2026-02-11', y: 8.5 }], granularity: 'day' },
    mttr: { series: [{ x: '2026-02-10', y: 2.0 }, { x: '2026-02-11', y: 1.5 }], granularity: 'day' },
  },
  period: {
    start: '2026-01-18T00:00:00.000Z',
    end: '2026-02-17T00:00:00.000Z',
  },
  granularity: 'day',
};

function createRequest(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/platform-admin/dora-metrics/trends');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return new Request(url.toString());
}

function makePlatformAdmin() {
  return {
    ...mockUser,
    id: 'user-123',
    email: 'admin@outerlayer.ai',
  };
}

describe('GET /api/platform-admin/dora-metrics/trends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with trends response when authenticated admin requests valid params', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetTrends.mockResolvedValue(MOCK_TRENDS_RESPONSE);

    const response = await GET(createRequest({ timeRange: '30d' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_TRENDS_RESPONSE);
  });

  it('should use default timeRange 30d when no timeRange param is provided', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetTrends.mockResolvedValue(MOCK_TRENDS_RESPONSE);

    await GET(createRequest());

    expect(mockGetTrends).toHaveBeenCalledWith('30d', undefined, 'production');
  });

  it('should pass timeRange and appId correctly to service when both are provided', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetTrends.mockResolvedValue(MOCK_TRENDS_RESPONSE);
    const appId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    await GET(createRequest({ timeRange: '7d', appId }));

    expect(mockGetTrends).toHaveBeenCalledWith('7d', appId, 'production');
  });

  it('should pass 90d timeRange to service when requested', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetTrends.mockResolvedValue(MOCK_TRENDS_RESPONSE);

    await GET(createRequest({ timeRange: '90d' }));

    expect(mockGetTrends).toHaveBeenCalledWith('90d', undefined, 'production');
  });

  it('should create DoraMetricsService with an admin client', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetTrends.mockResolvedValue(MOCK_TRENDS_RESPONSE);

    await GET(createRequest({ timeRange: '7d' }));

    expect(getDoraMetricsService).toHaveBeenCalledWith(expect.any(Object));
  });

  it('should return 400 when timeRange is invalid', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);

    const response = await GET(createRequest({ timeRange: 'invalid' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Validation error');
  });

  it('should return 400 when appId contains invalid characters', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);

    const response = await GET(createRequest({ timeRange: '30d', appId: 'invalid service!' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Validation error');
  });

  it('should return 500 when service throws an unexpected error', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetTrends.mockRejectedValue(new Error('ClickHouse connection lost'));

    const response = await GET(createRequest({ timeRange: '30d' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to fetch DORA trends');
  });
});
