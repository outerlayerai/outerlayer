// @vitest-environment jsdom
/**
 * <AuditLogDetailDialog> — the shared entry detail (platform-admin + tenant).
 * Pins the forensic renderings: actor identity fallback, local + explicit UTC
 * timestamps, request context (IP · user agent · request id), and the
 * before/after state blocks.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuditLogDetailDialog } from '../audit-log-detail-dialog';
import type { AuditLogDetail } from '../../../types/platform-admin';

function makeDetail(overrides: Partial<AuditLogDetail> = {}): AuditLogDetail {
  return {
    id: 'log-1',
    actor_id: 'user-1',
    actor_type: 'human',
    actor_label: 'admin@acme.co',
    actor_email: 'admin@acme.co',
    actor_name: 'Admin One',
    tenant_id: 'tenant-1',
    ip_address: '203.0.113.9',
    user_agent: 'HeadlessChrome/150',
    request_id: 'req-9',
    action_type: 'member_role_changed',
    target_type: 'membership',
    target_id: 'mem-1',
    target_identifier: 'member@acme.co',
    details: { scope: 'tenant' },
    before_state: { role: 'read' },
    after_state: { role: 'admin' },
    created_at: '2026-07-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('AuditLogDetailDialog', () => {
  it('renders the full forensic record: actor, target, UTC time, request, states', async () => {
    const fetchDetail = vi.fn().mockResolvedValue({ data: makeDetail() });

    render(
      <AuditLogDetailDialog logId="log-1" open onClose={vi.fn()} fetchDetail={fetchDetail} />
    );

    expect(await screen.findByText('admin@acme.co')).toBeInTheDocument();
    expect(fetchDetail).toHaveBeenCalledWith('log-1');
    expect(screen.getByText('Member Role Changed')).toBeInTheDocument();
    expect(screen.getByText('member@acme.co')).toBeInTheDocument();
    // Explicit UTC line alongside the localized timestamp.
    expect(screen.getByText('2026-07-09T10:00:00.000Z (UTC)')).toBeInTheDocument();
    // Request context: IP on top, UA · request id beneath.
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    expect(screen.getByText('HeadlessChrome/150 · req-9')).toBeInTheDocument();
    // Before/after diff blocks.
    expect(screen.getByText('Before State')).toBeInTheDocument();
    expect(screen.getByText(/"role": "read"/)).toBeInTheDocument();
    expect(screen.getByText('After State')).toBeInTheDocument();
    expect(screen.getByText(/"role": "admin"/)).toBeInTheDocument();
    expect(screen.getByText(/"scope": "tenant"/)).toBeInTheDocument();
  });

  it('omits the request row when no context was captured and shows the error state', async () => {
    const noContext = vi.fn().mockResolvedValue({
      data: makeDetail({
        ip_address: null,
        user_agent: null,
        request_id: null,
        details: null,
        before_state: null,
        after_state: null,
      }),
    });
    const { unmount } = render(
      <AuditLogDetailDialog logId="log-1" open onClose={vi.fn()} fetchDetail={noContext} />
    );
    await screen.findByText('admin@acme.co');
    expect(screen.queryByText('Request')).toBeNull();
    expect(screen.queryByText('Before State')).toBeNull();
    unmount();

    const failing = vi.fn().mockResolvedValue({ error: 'Audit log entry not found' });
    render(
      <AuditLogDetailDialog logId="log-x" open onClose={vi.fn()} fetchDetail={failing} />
    );
    expect(await screen.findByText('Audit log entry not found')).toBeInTheDocument();
  });

  it('does not fetch while closed or without an id', () => {
    const fetchDetail = vi.fn();
    const { rerender } = render(
      <AuditLogDetailDialog logId={null} open onClose={vi.fn()} fetchDetail={fetchDetail} />
    );
    rerender(
      <AuditLogDetailDialog logId="log-1" open={false} onClose={vi.fn()} fetchDetail={fetchDetail} />
    );
    expect(fetchDetail).not.toHaveBeenCalled();
  });
});
