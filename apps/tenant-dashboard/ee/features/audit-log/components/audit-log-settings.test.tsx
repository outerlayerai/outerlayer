// @vitest-environment jsdom
/**
 * <AuditLogSettings> — the tenant Settings -> Audit log section. Wires the
 * shared table/dialog to the tenant-scoped `ee/features/audit-log` actions
 * (unwrapping the `authorizedAction` result shape at this boundary) and owns
 * the CSV export flow: action call -> Blob download named by the action, and
 * the inline error when the export is refused (e.g. entitlement or denial).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const actions = vi.hoisted(() => ({
  listAuditLogAction: vi.fn(),
  getAuditLogDetailAction: vi.fn(),
  exportAuditLogAction: vi.fn(),
}));
// Server actions are a true seam: the module boundary is ours; transport
// belongs to the actions' own tests.
vi.mock('../actions', () => actions);

import AuditLogSettings from './audit-log-settings';

const emptyPage = { data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 } };

describe('AuditLogSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.listAuditLogAction.mockResolvedValue({ ok: true, data: emptyPage });
  });

  it('downloads the export as the CSV blob the action returns', async () => {
    actions.exportAuditLogAction.mockResolvedValue({
      ok: true,
      data: { data: { csv: 'timestamp_utc,action\r\n', filename: 'audit-log-2026-07-09.csv' } },
    });
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:audit');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<AuditLogSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(actions.exportAuditLogAction).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('text/csv;charset=utf-8');
    expect(await blob.text()).toBe('timestamp_utc,action\r\n');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:audit');

    vi.unstubAllGlobals();
    click.mockRestore();
  });

  it('shows the refusal inline when the export is denied by entitlement', async () => {
    actions.exportAuditLogAction.mockResolvedValue({
      ok: true,
      data: { error: 'The audit log requires an Enterprise plan' },
    });

    render(<AuditLogSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    expect(
      await screen.findByText('The audit log requires an Enterprise plan')
    ).toBeInTheDocument();
  });

  it('shows the refusal inline when the export action itself is forbidden', async () => {
    actions.exportAuditLogAction.mockResolvedValue({
      ok: false,
      error: { code: 'forbidden', message: 'Permission denied: audit_log.read' },
    });

    render(<AuditLogSettings />);
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    expect(await screen.findByText('Permission denied: audit_log.read')).toBeInTheDocument();
  });

  it('opens the detail dialog for a clicked row through the tenant detail action', async () => {
    actions.listAuditLogAction.mockResolvedValue({
      ok: true,
      data: {
        data: {
          items: [
            {
              id: 'log-7',
              actor_id: 'u1',
              actor_type: 'human',
              actor_label: null,
              actor_email: 'admin@acme.co',
              actor_name: null,
              tenant_id: 't1',
              action_type: 'member_role_changed',
              target_type: 'membership',
              target_id: null,
              target_identifier: 'member@acme.co',
              created_at: '2026-07-09T10:00:00.000Z',
              details_preview: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        },
      },
    });
    actions.getAuditLogDetailAction.mockResolvedValue({
      ok: true,
      data: { error: 'Audit log entry not found' },
    });

    render(<AuditLogSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));

    await waitFor(() =>
      expect(actions.getAuditLogDetailAction).toHaveBeenCalledWith({ logId: 'log-7' })
    );
  });

  it('renders RSC-seeded initial data without an initial client fetch', async () => {
    render(
      <AuditLogSettings
        initialData={{
          items: [
            {
              id: 'log-seed',
              actor_id: 'u1',
              actor_type: 'human',
              actor_label: null,
              actor_email: 'seed@acme.co',
              actor_name: null,
              tenant_id: 't1',
              action_type: 'member_role_changed',
              target_type: 'membership',
              target_id: null,
              target_identifier: 'member@acme.co',
              created_at: '2026-07-09T10:00:00.000Z',
              details_preview: null,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        }}
      />
    );

    expect(await screen.findByText('seed@acme.co')).toBeInTheDocument();
    expect(actions.listAuditLogAction).not.toHaveBeenCalled();
  });

  it('renders the RSC permission-denied seed without an initial client fetch', async () => {
    render(<AuditLogSettings initialError="You don't have permission to view the audit log" />);

    expect(
      await screen.findByText("You don't have permission to view the audit log")
    ).toBeInTheDocument();
    expect(actions.listAuditLogAction).not.toHaveBeenCalled();
  });
});
