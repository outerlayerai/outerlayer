/**
 * Route handler tests for the OpenAPI GET /v1/health/files route.
 *
 * Verifies:
 * - Success path returns the full ComponentHealth shape at the top level
 *   (no { data } wrapper) — external monitoring and the CD health-check
 *   action read `.status` from the top level.
 * - Status-code mapping: healthy/degraded → 200, unhealthy → 503.
 * - Cache-Control header preserved (matches /health + /v1/health/ingestion).
 * - Critical dependency failures (Supabase) yield unhealthy.
 * - Non-critical dependency failures (GitHub) yield degraded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../routes/_shared';
import type { ComponentHealth } from '../../types/health';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCheckFiles = vi.fn();

vi.mock('../../services/health', () => ({
  createHealthService: vi.fn(() => ({
    checkFiles: mockCheckFiles,
    // checkIngestion is also on the interface but not used by FilesHealth
    checkIngestion: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Import route class (after mocks are hoisted)
// ---------------------------------------------------------------------------

import { FilesHealth } from '../routes/health';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedResponse {
  body: unknown;
  status: number;
  headers: Record<string, string> | undefined;
}

function createMockContext(): { ctx: AppContext; getResponse: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200, headers: undefined };

  const ctx = {
    env: {
      CLICKHOUSE_HOST: 'http://localhost:8123',
      CLICKHOUSE_PASSWORD: 'test',
      SUPABASE_API_BASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-key',
      NODE_ENV: 'production',
    },
    json: vi.fn((body: unknown, status?: number, headers?: Record<string, string>) => {
      captured = { body, status: status ?? 200, headers };
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: headers ?? {},
      });
    }),
  } as unknown as AppContext;

  return { ctx, getResponse: () => captured };
}

function createRouteInstance(): FilesHealth {
  const instance = new (FilesHealth as unknown as new (opts: unknown) => FilesHealth)({
    router: {},
    raiseUnknownParameters: false,
    route: '/v1/health/files',
    urlParams: [],
  });
  (instance as unknown as { getValidatedData: ReturnType<typeof vi.fn> }).getValidatedData =
    vi.fn().mockResolvedValue({});
  return instance;
}

function makeHealth(overrides: Partial<ComponentHealth> = {}): ComponentHealth {
  return {
    status: 'healthy',
    component: 'files_api',
    timestamp: '2026-04-18T12:00:00.000Z',
    dependencies: [
      { name: 'supabase', status: 'healthy', latencyMs: 42 },
      { name: 'unkey', status: 'healthy', latencyMs: 30 },
      { name: 'github', status: 'healthy', latencyMs: 120 },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FilesHealth handler', () => {
  it('returns 200 with full ComponentHealth shape at top level when healthy', async () => {
    const health = makeHealth();
    mockCheckFiles.mockResolvedValueOnce(health);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect(body).toEqual(health);
    // CD health-check action (.github/actions/health-check/action.yml) reads
    // `.status` via jq. Assert it's at the top level.
    expect((body as { status: string }).status).toBe('healthy');
    // Assert no envelope wrapping.
    expect(Object.keys(body as object)).not.toContain('data');
  });

  it('returns 200 when degraded (non-critical dependency down)', async () => {
    const health = makeHealth({
      status: 'degraded',
      dependencies: [
        { name: 'supabase', status: 'healthy', latencyMs: 42 },
        { name: 'unkey', status: 'healthy', latencyMs: 30 },
        { name: 'github', status: 'unhealthy', latencyMs: 5000, error: 'timeout' },
      ],
    });
    mockCheckFiles.mockResolvedValueOnce(health);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect((body as { status: string }).status).toBe('degraded');
  });

  it('returns 503 when Supabase (critical) is down', async () => {
    const health = makeHealth({
      status: 'unhealthy',
      dependencies: [
        { name: 'supabase', status: 'unhealthy', latencyMs: 5000, error: 'Connection failed' },
        { name: 'unkey', status: 'healthy', latencyMs: 30 },
        { name: 'github', status: 'healthy', latencyMs: 120 },
      ],
    });
    mockCheckFiles.mockResolvedValueOnce(health);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(503);
    expect((body as { status: string }).status).toBe('unhealthy');
    expect((body as ComponentHealth).dependencies[0]?.error).toBe('Connection failed');
  });

  it('reports Unkey in the dependency set when it is down', async () => {
    // Unkey is non-critical (burst rate limiting, fails open), so the service
    // reports degraded rather than unhealthy. This pins that the dependency is
    // still surfaced in the payload with its error.
    const health = makeHealth({
      status: 'degraded',
      dependencies: [
        { name: 'supabase', status: 'healthy', latencyMs: 30 },
        { name: 'unkey', status: 'unhealthy', latencyMs: 5000, error: 'Liveness check failed' },
        { name: 'github', status: 'healthy', latencyMs: 120 },
      ],
    });
    mockCheckFiles.mockResolvedValueOnce(health);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect((body as { status: string }).status).toBe('degraded');
    const unkeyDep = (body as ComponentHealth).dependencies.find((d) => d.name === 'unkey');
    expect(unkeyDep?.status).toBe('unhealthy');
    expect(unkeyDep?.error).toBe('Liveness check failed');
  });

  it('preserves Cache-Control header (matches /health + /v1/health/ingestion)', async () => {
    mockCheckFiles.mockResolvedValueOnce(makeHealth());

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { headers } = getResponse();
    expect(headers?.['Cache-Control']).toBe('public, max-age=10, s-maxage=10');
  });

  it('preserves dependencies array shape for downstream observability', async () => {
    const health = makeHealth();
    mockCheckFiles.mockResolvedValueOnce(health);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body } = getResponse();
    const dependencies = (body as ComponentHealth).dependencies;
    expect(dependencies).toHaveLength(3);
    expect(dependencies.map((d) => d.name)).toEqual(['supabase', 'unkey', 'github']);
  });
});

// ---------------------------------------------------------------------------
// Schema documentation test
// ---------------------------------------------------------------------------

describe('FilesHealth OpenAPI schema', () => {
  it('declares Health tag, 200 response, and 503 response', () => {
    const route = createRouteInstance();
    const schema = route.schema as {
      tags: string[];
      responses: Record<string, unknown>;
    };

    expect(schema.tags).toContain('Health');
    expect(schema.responses).toHaveProperty('200');
    expect(schema.responses).toHaveProperty('503');
  });
});
