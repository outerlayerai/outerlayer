/**
 * Tests: GET /api/analytics (public uptime endpoint)
 *
 * Regression guard for the analytics-API outage: BetterStack probes the bare
 * `/api/analytics` path. Before this route existed the request fell through to
 * the auth middleware and returned 401, which the monitor read as an outage.
 * This route must answer publicly with the ClickHouse health status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const mockClickHouseQuery = vi.fn();
const getDefaultClient = vi.fn();

vi.mock('@/lib/analytics/client', () => ({
  getDefaultClient: () => getDefaultClient(),
}));

vi.mock('@/lib/analytics/queries', () => ({
  HEALTH_CHECK_QUERY: 'SELECT 1',
}));

vi.mock('@/lib/analytics/logger', () => ({
  analyticsLogger: { health: vi.fn() },
  createTimer: () => ({ elapsed: () => 7 }),
}));

import { GET } from '../route';

describe('GET /api/analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDefaultClient.mockReturnValue({ query: mockClickHouseQuery });
    mockClickHouseQuery.mockResolvedValue(undefined);
  });

  it('returns 200 + healthy when ClickHouse answers the probe', async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: 'healthy',
      timestamp: expect.any(String),
      dependencies: {
        clickhouse: { status: 'up', latencyMs: 7 },
      },
    });
    // The probe must actually run the health query, not just return OK blindly.
    expect(mockClickHouseQuery).toHaveBeenCalledWith({
      query: 'SELECT 1',
      format: 'JSONEachRow',
    });
  });

  it('returns 503 + down when ClickHouse is not configured', async () => {
    getDefaultClient.mockReturnValue(null);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.dependencies.clickhouse.status).toBe('down');
    expect(body.dependencies.clickhouse.error).toContain('CLICKHOUSE_HOST');
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  it('returns 503 + propagates the error when the probe query throws', async () => {
    mockClickHouseQuery.mockRejectedValue(new Error('connection refused'));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe('unhealthy');
    expect(body.dependencies.clickhouse).toEqual({
      status: 'down',
      latencyMs: 7,
      error: 'connection refused',
    });
  });
});
