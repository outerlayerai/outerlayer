/**
 * `DELETE /v1/environments/:id` must scope to the caller's app, the way its
 * sibling `GET` does.
 *
 * The shared service's only ownership predicate is `env.tenant_id !== tenantId`,
 * and under api-key auth the client is the `gateway` Postgres role whose
 * environment DELETE policy is likewise tenant-wide — so the route's own check
 * is the only thing keeping the delete inside one app. The delete is
 * unrecoverable: the row is hard-deleted, `api_key.environment_id ON DELETE
 * CASCADE` revokes every key bound to it, and the Fly app is destroyed.
 *
 * The confirmation name is not a substitute: apps within one tenant may freely
 * reuse `staging` / `prod`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetEnvironment, mockDeleteEnvironment } = vi.hoisted(() => ({
  mockGetEnvironment: vi.fn(),
  mockDeleteEnvironment: vi.fn(),
}));

vi.mock('@repo/environments-service', () => ({
  EnvironmentService: vi.fn().mockImplementation(function () {
    return {
      getEnvironment: mockGetEnvironment,
      deleteEnvironment: mockDeleteEnvironment,
    };
  }),
  FlyHttpClient: vi.fn(),
  LocalDockerFlyClient: vi.fn(),
  validateEnvironmentName: vi.fn(() => ({ valid: true })),
}));

vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return {
    ...actual,
    getScopedSupabase: vi.fn(() => Promise.resolve({})),
  };
});

import type { AppContext } from '../routes/_shared';
import { DeleteEnvironment } from '../routes/environments';

interface CapturedResponse {
  body: unknown;
  status: number;
}

function makeContext(): { ctx: AppContext; captured: () => CapturedResponse } {
  let captured: CapturedResponse = { body: undefined, status: 200 };
  const ctx = {
    get: vi.fn((k: string) =>
      k === 'user' ? { appId: 'app-uuid-1', tenantId: 'tenant-uuid-1' } : undefined,
    ),
    env: {
      FLY_API_TOKEN: 'fly-token',
    },
    json: vi.fn((body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    }),
    req: { method: 'DELETE', path: '/v1/environments/env-uuid-1' },
  } as unknown as AppContext;
  return { ctx, captured: () => captured };
}

function createRoute(validatedData: Record<string, unknown>): DeleteEnvironment {
  const instance = new DeleteEnvironment({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  } as ConstructorParameters<typeof DeleteEnvironment>[0]);
  instance.getValidatedData = vi.fn().mockResolvedValue(validatedData);
  return instance;
}

const VALID_DATA = {
  params: { id: 'env-uuid-1' },
  body: { confirmation_name: 'staging' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteEnvironment.mockResolvedValue({ ok: true, data: { cascade: {} } });
});

describe('DeleteEnvironment app scoping', () => {
  it('404s and does NOT delete when the environment belongs to another app', async () => {
    // Same tenant — so the service's own tenant predicate would have passed it.
    mockGetEnvironment.mockResolvedValue({
      id: 'env-uuid-1',
      tenant_id: 'tenant-uuid-1',
      app_id: 'app-uuid-OTHER',
      name: 'staging',
    });

    const { ctx, captured } = makeContext();
    await createRoute(VALID_DATA).handle(ctx);

    expect(captured().status).toBe(404);
    // The property that matters: the destructive call never happens.
    expect(mockDeleteEnvironment).not.toHaveBeenCalled();
  });

  it('404s and does NOT delete when the environment does not exist', async () => {
    mockGetEnvironment.mockResolvedValue(null);

    const { ctx, captured } = makeContext();
    await createRoute(VALID_DATA).handle(ctx);

    expect(captured().status).toBe(404);
    expect(mockDeleteEnvironment).not.toHaveBeenCalled();
  });

  it('proceeds for the caller’s own app', async () => {
    mockGetEnvironment.mockResolvedValue({
      id: 'env-uuid-1',
      tenant_id: 'tenant-uuid-1',
      app_id: 'app-uuid-1',
      name: 'staging',
    });

    const { ctx } = makeContext();
    await createRoute(VALID_DATA).handle(ctx);

    expect(mockDeleteEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-uuid-1',
        envId: 'env-uuid-1',
        confirmationName: 'staging',
      }),
    );
  });

  it('checks ownership BEFORE the confirmation name is consulted', async () => {
    // A matching confirmation name must not be able to stand in for app scope —
    // two apps in one tenant may both have a `staging`.
    mockGetEnvironment.mockResolvedValue({
      id: 'env-uuid-1',
      tenant_id: 'tenant-uuid-1',
      app_id: 'app-uuid-OTHER',
      name: 'staging',
    });

    const { ctx, captured } = makeContext();
    await createRoute({
      params: { id: 'env-uuid-1' },
      body: { confirmation_name: 'staging' },
    }).handle(ctx);

    expect(captured().status).toBe(404);
    expect(mockDeleteEnvironment).not.toHaveBeenCalled();
  });
});
