/**
 * Tests: POST /api/internal/dora/deployments
 *
 * Machine-to-machine DORA deployment ingestion (relocated from
 * /api/platform-admin/dora-metrics/deployments so the session middleware
 * never intercepts CI calls with a login redirect).
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

import { POST } from '../route';
import { server } from '@/test-helpers/msw-server';
import {
  getSupabaseMswState,
  seedSupabaseMswState,
} from '@/test-helpers/msw-handlers';

const SUPABASE_URL = 'http://localhost:54321';

const VALID_DEPLOYMENT = {
  service: 'tenant-dashboard',
  environment: 'production',
  status: 'success',
  started_at: '2026-02-17T10:00:00.000Z',
  commit_sha: 'abc123def456',
  commit_message: 'fix: resolve login bug',
  branch: 'main',
  duration_ms: 120000,
  triggered_by: 'github-actions',
  pipeline_url: 'https://github.com/org/repo/actions/runs/12345',
  external_id: 'gh-run-12345',
  completed_at: '2026-02-17T10:02:00.000Z',
  first_commit_at: '2026-02-16T18:30:00.000Z',
};

const MINIMAL_DEPLOYMENT = {
  service: 'gateway',
  environment: 'staging',
  status: 'running',
  started_at: '2026-02-17T08:00:00.000Z',
};

function createRequest(body: unknown, headers: Record<string, string> = {}) {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }

  return new Request('http://localhost/api/internal/dora/deployments', {
    method: 'POST',
    headers: requestHeaders,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

function createRequestWithApiKey(body: unknown, apiKey = 'test-api-key') {
  return createRequest(body, { 'x-api-key': apiKey });
}

describe('POST /api/internal/dora/deployments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DORA_INGEST_API_KEY = 'test-api-key';
  });

  it('should return 401 when x-api-key header is missing', async () => {
    const response = await POST(createRequest(VALID_DEPLOYMENT));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Invalid API key');
  });

  it('should return 401 when x-api-key is wrong (including length mismatch)', async () => {
    const wrongSameLength = await POST(
      createRequestWithApiKey(VALID_DEPLOYMENT, 'test-api-kez'),
    );
    expect(wrongSameLength.status).toBe(401);

    const wrongLength = await POST(
      createRequestWithApiKey(VALID_DEPLOYMENT, 'short'),
    );
    expect(wrongLength.status).toBe(401);
  });

  it('should return 401 when DORA_INGEST_API_KEY is unset (fail closed)', async () => {
    delete process.env.DORA_INGEST_API_KEY;

    const response = await POST(createRequestWithApiKey(VALID_DEPLOYMENT));

    expect(response.status).toBe(401);
  });

  it('should return 201, persist the row including first_commit_at, and record the cd_push heartbeat', async () => {
    const response = await POST(createRequestWithApiKey(VALID_DEPLOYMENT));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: 'platform-deployment-1', created: true });

    const state = getSupabaseMswState();
    expect(state.platformDeployments).toEqual([
      expect.objectContaining({
        id: 'platform-deployment-1',
        service: VALID_DEPLOYMENT.service,
        external_id: VALID_DEPLOYMENT.external_id,
        first_commit_at: VALID_DEPLOYMENT.first_commit_at,
      }),
    ]);
    expect(state.platformDoraCollectionStates).toEqual([
      expect.objectContaining({
        source: 'cd_push',
        last_run_status: 'success',
        last_error: null,
      }),
    ]);
  });

  it('should return 201 when only required fields are provided', async () => {
    const response = await POST(createRequestWithApiKey(MINIMAL_DEPLOYMENT));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: 'platform-deployment-1', created: true });
  });

  it('should return 200 created:false and NOT insert a second row when external_id already exists', async () => {
    seedSupabaseMswState({
      platformDeployments: [
        {
          id: 'existing-deployment-id',
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
          external_id: VALID_DEPLOYMENT.external_id,
          started_at: '2026-02-17T10:00:00.000Z',
          completed_at: '2026-02-17T10:02:00.000Z',
        },
      ],
    });

    const response = await POST(createRequestWithApiKey(VALID_DEPLOYMENT));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ created: false });
    expect(getSupabaseMswState().platformDeployments).toHaveLength(1);
  });

  it('should return 400 when the body fails validation', async () => {
    const response = await POST(
      createRequestWithApiKey({
        ...VALID_DEPLOYMENT,
        status: 'bad-status',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Validation error');
  });

  it('should return 500 when the upsert fails', async () => {
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/platform_deployment`, () =>
        HttpResponse.json({ message: 'insert failed' }, { status: 500 }),
      ),
    );

    const response = await POST(createRequestWithApiKey(VALID_DEPLOYMENT));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to record deployment');
  });

  it('should still return 201 when the heartbeat upsert fails (best-effort)', async () => {
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/platform_dora_collection_state`, () =>
        HttpResponse.json({ message: 'state write failed' }, { status: 500 }),
      ),
    );

    const response = await POST(createRequestWithApiKey(VALID_DEPLOYMENT));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ id: 'platform-deployment-1', created: true });
  });
});
