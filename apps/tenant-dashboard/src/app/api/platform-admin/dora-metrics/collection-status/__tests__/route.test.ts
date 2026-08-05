/**
 * Tests: GET /api/platform-admin/dora-metrics/collection-status
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

import { GET } from '../route';
import { mockUser } from '@/test-helpers/fixtures/auth.fixtures';
import { server } from '@/test-helpers/msw-server';
import {
  seedPlatformAdminAccess,
  seedSupabaseMswState,
} from '@/test-helpers/msw-handlers';

const SUPABASE_URL = 'http://localhost:54321';

function createRequest(): Request {
  return new Request('http://localhost/api/platform-admin/dora-metrics/collection-status');
}

function makePlatformAdmin() {
  return {
    ...mockUser,
    id: 'user-123',
    email: 'admin@outerlayer.ai',
  };
}

describe('GET /api/platform-admin/dora-metrics/collection-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedPlatformAdminAccess(makePlatformAdmin() as any);
  });

  it('should return 200 with sources array when collection state exists', async () => {
    const rows = [
      {
        source: 'betterstack_incidents',
        last_collected_at: '2026-02-17T08:00:00.000Z',
        last_run_at: '2026-02-17T08:00:00.000Z',
        last_run_status: 'success',
        last_error: null,
      },
      {
        source: 'github_actions',
        last_collected_at: '2026-02-17T09:30:00.000Z',
        last_run_at: '2026-02-17T09:30:00.000Z',
        last_run_status: 'success',
        last_error: null,
      },
    ];
    seedSupabaseMswState({ platformDoraCollectionStates: rows });

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ sources: rows });
  });

  it('should return 200 with empty sources array when no collection state exists', async () => {
    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ sources: [] });
  });

  it('should return 500 when database query fails', async () => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/platform_dora_collection_state`, () =>
        HttpResponse.json({ message: 'db unavailable' }, { status: 500 }),
      ),
    );

    const response = await GET(createRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to fetch collection status');
  });
});
