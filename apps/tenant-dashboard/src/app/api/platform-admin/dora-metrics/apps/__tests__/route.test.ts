/**
 * Tests: GET /api/platform-admin/dora-metrics/apps
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';

vi.mock('server-only', () => ({}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const mockIsPreviewMode = vi.hoisted(() => vi.fn<() => boolean>());
const mockIsCiMode = vi.hoisted(() => vi.fn<() => boolean>());
const mockGetServices = vi.hoisted(() => vi.fn<() => string[]>());

vi.mock('@/lib/dora-metrics/service', () => ({
  isPreviewMode: mockIsPreviewMode,
  isCiMode: mockIsCiMode,
}));

vi.mock('@/lib/dora-metrics/mock-service', () => ({
  MockDoraMetricsService: class {
    getServices = mockGetServices;
  },
}));

import { GET } from '../route';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';
import { server } from '@/test-helpers/msw-server';
import {
  seedPlatformAdminAccess,
  seedSupabaseMswState,
} from '@/test-helpers/msw-handlers';

const SUPABASE_URL = 'http://localhost:54321';

function createRequest(): Request {
  return new Request('http://localhost/api/platform-admin/dora-metrics/apps');
}

function makePlatformAdmin() {
  return {
    ...mockUser,
    id: 'user-123',
    email: 'admin@outerlayer.ai',
  };
}

describe('GET /api/platform-admin/dora-metrics/apps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPreviewMode.mockReturnValue(false);
    mockIsCiMode.mockReturnValue(false);
    seedPlatformAdminAccess(makePlatformAdmin() as any);
  });

  it('should return distinct alphabetically sorted services from DB when not in preview mode', async () => {
    seedSupabaseMswState({
      platformDeployments: [
        {
          id: 'dep-1',
          service: 'tenant-dashboard',
          environment: 'production',
          status: 'success',
          commit_sha: null,
          commit_message: null,
          branch: null,
          failure_reason: null,
          duration_ms: null,
          triggered_by: null,
          pipeline_url: null,
          external_id: null,
          started_at: '2026-02-01T00:00:00.000Z',
          completed_at: '2026-02-01T00:01:00.000Z',
        },
        {
          id: 'dep-2',
          service: 'gateway',
          environment: 'production',
          status: 'success',
          commit_sha: null,
          commit_message: null,
          branch: null,
          failure_reason: null,
          duration_ms: null,
          triggered_by: null,
          pipeline_url: null,
          external_id: null,
          started_at: '2026-02-02T00:00:00.000Z',
          completed_at: '2026-02-02T00:01:00.000Z',
        },
        {
          id: 'dep-3',
          service: 'tenant-dashboard',
          environment: 'production',
          status: 'success',
          commit_sha: null,
          commit_message: null,
          branch: null,
          failure_reason: null,
          duration_ms: null,
          triggered_by: null,
          pipeline_url: null,
          external_id: null,
          started_at: '2026-02-03T00:00:00.000Z',
          completed_at: '2026-02-03T00:01:00.000Z',
        },
        {
          id: 'dep-4',
          service: 'analytics-worker',
          environment: 'production',
          status: 'success',
          commit_sha: null,
          commit_message: null,
          branch: null,
          failure_reason: null,
          duration_ms: null,
          triggered_by: null,
          pipeline_url: null,
          external_id: null,
          started_at: '2026-02-04T00:00:00.000Z',
          completed_at: '2026-02-04T00:01:00.000Z',
        },
      ],
    });

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      apps: [
        { id: 'analytics-worker', name: 'analytics-worker' },
        { id: 'gateway', name: 'gateway' },
        { id: 'tenant-dashboard', name: 'tenant-dashboard' },
      ],
    });
  });

  it('should return empty apps array when no deployments exist', async () => {
    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ apps: [] });
  });

  it('should return 500 when the deployments query errors', async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/platform_deployment`, () =>
        HttpResponse.json({ message: 'db unavailable' }, { status: 500 }),
      ),
    );

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to fetch services');
  });

  it('should return services from mock data in preview mode', async () => {
    mockIsPreviewMode.mockReturnValue(true);
    mockGetServices.mockReturnValue(['gateway', 'tenant-dashboard', 'analytics-worker']);

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      apps: [
        { id: 'gateway', name: 'gateway' },
        { id: 'tenant-dashboard', name: 'tenant-dashboard' },
        { id: 'analytics-worker', name: 'analytics-worker' },
      ],
    });
  });

  it('should return services from mock data in CI mode', async () => {
    mockIsCiMode.mockReturnValue(true);
    mockGetServices.mockReturnValue(['gateway']);

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      apps: [{ id: 'gateway', name: 'gateway' }],
    });
  });
});
