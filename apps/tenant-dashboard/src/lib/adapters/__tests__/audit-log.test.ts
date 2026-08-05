/**
 * The audit-log adapter — the narrow crossing new-world code uses to reach
 * the legacy `AuditLogViewerService`. `AuditLogViewerService` has its own
 * suite covering the query/pagination rules; this test pins that the adapter
 * constructs it with the tenant-scoped admin db client (not an empty deps
 * object — reads would then hit an unconfigured client) and forwards each
 * export's params/return value unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { list, getDetail, listForExport, auditLogViewerServiceCtor } = vi.hoisted(() => ({
  list: vi.fn(),
  getDetail: vi.fn(),
  listForExport: vi.fn(),
  auditLogViewerServiceCtor: vi.fn(),
}));

vi.mock('@/lib/system/audit-log/audit-log-viewer-service', () => ({
  AuditLogViewerService: class {
    list = list;
    getDetail = getDetail;
    listForExport = listForExport;
    constructor(...args: unknown[]) {
      auditLogViewerServiceCtor(...args);
    }
  },
}));

vi.mock('@/lib/system/audit-log/audit-log-csv', () => ({
  auditLogRowsToCsv: vi.fn(),
}));

import { listAuditLogEntries, getAuditLogEntryDetail, listAuditLogEntriesForExport } from '../audit-log';

beforeEach(() => {
  list.mockReset();
  getDetail.mockReset();
  listForExport.mockReset();
  auditLogViewerServiceCtor.mockReset();
});

/** Not `{}` — the adapter must hand the service a real db client, not an
 *  empty deps object (which would make every read on it throw). */
function expectConstructedWithDb() {
  expect(auditLogViewerServiceCtor).toHaveBeenCalledTimes(1);
  const deps = auditLogViewerServiceCtor.mock.calls[0]![0] as { db?: unknown };
  expect(Object.keys(deps)).toEqual(['db']);
}

describe('listAuditLogEntries', () => {
  it('constructs the service with the tenant-scoped admin db client and forwards params/result unchanged', async () => {
    const params = { tenantId: 'tenant-1', page: 2 } as Parameters<typeof listAuditLogEntries>[0];
    const serviceResult = { data: { items: [], total: 0 } } as unknown as Awaited<ReturnType<typeof listAuditLogEntries>>;
    list.mockResolvedValue(serviceResult);

    const result = await listAuditLogEntries(params);

    expectConstructedWithDb();
    expect(list).toHaveBeenCalledWith(params);
    expect(result).toBe(serviceResult);
  });
});

describe('getAuditLogEntryDetail', () => {
  it('constructs the service with the admin db client and forwards logId/opts', async () => {
    const serviceResult = { data: { id: 'log-1' } } as Awaited<ReturnType<typeof getAuditLogEntryDetail>>;
    getDetail.mockResolvedValue(serviceResult);

    const result = await getAuditLogEntryDetail('log-1', { tenantId: 'tenant-1' });

    expectConstructedWithDb();
    expect(getDetail).toHaveBeenCalledWith('log-1', { tenantId: 'tenant-1' });
    expect(result).toBe(serviceResult);
  });

  it('defaults opts to {} when omitted', async () => {
    getDetail.mockResolvedValue({});

    await getAuditLogEntryDetail('log-1');

    expect(getDetail).toHaveBeenCalledWith('log-1', {});
  });
});

describe('listAuditLogEntriesForExport', () => {
  it('constructs the service with the admin db client and forwards tenantId/result', async () => {
    const serviceResult = { data: [] } as Awaited<ReturnType<typeof listAuditLogEntriesForExport>>;
    listForExport.mockResolvedValue(serviceResult);

    const result = await listAuditLogEntriesForExport('tenant-1');

    expectConstructedWithDb();
    expect(listForExport).toHaveBeenCalledWith('tenant-1');
    expect(result).toBe(serviceResult);
  });
});
