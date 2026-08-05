/**
 * The React Server Component (RSC) read helper behind the Topics card: `trace.read` gates the read
 * before any ClickHouse work, the request-tenant + appId pin the row-policy
 * client, and the steering facet's capture-tier lookup goes through the
 * request-scoped db client (MSW-backed, real PostgREST query shape) rather
 * than an admin client. Migrated from the deleted GET route's test — same
 * branches, same assertions.
 */

vi.mock('server-only', () => ({}));

const mockCheckAppPermission = vi.fn();
vi.mock('@/utils/permission-check', () => ({
  checkAppPermission: (...args: unknown[]) => mockCheckAppPermission(...args),
}));

const mockLoadRequestServiceContext = vi.fn();
vi.mock('@/lib/adapters', () => ({
  loadRequestServiceContext: (...args: unknown[]) => mockLoadRequestServiceContext(...args),
}));

const mockCreateTenantReadClient = vi.fn();
vi.mock('@/lib/analytics/client', () => ({
  createTenantReadClient: (...args: unknown[]) => mockCreateTenantReadClient(...args),
}));

const mockListTopics = vi.fn();
const mockBuildTopicsService = vi.fn((..._args: unknown[]) => ({
  listTopics: mockListTopics,
}));
vi.mock('./service', () => ({
  buildTopicsService: (...args: unknown[]) => mockBuildTopicsService(...args),
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenError, ServiceUnavailableError } from '@repo/observability-service';
import { createMswRestClient } from '@/test-helpers/rest-client';
import { seedMembershipMswState } from '@/test-helpers/msw-handlers';
import { loadTopicsForApp } from './read';
import { Permissions } from '@/utils/permissions';

const CLIENT = { __client: true };
const TENANT_ID = 'tenant-1';
const CTX = { tenantId: TENANT_ID, actor: { userId: 'user-1' }, db: undefined as unknown };

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckAppPermission.mockResolvedValue({ error: null });
  mockLoadRequestServiceContext.mockResolvedValue({ ...CTX, db: createMswRestClient() });
  mockCreateTenantReadClient.mockReturnValue(CLIENT);
  mockListTopics.mockResolvedValue({ facet: 'task', topics: [] });
  seedMembershipMswState({ tenants: [{ tenant_id: TENANT_ID, agent_capture_tier: 'full' }] });
});

describe('loadTopicsForApp', () => {
  it('checks trace.read before touching ClickHouse, and scopes the read client to the request tenant + app', async () => {
    const result = { facet: 'issues', mapVersion: 2, topics: [{ topicId: 'v1-c0' }] };
    mockListTopics.mockResolvedValue(result);

    const out = await loadTopicsForApp('app-1', 'issues');

    expect(out).toEqual(result);
    expect(mockCheckAppPermission).toHaveBeenCalledWith(Permissions.TRACE_READ, 'app-1');
    expect(mockCreateTenantReadClient).toHaveBeenCalledWith({ tenantId: TENANT_ID, appId: 'app-1' });
    expect(mockBuildTopicsService).toHaveBeenCalledWith(CLIENT);
    expect(mockListTopics).toHaveBeenCalledWith(
      { tenantId: TENANT_ID, appId: 'app-1', environment: 'dev', environmentIsDefault: true },
      'issues',
    );
  });

  it('throws ForbiddenError without building a client when the permission check fails', async () => {
    mockCheckAppPermission.mockResolvedValue({ error: 'forbidden: trace.read' });

    await expect(loadTopicsForApp('app-1', 'task')).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockCreateTenantReadClient).not.toHaveBeenCalled();
    expect(mockListTopics).not.toHaveBeenCalled();
  });

  it('throws ServiceUnavailableError when ClickHouse is not configured', async () => {
    mockCreateTenantReadClient.mockReturnValue(null);

    await expect(loadTopicsForApp('app-1', 'task')).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(mockBuildTopicsService).not.toHaveBeenCalled();
  });

  it('merges the request-scoped capture tier onto the steering facet response', async () => {
    seedMembershipMswState({ tenants: [{ tenant_id: TENANT_ID, agent_capture_tier: 'redacted' }] });
    mockListTopics.mockResolvedValue({ facet: 'steering', mapVersion: 0, topics: [] });

    const out = await loadTopicsForApp('app-1', 'steering');

    expect(out).toEqual({ facet: 'steering', mapVersion: 0, topics: [], captureTier: 'redacted' });
  });

  it('falls back to full tier when the tenant row is missing', async () => {
    // No row for this tenant — the real PostgREST 406/PGRST116 shape
    // `.maybeSingle()` maps to `{ data: null, error: null }`.
    seedMembershipMswState({ tenants: [] });
    mockListTopics.mockResolvedValue({ facet: 'steering', mapVersion: 0, topics: [] });

    const out = await loadTopicsForApp('app-1', 'steering');

    expect(out).toMatchObject({ captureTier: 'full' });
  });

  it('does not surface a captureTier field for non-steering facets', async () => {
    const result = { facet: 'task', mapVersion: 3, topics: [] };
    mockListTopics.mockResolvedValue(result);

    const out = await loadTopicsForApp('app-1', 'task');

    expect(out).toEqual(result);
    expect(out).not.toHaveProperty('captureTier');
  });
});
