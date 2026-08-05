/**
 * Tests: GET /api/platform-admin/dora-metrics/rankings
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

const mockGetRankings = vi.fn();

vi.mock('@/lib/dora-metrics/service', () => ({
  getDoraMetricsService: vi.fn(() => ({
    getRankings: mockGetRankings,
  })),
}));

import { GET } from '../route';
import { getDoraMetricsService } from '@/lib/dora-metrics/service';
import { seedPlatformAdminAccess } from '@/test-helpers/msw-handlers';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';

const MOCK_RANKINGS_RESPONSE = {
  rankings: [
    {
      serviceId: 'tenant-dashboard',
      serviceName: 'tenant-dashboard',
      metrics: {
        deploymentFrequency: { value: 3.0, performanceLevel: 'elite' },
        leadTime: { value: 2.5, performanceLevel: 'elite' },
        changeFailureRate: { value: 5.0, performanceLevel: 'elite' },
        mttr: { value: 0.5, performanceLevel: 'elite' },
      },
      totalDeployments: 90,
    },
  ],
  period: {
    start: '2026-01-18T00:00:00.000Z',
    end: '2026-02-17T00:00:00.000Z',
  },
};

function createRequest(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/platform-admin/dora-metrics/rankings');
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

describe('GET /api/platform-admin/dora-metrics/rankings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with rankings response when authenticated admin requests valid params', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetRankings.mockResolvedValue(MOCK_RANKINGS_RESPONSE);

    const response = await GET(
      createRequest({ timeRange: '30d', sortBy: 'deploymentFrequency', sortOrder: 'desc' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_RANKINGS_RESPONSE);
  });

  it('should use default sortBy and sortOrder when not provided', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetRankings.mockResolvedValue(MOCK_RANKINGS_RESPONSE);

    await GET(createRequest({ timeRange: '30d' }));

    expect(mockGetRankings).toHaveBeenCalledWith(
      '30d',
      'deploymentFrequency',
      'desc',
      'production',
    );
  });

  it('should use default timeRange 30d when no params are provided', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetRankings.mockResolvedValue(MOCK_RANKINGS_RESPONSE);

    await GET(createRequest());

    expect(mockGetRankings).toHaveBeenCalledWith(
      '30d',
      'deploymentFrequency',
      'desc',
      'production',
    );
  });

  it('should pass all params correctly to service when all are provided', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetRankings.mockResolvedValue(MOCK_RANKINGS_RESPONSE);

    await GET(createRequest({ timeRange: '7d', sortBy: 'leadTime', sortOrder: 'asc' }));

    expect(mockGetRankings).toHaveBeenCalledWith('7d', 'leadTime', 'asc', 'production');
  });

  it('should create DoraMetricsService with an admin client', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetRankings.mockResolvedValue(MOCK_RANKINGS_RESPONSE);

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

  it('should return 400 when sortBy value is invalid', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);

    const response = await GET(createRequest({ timeRange: '30d', sortBy: 'invalidMetric' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Validation error');
  });

  it('should return 400 when sortOrder value is invalid', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);

    const response = await GET(createRequest({ timeRange: '30d', sortOrder: 'random' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Validation error');
  });

  it('should return 500 when service throws an unexpected error', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetRankings.mockRejectedValue(new Error('ClickHouse connection lost'));

    const response = await GET(createRequest({ timeRange: '30d' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to fetch DORA rankings');
  });
});
