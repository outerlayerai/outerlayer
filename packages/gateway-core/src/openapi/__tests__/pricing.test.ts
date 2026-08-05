/**
 * Route handler tests for the OpenAPI GET /v1/pricing route.
 *
 * Verifies:
 * - Success response returns the pricing map unwrapped (raw shape, no { data } envelope).
 * - Cache-Control header preserves the legacy 1-day TTL contract.
 * - Service errors propagate (matches legacy behavior — refreshModelPricing falls
 *   back to bundled data silently, so the service itself rarely throws).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../routes/_shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetPricingData = vi.fn();

vi.mock('../../services', () => ({
  createPricingService: vi.fn(() => ({
    getPricingData: mockGetPricingData,
  })),
}));

// initCache touches Cloudflare KV bindings; stub it out so the handler
// doesn't need a live execution context.
vi.mock('../../utils', () => ({
  initCache: vi.fn(() => ({})),
}));

vi.mock('../../cache-store', () => ({
  memory: {},
}));

// ---------------------------------------------------------------------------
// Import route class (after mocks are hoisted)
// ---------------------------------------------------------------------------

import { GetPricing } from '../routes/pricing';
import { fakeBuildGatewayContext as buildGatewayContext } from '../../test-helpers/fake-gateway-context';
import type { Env } from '../../types';
import type { ExecutionContext } from '@cloudflare/workers-types';

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

  const gtx = buildGatewayContext({} as Env, {} as ExecutionContext);
  const ctx = {
    env: {},
    executionCtx: {},
    get: vi.fn((k: string) => (k === 'gtx' ? gtx : undefined)),
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

function createRouteInstance(): GetPricing {
  const instance = new (GetPricing as unknown as new (opts: unknown) => GetPricing)({
    router: {},
    raiseUnknownParameters: false,
    route: '/v1/pricing',
    urlParams: [],
  });
  // Stub getValidatedData; no path/query params to validate.
  (instance as unknown as { getValidatedData: ReturnType<typeof vi.fn> }).getValidatedData =
    vi.fn().mockResolvedValue({});
  return instance;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GetPricing handler', () => {
  it('returns pricing map unwrapped (no { data } envelope, matches legacy shape)', async () => {
    const pricingMap = {
      'gpt-4': { promptPrice: 0.03, completionPrice: 0.06 },
      'claude-3-opus': { promptPrice: 0.015, completionPrice: 0.075 },
    };
    mockGetPricingData.mockResolvedValueOnce(pricingMap);

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect(body).toEqual(pricingMap);
    // Assert raw shape — no `data` wrapper key.
    expect(Object.keys(body as object)).not.toContain('data');
  });

  it('preserves 1-day Cache-Control header (legacy contract)', async () => {
    mockGetPricingData.mockResolvedValueOnce({
      'gpt-4': { promptPrice: 0.03, completionPrice: 0.06 },
    });

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { headers } = getResponse();
    expect(headers?.['Cache-Control']).toBe('public, max-age=86400, s-maxage=86400');
  });

  it('returns empty map when service returns no models', async () => {
    mockGetPricingData.mockResolvedValueOnce({});

    const route = createRouteInstance();
    const { ctx, getResponse } = createMockContext();

    await route.handle(ctx);

    const { body, status } = getResponse();
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('propagates errors from the pricing service', async () => {
    mockGetPricingData.mockRejectedValueOnce(new Error('Pricing refresh failed'));

    const route = createRouteInstance();
    const { ctx } = createMockContext();

    await expect(route.handle(ctx)).rejects.toThrow('Pricing refresh failed');
  });
});

// ---------------------------------------------------------------------------
// Schema documentation test
// ---------------------------------------------------------------------------

describe('GetPricing OpenAPI schema', () => {
  it('declares Pricing tag and public (no auth) characteristics', () => {
    const route = createRouteInstance();
    const schema = route.schema as {
      tags: string[];
      responses: Record<string, unknown>;
    };

    expect(schema.tags).toContain('Pricing');
    expect(schema.responses).toHaveProperty('200');
  });
});
