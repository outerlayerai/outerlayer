import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';

// Override the global next/headers stub with a per-test controllable get().
// cookies() must keep delegating to the shared test cookie store: supabase-ssr
// clients read it asynchronously, and a bare stub turns into unhandled
// rejections after the suite finishes.
const mockHeadersGet = vi.fn();
vi.mock('next/headers', async () => {
  const { getSupabaseTestCookieStore } = await import('@/test-helpers/supabase-session');
  return {
    headers: () => Promise.resolve({ get: mockHeadersGet }),
    cookies: () => getSupabaseTestCookieStore(),
  };
});
import { AuditLogService } from '../audit-log-service';
import {
  seedAuditLogMswState,
  getInsertedAuditLogRows,
} from '@/test-helpers/msw-handlers';

const db = () => createClient('http://localhost:54321', 'test-service-role-key');

describe('AuditLogService', () => {
  // proves AC-073-01
  it('inserts a tenant-scoped human row exactly as given', async () => {
    const service = new AuditLogService({ db: db() });

    await service.create({
      tenantId: 'tenant-1',
      actorId: 'actor-1',
      actionType: 'member_role_changed',
      targetType: 'membership',
      targetId: 'membership-1',
      targetIdentifier: 'member@example.com',
      beforeState: { role: 'read', custom_role_id: null },
      afterState: { role: 'admin', custom_role_id: null },
      details: { via: 'test' },
    });

    expect(getInsertedAuditLogRows()).toEqual([
      {
        tenant_id: 'tenant-1',
        actor_id: 'actor-1',
        actor_type: 'human',
        actor_label: null,
        action_type: 'member_role_changed',
        target_type: 'membership',
        target_id: 'membership-1',
        target_identifier: 'member@example.com',
        before_state: { role: 'read', custom_role_id: null },
        after_state: { role: 'admin', custom_role_id: null },
        details: { via: 'test' },
        ip_address: null,
        user_agent: null,
        request_id: null,
      },
    ]);
  });

  it('defaults to a human, platform-scoped event (existing platform callers)', async () => {
    const service = new AuditLogService({ db: db() });

    await service.create({
      actorId: 'platform-admin-1',
      actionType: 'org_delete',
      targetType: 'tenant',
      targetId: 'tenant-9',
      targetIdentifier: 'Acme Corp',
    });

    expect(getInsertedAuditLogRows()).toEqual([
      {
        tenant_id: null,
        actor_id: 'platform-admin-1',
        actor_type: 'human',
        actor_label: null,
        action_type: 'org_delete',
        target_type: 'tenant',
        target_id: 'tenant-9',
        target_identifier: 'Acme Corp',
        before_state: null,
        after_state: null,
        details: null,
        ip_address: null,
        user_agent: null,
        request_id: null,
      },
    ]);
  });

  it('records a machine actor with no profile', async () => {
    const service = new AuditLogService({ db: db() });

    await service.create({
      tenantId: 'tenant-1',
      actorType: 'gateway',
      actorLabel: 'api-key-123',
      actionType: 'app_role_assigned',
      targetType: 'app_member_role',
    });

    expect(getInsertedAuditLogRows()).toEqual([
      {
        tenant_id: 'tenant-1',
        actor_id: null,
        actor_type: 'gateway',
        actor_label: 'api-key-123',
        action_type: 'app_role_assigned',
        target_type: 'app_member_role',
        target_id: null,
        target_identifier: null,
        before_state: null,
        after_state: null,
        details: null,
        ip_address: null,
        user_agent: null,
        request_id: null,
      },
    ]);
  });

  it('swallows insert failures instead of throwing', async () => {
    seedAuditLogMswState({ forceInsertError: { message: 'db down' } });
    const service = new AuditLogService({ db: db() });

    await expect(
      service.create({
        actorId: 'actor-1',
        actionType: 'member_removed',
        targetType: 'membership',
      }),
    ).resolves.toBeUndefined();

    expect(getInsertedAuditLogRows()).toEqual([]);
  });

  it('swallows thrown transport errors instead of throwing', async () => {
    // A client whose insert throws synchronously (e.g. network layer failure)
    const throwingDb = {
      from: () => ({
        insert: () => {
          throw new Error('socket hang up');
        },
      }),
    } as never;

    const service = new AuditLogService({ db: throwingDb });

    await expect(
      service.create({
        actorId: 'actor-1',
        actionType: 'member_removed',
        targetType: 'membership',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AuditLogService request context', () => {
  beforeEach(() => {
    mockHeadersGet.mockReset();
  });

  it('passes explicit request context through to the row', async () => {
    const service = new AuditLogService({ db: db() });

    await service.create({
      actorId: 'actor-1',
      actionType: 'member_removed',
      targetType: 'membership',
      ipAddress: '203.0.113.9',
      userAgent: 'test-agent/1.0',
      requestId: 'req-42',
    });

    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        ip_address: '203.0.113.9',
        user_agent: 'test-agent/1.0',
        request_id: 'req-42',
      }),
    ]);
  });

  it('captures context from the request headers when not given explicitly', async () => {
    mockHeadersGet.mockImplementation(
      (key: string) =>
        ({
          'x-forwarded-for': '198.51.100.4, 10.0.0.1',
          'user-agent': 'Mozilla/5.0 (test)',
          'x-vercel-id': 'iad1::abc123',
        })[key] ?? null,
    );

    const service = new AuditLogService({ db: db() });
    await service.create({ actorId: 'actor-1', actionType: 'member_removed', targetType: 'membership' });

    // First value of x-forwarded-for wins; vercel id is preferred as request id
    expect(getInsertedAuditLogRows()).toEqual([
      expect.objectContaining({
        ip_address: '198.51.100.4',
        user_agent: 'Mozilla/5.0 (test)',
        request_id: 'iad1::abc123',
      }),
    ]);
  });
});
