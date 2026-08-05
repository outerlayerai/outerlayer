import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { AuditLogViewerService } from '../audit-log-viewer-service';
import {
  seedAuditLogMswState,
  seedSupabaseMswState,
  type AuditLogMswRow,
} from '@/test-helpers/msw-handlers';

const db = () => createClient('http://localhost:54321', 'test-service-role-key');

function makeRow(overrides: Partial<AuditLogMswRow> = {}): AuditLogMswRow {
  return {
    id: 'log-1',
    created_at: '2026-07-01T10:00:00Z',
    tenant_id: null,
    actor_id: 'admin-1',
    actor_type: 'human',
    actor_label: null,
    action_type: 'org_delete',
    target_type: 'tenant',
    target_id: 'tenant-9',
    target_identifier: 'Acme Corp',
    before_state: { status: 'active' },
    after_state: null,
    details: { reason: 'test' },
    ...overrides,
  };
}

describe('AuditLogViewerService', () => {
  beforeEach(() => {
    // Live actor profile, resolved via the explicit `.in()` lookup —
    // audit_log rows are frozen (no FK, no embed).
    seedSupabaseMswState({
      profiles: [{ id: 'admin-1', email: 'admin@example.com', name: 'Admin One' }],
    });
  });

  it('list() maps a human row exactly, resolving the actor profile', async () => {
    seedAuditLogMswState({ rows: [makeRow()] });
    const service = new AuditLogViewerService({ db: db() });

    const { data, error } = await service.list({ page: 1, pageSize: 25 });

    expect(error).toBeUndefined();
    expect(data).toEqual({
      items: [
        {
          id: 'log-1',
          actor_id: 'admin-1',
          actor_type: 'human',
          actor_label: null,
          actor_email: 'admin@example.com',
          actor_name: 'Admin One',
          tenant_id: null,
          action_type: 'org_delete',
          target_type: 'tenant',
          target_id: 'tenant-9',
          target_identifier: 'Acme Corp',
          created_at: '2026-07-01T10:00:00Z',
          details_preview: '{"reason":"test"}',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    });
  });

  it('list() renders machine actors without a profile lookup', async () => {
    seedAuditLogMswState({
      rows: [
        makeRow({
          id: 'log-2',
          actor_id: null,
          actor_type: 'gateway',
          actor_label: 'api-key-42',
          details: null,
        }),
      ],
    });
    const service = new AuditLogViewerService({ db: db() });

    const { data } = await service.list({ page: 1, pageSize: 25 });

    expect(data?.items).toEqual([
      expect.objectContaining({
        actor_id: null,
        actor_type: 'gateway',
        actor_label: 'api-key-42',
        actor_email: null,
        actor_name: null,
        details_preview: null,
      }),
    ]);
  });

  it('list() falls back to the denormalized actor_label when the actor profile is gone', async () => {
    // actor_id points at a profile that no longer exists (offboarded member);
    // the frozen row keeps identity via actor_label.
    seedAuditLogMswState({
      rows: [
        makeRow({
          actor_id: 'deleted-user-9',
          actor_label: 'former-admin@example.com',
        }),
      ],
    });
    const service = new AuditLogViewerService({ db: db() });

    const { data } = await service.list({ page: 1, pageSize: 25 });

    expect(data?.items[0]).toEqual(
      expect.objectContaining({
        actor_id: 'deleted-user-9',
        actor_email: null,
        actor_name: null,
        actor_label: 'former-admin@example.com',
      }),
    );
  });

  it('list() truncates long details previews to 100 characters', async () => {
    const longDetails = { padding: 'x'.repeat(200) };
    seedAuditLogMswState({ rows: [makeRow({ details: longDetails })] });
    const service = new AuditLogViewerService({ db: db() });

    const { data } = await service.list({ page: 1, pageSize: 25 });

    const preview = data?.items[0]?.details_preview ?? '';
    expect(preview).toHaveLength(100);
    expect(preview.endsWith('...')).toBe(true);
    expect(preview.startsWith('{"padding":"xxx')).toBe(true);
  });

  it('list() applies the actorId filter and paginates with an exact total', async () => {
    seedAuditLogMswState({
      rows: [
        makeRow({ id: 'log-a', actor_id: 'admin-1', created_at: '2026-07-01T10:00:00Z' }),
        makeRow({ id: 'log-b', actor_id: 'admin-1', created_at: '2026-07-02T10:00:00Z' }),
        makeRow({ id: 'log-c', actor_id: 'other-admin', created_at: '2026-07-03T10:00:00Z' }),
      ],
    });
    const service = new AuditLogViewerService({ db: db() });

    const { data } = await service.list({ actorId: 'admin-1', page: 1, pageSize: 1 });

    // Newest first, filtered to admin-1 only, one per page, total reflects the filter
    expect(data?.items.map((i) => i.id)).toEqual(['log-b']);
    expect(data?.total).toBe(2);
    expect(data?.totalPages).toBe(2);
  });

  it('getDetail() maps the full row including states', async () => {
    seedAuditLogMswState({ rows: [makeRow({ after_state: { status: 'deleted' } })] });
    const service = new AuditLogViewerService({ db: db() });

    const { data, error } = await service.getDetail('log-1');

    expect(error).toBeUndefined();
    expect(data).toEqual({
      id: 'log-1',
      actor_id: 'admin-1',
      actor_type: 'human',
      actor_label: null,
      actor_email: 'admin@example.com',
      actor_name: 'Admin One',
      tenant_id: null,
      // Context fields normalize to null when absent (consistent shape).
      ip_address: null,
      user_agent: null,
      request_id: null,
      action_type: 'org_delete',
      target_type: 'tenant',
      target_id: 'tenant-9',
      target_identifier: 'Acme Corp',
      details: { reason: 'test' },
      before_state: { status: 'active' },
      after_state: { status: 'deleted' },
      created_at: '2026-07-01T10:00:00Z',
    });
  });

  it('getDetail() returns an error for a missing entry', async () => {
    seedAuditLogMswState({ rows: [] });
    const service = new AuditLogViewerService({ db: db() });

    const { data, error } = await service.getDetail('nope');

    expect(data).toBeUndefined();
    expect(error).toBe('Audit log entry not found');
  });

  it('list() with tenantId returns ONLY that tenant, never other tenants or platform rows', async () => {
    seedAuditLogMswState({
      rows: [
        makeRow({ id: 'log-mine', tenant_id: 'tenant-a', created_at: '2026-07-01T10:00:00Z' }),
        makeRow({ id: 'log-theirs', tenant_id: 'tenant-b', created_at: '2026-07-02T10:00:00Z' }),
        makeRow({ id: 'log-platform', tenant_id: null, created_at: '2026-07-03T10:00:00Z' }),
      ],
    });
    const service = new AuditLogViewerService({ db: db() });

    const { data } = await service.list({ tenantId: 'tenant-a', page: 1, pageSize: 25 });

    expect(data?.items.map((i) => i.id)).toEqual(['log-mine']);
    expect(data?.total).toBe(1);
  });

  it('getDetail() with tenantId cannot fetch another tenant or platform entry by id', async () => {
    seedAuditLogMswState({
      rows: [
        makeRow({ id: 'log-theirs', tenant_id: 'tenant-b' }),
        makeRow({ id: 'log-platform', tenant_id: null }),
        makeRow({ id: 'log-mine', tenant_id: 'tenant-a' }),
      ],
    });
    const service = new AuditLogViewerService({ db: db() });

    const [theirs, platform, mine] = await Promise.all([
      service.getDetail('log-theirs', { tenantId: 'tenant-a' }),
      service.getDetail('log-platform', { tenantId: 'tenant-a' }),
      service.getDetail('log-mine', { tenantId: 'tenant-a' }),
    ]);

    expect(theirs).toEqual({ error: 'Audit log entry not found' });
    expect(platform).toEqual({ error: 'Audit log entry not found' });
    expect(mine.data).toEqual(expect.objectContaining({ id: 'log-mine', tenant_id: 'tenant-a' }));
  });
});
