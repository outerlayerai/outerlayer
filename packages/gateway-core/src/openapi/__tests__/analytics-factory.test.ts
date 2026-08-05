/**
 * Analytics factory tests.
 *
 * The factory owns two security-relevant behaviors:
 *
 *   1. IDENTITY — with CLICKHOUSE_READ_USER set, the shared base client
 *      authenticates as the row-policy'd reader; without it, it falls back to
 *      the writer identity and warns once per isolate.
 *   2. SCOPE — every AnalyticsService it hands out is pinned to the request's
 *      {tenantId, appId}: each query carries SQL_tenant_id / SQL_app_id, and
 *      per-call clickhouse_settings can never override them.
 *
 * Plus the singleton mechanics: ONE base HTTP client per isolate, cheap
 * per-request service facades, reset for tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture every client the web SDK would construct, plus its query calls.
const { createdClients } = vi.hoisted(() => ({
  createdClients: [] as Array<{ config: Record<string, unknown>; query: ReturnType<typeof vi.fn> }>,
}));

vi.mock('@clickhouse/client-web', () => ({
  createClient: vi.fn((config: Record<string, unknown>) => {
    const client = {
      config,
      query: vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) }),
    };
    createdClients.push(client);
    return client;
  }),
}));

// Keep the REAL withReadScope (it is part of the behavior under test); stub
// only the service facade so tests can reach the scoped client it wraps.
vi.mock('@repo/observability-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@repo/observability-service')>();
  return {
    ...actual,
    createAnalyticsService: vi.fn((client: any) => ({
      _client: client,
      _isAnalyticsService: true,
    })),
  };
});

// Import after mocks
import {
  getGatewayAnalyticsService,
  resetGatewayAnalyticsService,
} from '../analytics-factory';

const SCOPE = { tenantId: 'tenant-1', appId: 'app-1' };

beforeEach(() => {
  resetGatewayAnalyticsService();
  vi.clearAllMocks();
  createdClients.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getGatewayAnalyticsService', () => {
  it('returns null when CLICKHOUSE_HOST is undefined', () => {
    expect(getGatewayAnalyticsService({ CLICKHOUSE_HOST: undefined }, SCOPE)).toBeNull();
    expect(getGatewayAnalyticsService({}, SCOPE)).toBeNull();
  });

  it('returns an AnalyticsService when CLICKHOUSE_HOST is set', () => {
    const result = getGatewayAnalyticsService({ CLICKHOUSE_HOST: 'http://localhost:8123' }, SCOPE);
    expect((result as any)._isAnalyticsService).toBe(true);
  });

  it('creates ONE base client per isolate; each call hands out a fresh scoped facade over it', () => {
    const env = { CLICKHOUSE_HOST: 'http://localhost:8123' };
    const first = getGatewayAnalyticsService(env, SCOPE);
    const second = getGatewayAnalyticsService(env, { tenantId: 'tenant-2' });
    // Facades are per-request objects…
    expect(first).not.toBe(second);
    // …but the underlying HTTP client is constructed exactly once.
    expect(createdClients).toHaveLength(1);
  });

  it('constructs a fresh base client after resetGatewayAnalyticsService', () => {
    const env = { CLICKHOUSE_HOST: 'http://localhost:8123' };
    getGatewayAnalyticsService(env, SCOPE);
    resetGatewayAnalyticsService();
    getGatewayAnalyticsService(env, SCOPE);
    expect(createdClients).toHaveLength(2);
  });

  it('authenticates as the READ user when CLICKHOUSE_READ_USER is set', () => {
    getGatewayAnalyticsService(
      {
        CLICKHOUSE_HOST: 'http://localhost:8123',
        CLICKHOUSE_PASSWORD: 'writer-secret',
        CLICKHOUSE_READ_USER: 'analytics_reader',
        CLICKHOUSE_READ_PASSWORD: 'reader-secret',
      },
      SCOPE,
    );
    expect(createdClients[0]!.config).toEqual({
      url: 'http://localhost:8123',
      username: 'analytics_reader',
      password: 'reader-secret',
    });
  });

  it('falls back to the writer identity WITHOUT a username when READ_USER is unset — and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'writer-secret' };
    getGatewayAnalyticsService(env, SCOPE);
    getGatewayAnalyticsService(env, SCOPE);
    expect(createdClients[0]!.config).toEqual({
      url: 'http://localhost:8123',
      password: 'writer-secret',
    });
    const policyWarnings = warn.mock.calls.filter(([m]) =>
      String(m).includes('CLICKHOUSE_READ_USER unset'),
    );
    expect(policyWarnings).toHaveLength(1);
  });

  it('pins every query to the scope settings — a per-call override cannot strip or spoof them', async () => {
    const service = getGatewayAnalyticsService(
      { CLICKHOUSE_HOST: 'http://localhost:8123' },
      SCOPE,
    ) as any;

    await service._client.query({
      query: 'SELECT 1',
      clickhouse_settings: { SQL_tenant_id: 'tenant-EVIL', max_execution_time: 5 },
    });

    expect(createdClients[0]!.query).toHaveBeenCalledWith(
      expect.objectContaining({
        clickhouse_settings: {
          max_execution_time: 5,
          SQL_tenant_id: 'tenant-1',
          SQL_app_id: 'app-1',
        },
      }),
    );
  });

  it('omits SQL_app_id for a tenant-only scope (app-less reads must not send a bogus app)', async () => {
    const service = getGatewayAnalyticsService(
      { CLICKHOUSE_HOST: 'http://localhost:8123' },
      { tenantId: 'tenant-9' },
    ) as any;

    await service._client.query({ query: 'SELECT 1' });

    expect(createdClients[0]!.query).toHaveBeenCalledWith(
      expect.objectContaining({ clickhouse_settings: { SQL_tenant_id: 'tenant-9' } }),
    );
  });
});

describe('getService (from _shared.ts)', () => {
  const userCtx = (env: Record<string, unknown>) =>
    ({
      env,
      get: vi.fn((key: string) =>
        key === 'user' ? { tenantId: 'tenant-ctx', appId: 'app-ctx' } : undefined,
      ),
    }) as any;

  it('throws ServiceUnavailableError when CLICKHOUSE_HOST is not configured', async () => {
    const { getService } = await import('../routes/_shared');
    const { ServiceUnavailableError } = await import('@repo/observability-service');

    expect(() => getService(userCtx({}))).toThrow(ServiceUnavailableError);
    expect(() => getService(userCtx({}))).toThrow('ClickHouse host not configured');
  });

  it("scopes the service to the AUTH CONTEXT's tenant + app — not request input", async () => {
    const { getService } = await import('../routes/_shared');

    const service = getService(userCtx({ CLICKHOUSE_HOST: 'http://localhost:8123' })) as any;
    await service._client.query({ query: 'SELECT 1' });

    expect(createdClients[0]!.query).toHaveBeenCalledWith(
      expect.objectContaining({
        clickhouse_settings: { SQL_tenant_id: 'tenant-ctx', SQL_app_id: 'app-ctx' },
      }),
    );
  });
});

describe('production fail-closed', () => {
  const PROD_HOST = { CLICKHOUSE_HOST: 'http://localhost:8123', CLICKHOUSE_PASSWORD: 'writer-secret' };

  it('throws rather than downgrading to the writer identity when NODE_ENV is production', () => {
    expect(() =>
      getGatewayAnalyticsService({ ...PROD_HOST, NODE_ENV: 'production' }, SCOPE),
    ).toThrow(/CLICKHOUSE_READ_USER is not set/);
    // No client constructed means no un-policed read can happen.
    expect(createdClients).toEqual([]);
  });

  it('constructs the reader client in production once the read user is set', () => {
    getGatewayAnalyticsService(
      {
        ...PROD_HOST,
        NODE_ENV: 'production',
        CLICKHOUSE_READ_USER: 'analytics_reader',
        CLICKHOUSE_READ_PASSWORD: 'reader-secret',
      },
      SCOPE,
    );
    expect(createdClients[0]!.config).toEqual({
      url: 'http://localhost:8123',
      username: 'analytics_reader',
      password: 'reader-secret',
    });
  });

  it('lets a self-host opt out explicitly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getGatewayAnalyticsService(
      { ...PROD_HOST, NODE_ENV: 'production', CLICKHOUSE_ALLOW_UNSCOPED_READS: 'true' },
      SCOPE,
    );
    expect(createdClients[0]!.config).toEqual({
      url: 'http://localhost:8123',
      password: 'writer-secret',
    });
    warn.mockRestore();
  });

  it('does not treat a non-boolean opt-out value as consent', () => {
    expect(() =>
      getGatewayAnalyticsService(
        { ...PROD_HOST, NODE_ENV: 'production', CLICKHOUSE_ALLOW_UNSCOPED_READS: 'sure' },
        SCOPE,
      ),
    ).toThrow(/CLICKHOUSE_READ_USER is not set/);
    expect(createdClients).toEqual([]);
  });

  // A throw fails the test by itself, so assert the identity that got built
  // rather than merely that nothing was raised.
  it('still falls back to the writer identity outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getGatewayAnalyticsService({ ...PROD_HOST, NODE_ENV: 'development' }, SCOPE);

    expect(createdClients[0]!.config).toEqual({
      url: 'http://localhost:8123',
      password: 'writer-secret',
    });
    warn.mockRestore();
  });
});
