/**
 * Tests: GET /api/platform-admin/dora-metrics
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

const mockGetMetrics = vi.fn();

vi.mock('@/lib/dora-metrics/service', () => ({
  getDoraMetricsService: vi.fn(() => ({
    getMetrics: mockGetMetrics,
  })),
}));

import { GET } from '../route';
import { getDoraMetricsService } from '@/lib/dora-metrics/service';
import { seedPlatformAdminAccess, seedSupabaseAuth } from '@/test-helpers/msw-handlers';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';

const MOCK_METRICS_RESPONSE = {
  metrics: {
    deploymentFrequency: {
      value: 2.5,
      unit: 'deploys/day',
      performanceLevel: 'elite',
      trend: { direction: 'up', changePercent: 15 },
      sampleSize: 75,
    },
    leadTime: {
      value: 4.2,
      unit: 'hours',
      performanceLevel: 'high',
      trend: { direction: 'down', changePercent: -10 },
      sampleSize: 75,
      isProxy: true,
    },
    changeFailureRate: {
      value: 8.5,
      unit: '%',
      performanceLevel: 'elite',
      trend: { direction: 'stable', changePercent: 0.5 },
      sampleSize: 75,
    },
    mttr: {
      value: 2.0,
      unit: 'hours',
      performanceLevel: 'high',
      trend: { direction: 'down', changePercent: -20 },
      sampleSize: 6,
    },
  },
  period: {
    start: '2026-01-18T00:00:00.000Z',
    end: '2026-02-17T00:00:00.000Z',
  },
  comparisonPeriod: {
    start: '2025-12-19T00:00:00.000Z',
    end: '2026-01-18T00:00:00.000Z',
  },
};

function createRequest(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/platform-admin/dora-metrics');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return new Request(url.toString());
}

function makePlatformAdmin(email = 'admin@outerlayer.ai') {
  return {
    ...mockUser,
    id: 'user-123',
    email,
    app_metadata: {
      ...mockUser.app_metadata,
      tenant_id: 'tenant-123',
    },
  };
}

describe('GET /api/platform-admin/dora-metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 401 when user is not authenticated', async () => {
    const response = await GET(createRequest({ timeRange: '30d' }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  // seedPlatformAdminAccess, not seedSupabaseAuth: this user HOLDS a
  // platform_user_role row, so the domain check is the only thing that can deny
  // them. Seeded without the role, the role check denies too and the test passes
  // even with the domain check deleted — which is exactly what it has to catch.
  it('should return 401 when email domain is not allowed, even WITH a platform role', async () => {
    seedPlatformAdminAccess(makePlatformAdmin('user@example.com') as any);

    const response = await GET(createRequest({ timeRange: '30d' }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
    // The handler must not have run — a 401 body with metrics would mean the
    // gate returned late.
    expect(mockGetMetrics).not.toHaveBeenCalled();
  });

  it('should return 401 when user has no platform_user_role', async () => {
    seedSupabaseAuth({ user: makePlatformAdmin('noadmin@outerlayer.ai') as any });

    const response = await GET(createRequest({ timeRange: '30d' }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  it('should return 200 with metrics response when authenticated admin requests valid params', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetMetrics.mockResolvedValue(MOCK_METRICS_RESPONSE);

    const response = await GET(createRequest({ timeRange: '7d' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(MOCK_METRICS_RESPONSE);
  });

  it('should use default timeRange 30d when no timeRange param is provided', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetMetrics.mockResolvedValue(MOCK_METRICS_RESPONSE);

    await GET(createRequest());

    expect(mockGetMetrics).toHaveBeenCalledWith('30d', undefined, 'production');
  });

  it('should pass timeRange and appId to service when both are provided', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetMetrics.mockResolvedValue(MOCK_METRICS_RESPONSE);
    const appId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    await GET(createRequest({ timeRange: '90d', appId }));

    expect(mockGetMetrics).toHaveBeenCalledWith('90d', appId, 'production');
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
    mockGetMetrics.mockRejectedValue(new Error('ClickHouse connection lost'));

    const response = await GET(createRequest({ timeRange: '30d' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to calculate DORA metrics');
  });

  it('should create DoraMetricsService with an admin client', async () => {
    seedPlatformAdminAccess(makePlatformAdmin() as any);
    mockGetMetrics.mockResolvedValue(MOCK_METRICS_RESPONSE);

    await GET(createRequest({ timeRange: '7d' }));

    expect(getDoraMetricsService).toHaveBeenCalledWith(expect.any(Object));
  });
});
