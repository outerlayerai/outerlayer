/**
 * Tests: GET /api/cron/dora-collect
 *
 * Tests the scheduled DORA incident collection route handler including:
 * - Bearer token authentication via CRON_SECRET (timing-safe)
 * - DoraCollectionService delegation with correct constructor args
 * - runCollection called with { backfill: false }
 * - Response status: 500 on ANY collection error so the calling workflow
 *   goes red (returning 200 unless every source fails keeps monitoring green
 *   while data goes missing)
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Polyfill: Response.json static method (not available in jsdom/node-fetch)
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (typeof Response.json !== 'function') {
    (Response as any).json = (data: unknown, init?: ResponseInit) => {
      return new Response(JSON.stringify(data), {
        ...init,
        headers: {
          ...((init as any)?.headers ?? {}),
          'content-type': 'application/json',
        },
      });
    };
  }
});

// ---------------------------------------------------------------------------
// Hoisted mocks -- vi.hoisted makes these available inside vi.mock factories
// ---------------------------------------------------------------------------

const mockRunCollection = vi.hoisted(() => vi.fn());
// Mutable token holder so individual tests can set/clear the value the route
// reads. The route imports BETTERSTACK_API_TOKEN from the validated
// config-global.server (NOT raw process.env) — that's the whole point of the
// fix — so the mock exposes it via a getter over this holder.
const tokenHolder = vi.hoisted(
  () => ({ value: 'bs-test-token' as string | undefined }),
);
// ---------------------------------------------------------------------------
// Module mocks -- must be before route import
// ---------------------------------------------------------------------------

vi.mock('@/config-global.server', () => ({
  CRON_SECRET: 'test-cron-secret',
  SUPABASE_SECRET_KEY: 'test-service-role-key',
  DORA_ENVIRONMENT: 'production',
  get BETTERSTACK_API_TOKEN() {
    return tokenHolder.value;
  },
}));

vi.mock('@/lib/dora-metrics/collection-service', () => {
  return {
    DoraCollectionService: class MockDoraCollectionService {
      constructor(
        public supabase: unknown,
        public betterStackToken: string,
        public environment: string,
      ) {
        MockDoraCollectionService.lastInstance = this;
      }
      runCollection = mockRunCollection;
      static lastInstance: any = null;
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { GET } from '../route';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SUCCESS_RESULT = {
  betterstack_incidents: { collected: 5, errors: [] },
  ok: true,
};

const ERROR_RESULT = {
  betterstack_incidents: { collected: 0, errors: ['BetterStack API 503'] },
  ok: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers['authorization'] = token;
  }
  return new NextRequest('http://localhost/api/cron/dora-collect', {
    method: 'GET',
    headers,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/dora-collect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tokenHolder.value = 'bs-test-token';
    process.env.BETTERSTACK_API_TOKEN = 'bs-test-token';
  });

  // =========================================================================
  // Authentication
  // =========================================================================

  it('should return 401 when no authorization header is provided', async () => {
    const request = createCronRequest();

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  it('should return 401 when bearer token does not match CRON_SECRET', async () => {
    const request = createCronRequest('Bearer wrong-secret');

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  it('should return 401 when authorization header is missing Bearer prefix', async () => {
    const request = createCronRequest('test-cron-secret');

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  // =========================================================================
  // Successful collection
  // =========================================================================

  it('should return 200 with collection results on success', async () => {
    mockRunCollection.mockResolvedValue(SUCCESS_RESULT);

    const request = createCronRequest('Bearer test-cron-secret');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(SUCCESS_RESULT);
  });

  // =========================================================================
  // Error status determination
  // =========================================================================

  it('should return 500 on ANY collection error so the calling workflow goes red', async () => {
    mockRunCollection.mockResolvedValue(ERROR_RESULT);

    const request = createCronRequest('Bearer test-cron-secret');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual(ERROR_RESULT);
  });

  // =========================================================================
  // Service construction and invocation
  // =========================================================================

  it('should pass the BetterStack token to DoraCollectionService and request incremental collection', async () => {
    mockRunCollection.mockResolvedValue(SUCCESS_RESULT);

    const request = createCronRequest('Bearer test-cron-secret');
    await GET(request);

    const { DoraCollectionService } = await import(
      '@/lib/dora-metrics/collection-service'
    );
    const instance = (DoraCollectionService as any).lastInstance;

    expect(instance.supabase).toEqual(expect.any(Object));
    expect(instance.betterStackToken).toBe('bs-test-token');
    expect(instance.environment).toBe('production');

    expect(mockRunCollection).toHaveBeenCalledOnce();
    expect(mockRunCollection).toHaveBeenCalledWith({ backfill: false });
  });

  it('should pass an empty token when BETTERSTACK_API_TOKEN is not set', async () => {
    mockRunCollection.mockResolvedValue(SUCCESS_RESULT);

    // Unset in the validated env (the route's source), not raw process.env.
    tokenHolder.value = undefined;

    const request = createCronRequest('Bearer test-cron-secret');
    await GET(request);

    const { DoraCollectionService } = await import(
      '@/lib/dora-metrics/collection-service'
    );
    const instance = (DoraCollectionService as any).lastInstance;

    expect(instance.betterStackToken).toBe('');
  });
});
