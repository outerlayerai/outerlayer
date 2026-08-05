/**
 * getAnalyticsService — the per-request analytics factory.
 *
 * Pins the tenant-read contract: a tenant-scoped analytics service is built
 * over the row-policy read client (`createTenantReadClient`) scoped to the
 * caller's verified tenant AND app — never the writer-identity singleton, which
 * has no ClickHouse policy backstop. When ClickHouse is unconfigured it degrades
 * to the mock rather than constructing a scoped read client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnalyticsService } from '@repo/observability-service';
import type { TenantContext, VerifiedAppId } from '@repo/observability-service';

const mockCreateTenantReadClient = vi.fn();

vi.mock('../client', () => ({
  createTenantReadClient: (...args: unknown[]) => mockCreateTenantReadClient(...args),
}));

import { getAnalyticsService } from '../service';
import { MockAnalyticsService } from '../mock-service';

const CTX: TenantContext = Object.freeze({
  userId: 'user-1',
  tenantId: 'tenant-abc',
  appId: 'app-xyz' as VerifiedAppId,
  dataRetentionDays: -1,
});

const ORIGINAL_HOST = process.env.CLICKHOUSE_HOST;
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VERCEL_ENV;
  process.env.CLICKHOUSE_HOST = 'http://ch.test:8123';
  mockCreateTenantReadClient.mockReturnValue({ query: vi.fn(), close: vi.fn() });
});

afterEach(() => {
  if (ORIGINAL_HOST === undefined) delete process.env.CLICKHOUSE_HOST;
  else process.env.CLICKHOUSE_HOST = ORIGINAL_HOST;
  if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
});

describe('getAnalyticsService', () => {
  it('builds the read client scoped to the request tenant AND app', () => {
    const service = getAnalyticsService(CTX);

    expect(mockCreateTenantReadClient).toHaveBeenCalledTimes(1);
    expect(mockCreateTenantReadClient).toHaveBeenCalledWith({
      tenantId: 'tenant-abc',
      appId: 'app-xyz',
    });
    // A real AnalyticsService over the scoped client — NOT the writer-identity
    // mock. Every read it issues therefore carries the tenant's row-policy scope.
    expect(service).toBeInstanceOf(AnalyticsService);
  });

  it('returns a fresh service per call (no shared singleton across requests)', () => {
    const other: TenantContext = Object.freeze({
      ...CTX,
      tenantId: 'tenant-def',
      appId: 'app-other' as VerifiedAppId,
    });

    getAnalyticsService(CTX);
    getAnalyticsService(other);

    expect(mockCreateTenantReadClient).toHaveBeenNthCalledWith(1, {
      tenantId: 'tenant-abc',
      appId: 'app-xyz',
    });
    expect(mockCreateTenantReadClient).toHaveBeenNthCalledWith(2, {
      tenantId: 'tenant-def',
      appId: 'app-other',
    });
  });

  it('degrades to the mock service without a read client when ClickHouse is unconfigured', () => {
    delete process.env.CLICKHOUSE_HOST;

    const service = getAnalyticsService(CTX);

    expect(service).toBeInstanceOf(MockAnalyticsService);
    expect(mockCreateTenantReadClient).not.toHaveBeenCalled();
  });

  it('degrades to the mock service when the scoped read client cannot be built (host set, client null)', () => {
    // CLICKHOUSE_HOST is set, but createTenantReadClient returns null — degrade
    // to the mock rather than construct an AnalyticsService over a null client.
    mockCreateTenantReadClient.mockReturnValue(null);

    const service = getAnalyticsService(CTX);

    expect(service).toBeInstanceOf(MockAnalyticsService);
    expect(mockCreateTenantReadClient).toHaveBeenCalledWith({
      tenantId: 'tenant-abc',
      appId: 'app-xyz',
    });
  });

  it('uses the mock service on Vercel preview deployments (ClickHouse not provisioned)', () => {
    process.env.VERCEL_ENV = 'preview';

    const service = getAnalyticsService(CTX);

    expect(service).toBeInstanceOf(MockAnalyticsService);
    expect(mockCreateTenantReadClient).not.toHaveBeenCalled();
  });
});
