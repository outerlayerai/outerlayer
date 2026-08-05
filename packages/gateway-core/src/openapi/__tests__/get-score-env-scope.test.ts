/**
 * Regression: GET /v1/scores/:scoreId must apply the API-key-bound env scope.
 *
 * The bug class: a handler that queries ClickHouse with `WHERE TenantId =
 * {tenantId} AND Id = {scoreId} AND AppId = {appId}` and no Environment
 * filter lets a key bound to env=dev fetch any score in the app, including
 * prod-stamped rows, by id. A by-id read is easy to miss because it looks
 * already-scoped; every score route must apply `resolveEnvScope`.
 *
 * This test mocks the gateway's ClickHouse client to capture the issued
 * query + params, then exercises the handler with a key bound to a
 * non-default env, and asserts the query carries `AND Environment =
 * {envName:String}` and the matching param.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClickHouseQuery, mockResolveEnvScope } = vi.hoisted(() => ({
  mockClickHouseQuery: vi.fn(),
  mockResolveEnvScope: vi.fn(),
}));

vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn(() => ({
    query: mockClickHouseQuery,
    close: vi.fn(),
  })),
}));

vi.mock('../routes/_shared', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../routes/_shared');
  return {
    ...actual,
    resolveEnvScope: mockResolveEnvScope,
  };
});

import type { AppContext } from '../routes/_shared';
import { GetScore } from '../routes/scores';

function makeCtx() {
  let captured: { body: unknown; status: number } | undefined;
  const ctx = {
    get: (k: string) =>
      k === 'user'
        ? {
            appId: 'app-uuid-1',
            tenantId: 'tenant-uuid-1',
            apiKeyId: 'key-prod-1',
            permissions: ['score.read'],
          }
        : undefined,
    env: { CLICKHOUSE_HOST: 'http://stub', CLICKHOUSE_PASSWORD: '' },
    json: (body: unknown, status?: number) => {
      captured = { body, status: status ?? 200 };
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
    req: { method: 'GET', path: '/v1/scores/score-1' },
  } as unknown as AppContext;
  return { ctx, getCaptured: () => captured };
}

function createHandler() {
  const instance = new GetScore({
    router: {},
    raiseUnknownParameters: false,
    route: '/test',
    urlParams: [],
  } as ConstructorParameters<typeof GetScore>[0]);
  instance.getValidatedData = vi
    .fn()
    .mockResolvedValue({ params: { scoreId: '00000000-0000-0000-0000-000000000001' } });
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClickHouseQuery.mockResolvedValue({ json: () => Promise.resolve([]) });
});

describe('GetScore env scoping (regression)', () => {
  it('appends the Environment filter when the API key is bound to a non-default env', async () => {
    mockResolveEnvScope.mockResolvedValue({
      environment: { name: 'prod', isDefault: false },
    });
    const handler = createHandler();
    const { ctx } = makeCtx();
    await handler.handle(ctx);

    expect(mockClickHouseQuery).toHaveBeenCalledTimes(1);
    const callArg = mockClickHouseQuery.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(callArg.query).toMatch(/AND\s+Environment\s*=\s*\{envName:String\}/);
    expect(callArg.query_params.envName).toBe('prod');
  });

  it('expands the Environment filter to include legacy Environment="" rows for the default env', async () => {
    mockResolveEnvScope.mockResolvedValue({
      environment: { name: 'dev', isDefault: true },
    });
    const handler = createHandler();
    const { ctx } = makeCtx();
    await handler.handle(ctx);

    const callArg = mockClickHouseQuery.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    // Legacy-row branch — see buildEnvironmentWhereClause.
    expect(callArg.query).toMatch(
      /AND\s+\(Environment\s*=\s*\{envName:String\}\s+OR\s+Environment\s*=\s*''\)/,
    );
    expect(callArg.query_params.envName).toBe('dev');
  });

  it('omits the Environment filter when the caller has no env binding (bearer auth)', async () => {
    mockResolveEnvScope.mockResolvedValue(undefined);
    const handler = createHandler();
    const { ctx } = makeCtx();
    await handler.handle(ctx);

    const callArg = mockClickHouseQuery.mock.calls[0][0] as {
      query: string;
      query_params: Record<string, unknown>;
    };
    expect(callArg.query).not.toMatch(/Environment/);
    expect(callArg.query_params.envName).toBeUndefined();
  });
});
